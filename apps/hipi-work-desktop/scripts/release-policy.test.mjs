import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import builder from "../packaging/electron-builder.cjs";
import { assertMaintenanceBundle } from "./maintenance-bundle.mjs";
import {
	allowedPayload,
	assertBrandIcon,
	assertPackagingInputs,
	assertPublicText,
	assertSourceSnapshot,
	filesUnder,
	inventory,
	requiredFiles,
	requireFiles,
	sourceSnapshot,
} from "./release-policy.mjs";

test("allowlist includes parser and PDF notices, excludes all unreviewed payloads", () => {
	for (const file of requiredFiles) assert.equal(allowedPayload(file), true);
	assert.equal(allowedPayload("dist/renderer/assets/pdf.worker-123.js"), true);
	for (const file of [
		".env",
		"credentials.json",
		"user.sqlite",
		"dist/runtime.mjs.map",
		"dist/preview-parser.meta.json",
		"src/main.ts",
		"dist/renderer/private.json",
		"dist/renderer/assets/../../secret.js",
		"dist/branding/private.png",
		"dist/branding/icon.svg",
	]) {
		assert.equal(allowedPayload(file), false, file);
	}
});

test("only the approved binary brand PNG passes signature, dimensions and digest checks", async () => {
	const icon = await readFile(new URL("../branding/png/256x256.png", import.meta.url));
	assert.doesNotThrow(() => assertBrandIcon(icon));
	assert.throws(() => assertBrandIcon(Buffer.from("not a PNG")), /approved PNG/);
	for (const offset of [0, 16, icon.length - 1]) {
		const changed = Buffer.from(icon);
		changed[offset] ^= 1;
		assert.throws(() => assertBrandIcon(changed), /approved PNG/);
	}
	assert.throws(() => assertBrandIcon(Buffer.concat([icon, Buffer.from("private trailer")])), /approved PNG/);
});

test("native brand configuration preserves resource editing and disables signing/publishing", () => {
	assert.equal(builder.win.signExecutable, false);
	assert.notEqual(builder.win.signAndEditExecutable, false);
	assert.equal(builder.mac.identity, null);
	assert.equal(builder.mac.notarize, false);
	assert.equal(builder.publish, null);
	assert.ok(builder.mac.icon.endsWith(join("branding", "icon.icns")));
	assert.ok(builder.win.icon.endsWith(join("branding", "icon.ico")));
	assert.ok(builder.linux.icon.endsWith(join("branding", "png")));
});

test("private paths and map references fail closed", () => {
	assert.throws(() => assertPublicText("//# sourceMappingURL=x.map", "/private/build"));
	assert.throws(() => assertPublicText("/private/build/src/main.ts", "/private/build"));
	assert.doesNotThrow(() => assertPublicText("console.log('public');", "/private/build"));
});

test("maintenance builds as an offline Node-only standalone CLI and runs relocated help", async () => {
	const directory = await mkdtemp(join(tmpdir(), "Hipi 维护 bundle-"));
	try {
		const entry = join(directory, "maintenance.mjs");
		const result = await build({
			entryPoints: [fileURLToPath(new URL("../../../packages/work-runtime/src/store-cli.ts", import.meta.url))],
			outfile: entry,
			bundle: true,
			platform: "node",
			format: "esm",
			conditions: ["source"],
			metafile: true,
		});
		assertMaintenanceBundle(result.metafile);
		const help = spawnSync(process.execPath, [entry, "--help"], {
			cwd: directory,
			env: {},
			encoding: "utf8",
			timeout: 15000,
		});
		assert.equal(help.error, undefined);
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /backup/);
		assert.match(help.stdout, /restore/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("maintenance boundary rejects provider code, external packages and network imports", () => {
	for (const input of [
		"../../packages/ai/src/index.ts",
		"../../packages/work-runtime/src/model-provider.ts",
		"src/credentials.ts",
	]) {
		assert.throws(() => assertMaintenanceBundle({ inputs: { [input]: {} }, outputs: {} }));
	}
	for (const path of ["openai", "electron", "node:https", "node:child_process"]) {
		assert.throws(() =>
			assertMaintenanceBundle({ inputs: {}, outputs: { "maintenance.mjs": { imports: [{ path, external: true }] } } }),
		);
	}
});

test("packaging rejects changed, added, missing or legacy external brand/config inputs", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-packaging-inputs-"));
	const desktop = join(root, "apps/hipi-work-desktop");
	try {
		await mkdir(join(desktop, "branding"), { recursive: true });
		await mkdir(join(desktop, "packaging"), { recursive: true });
		const notices = join(root, "apps/hipi-work-ui/vendor/pierre");
		await mkdir(notices, { recursive: true });
		const codeMirrorNotices = join(root, "apps/hipi-work-ui/vendor/codemirror");
		await mkdir(codeMirrorNotices, { recursive: true });
		await writeFile(join(root, "package-lock.json"), "{}");
		await writeFile(join(desktop, "package.json"), "{}");
		const icon = join(desktop, "branding/icon.ico");
		const config = join(desktop, "packaging/electron-builder.cjs");
		await writeFile(icon, "approved icon");
		await writeFile(config, "approved config");
		const notice = join(notices, "README.md");
		await writeFile(notice, "approved notice");
		const codeMirrorNotice = join(codeMirrorNotices, "README.md");
		await writeFile(codeMirrorNotice, "approved CodeMirror notice");
		const snapshot = await inventory(root);
		await assertPackagingInputs(root, snapshot);
		for (const file of [icon, config, notice, codeMirrorNotice]) {
			const original = await readFile(file);
			await writeFile(file, "changed");
			await assert.rejects(assertPackagingInputs(root, snapshot), /digest changed/);
			await writeFile(file, original);
		}
		const added = join(desktop, "branding/extra.png");
		await writeFile(added, "extra");
		await assert.rejects(assertPackagingInputs(root, snapshot), /input set changed/);
		await rm(added);
		await assert.rejects(assertPackagingInputs(root, []), /input set changed/);
		await rm(icon);
		await assert.rejects(assertPackagingInputs(root, snapshot), /input set changed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("complete source snapshot rejects stale UI, configuration, scripts and incomplete provenance", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-source-snapshot-"));
	const files = [
		"package.json",
		"package-lock.json",
		"nix/model-catalog.json",
		"tsconfig.base.json",
		"tsconfig.json",
		"apps/hipi-work-ui/index.html",
		"apps/hipi-work-ui/THIRD_PARTY_NOTICES.md",
		"LICENSE",
		"apps/hipi-work-ui/src/screen.tsx",
		"apps/hipi-work-ui/vite.config.ts",
		"apps/hipi-work-ui/vendor/component.tsx",
		"apps/hipi-work-ui/public/icon.png",
		"apps/hipi-work-desktop/package.json",
		"apps/hipi-work-desktop/src/main.ts",
		"apps/hipi-work-desktop/scripts/smoke.mjs",
		"apps/hipi-work-desktop/packaging/config.cjs",
		"apps/hipi-work-desktop/branding/icon.png",
		"packages/runtime/src/runtime.ts",
	];
	try {
		for (const file of files) {
			await mkdir(dirname(join(root, file)), { recursive: true });
			await writeFile(join(root, file), file);
		}
		const snapshot = await sourceSnapshot(root);
		assert.deepEqual(
			snapshot.map((entry) => entry.file),
			[...files].sort(),
		);
		await assertSourceSnapshot(root, snapshot);
		for (const file of [
			"apps/hipi-work-ui/src/screen.tsx",
			"apps/hipi-work-ui/vite.config.ts",
			"apps/hipi-work-desktop/scripts/smoke.mjs",
		]) {
			await writeFile(join(root, file), "changed after build");
			await assert.rejects(assertSourceSnapshot(root, snapshot), /Source input set or digest changed/);
			await writeFile(join(root, file), file);
		}
		const added = join(root, "apps/hipi-work-ui/src/new-screen.tsx");
		await writeFile(added, "new UI");
		await assert.rejects(assertSourceSnapshot(root, snapshot), /Source input set or digest changed/);
		await rm(added);
		const removed = "apps/hipi-work-ui/src/screen.tsx";
		await rm(join(root, removed));
		await assert.rejects(assertSourceSnapshot(root, snapshot), /Source input set or digest changed/);
		await writeFile(join(root, removed), removed);
		for (const incomplete of [
			[],
			snapshot.slice(1),
			[...snapshot, snapshot[0]],
			[snapshot[0], ...snapshot.slice(0, -1)],
		])
			await assert.rejects(assertSourceSnapshot(root, incomplete), /Source input set or digest changed/);
		await assertSourceSnapshot(root, snapshot);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("test/file gate rejects missing files before Node can silently ignore them", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-release-policy-"));
	try {
		await writeFile(join(root, "present.test.mjs"), "");
		await assert.rejects(requireFiles(root, ["present.test.mjs", "missing.test.mjs"]));
		await assert.rejects(requireFiles(root, []));
		await mkdir(join(root, "directory"));
		await assert.rejects(requireFiles(root, ["directory"]));
		await requireFiles(root, ["present.test.mjs"]);
		if (process.platform !== "win32") {
			await symlink(join(root, "present.test.mjs"), join(root, "linked"));
			await assert.rejects(filesUnder(root), /Symlink forbidden/);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
