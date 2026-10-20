import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertCodeMirrorDependencies,
	assertCodeMirrorLicenseAsset,
	codeMirrorInventorySha256,
	codeMirrorLicenseAssets,
	codeMirrorPackageForOwner,
	codeMirrorPackages,
	prepareCodeMirrorLicenses,
	readCodeMirrorLicenseFiles,
} from "./codemirror-licenses.mjs";
import { allowedPayload, inventory, requiredFiles } from "./release-policy.mjs";
import { createReviewedLicenseSet } from "./reviewed-licenses.mjs";

const ui = fileURLToPath(new URL("../../hipi-work-ui/", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("CodeMirror allowlist contains only its independently pinned 24 notices, README and inventory", async () => {
	assert.equal(codeMirrorPackages.length, 24);
	assert.equal(codeMirrorLicenseAssets.length, 26);
	const files = await readCodeMirrorLicenseFiles(join(ui, "vendor/codemirror"));
	assert.equal(files.length, 26);
	assert.equal(
		codeMirrorLicenseAssets.find((asset) => asset.file === "inventory.json").sha256,
		codeMirrorInventorySha256,
	);
	for (const asset of files) {
		assert.ok(requiredFiles.includes(asset.payload));
		assert.equal(allowedPayload(asset.payload), true);
		const tampered = Buffer.concat([asset.bytes, Buffer.from("\nchanged")]);
		assert.throws(() => assertCodeMirrorLicenseAsset(asset.payload, tampered), /digest mismatch/);
	}
	for (const path of [
		"dist/third-party/codemirror/source.js",
		"dist/third-party/codemirror/licenses/other.LICENSE",
		"dist/third-party/codemirror/licenses/../README.md",
	]) {
		assert.equal(allowedPayload(path), false);
		assert.throws(() => assertCodeMirrorLicenseAsset(path, Buffer.from("extra")), /Unreviewed/);
	}
	assert.throws(
		() =>
			createReviewedLicenseSet({
				label: "CodeMirror",
				vendorDirectory: "codemirror",
				inventoryUrl: new URL("../../hipi-work-ui/vendor/codemirror/inventory.json", import.meta.url),
				inventorySha256: "0".repeat(64),
				readmeSha256: "0".repeat(64),
				protectedNames: /^@(?:codemirror|lezer)\//,
			}),
		/inventory changed/,
	);
});

test("CodeMirror copying preserves all bytes and refuses missing, extra or modified inputs", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-codemirror-notices-"));
	try {
		const source = join(root, "ui/vendor/codemirror");
		const desktop = join(root, "desktop");
		await cp(join(ui, "vendor/codemirror"), source, { recursive: true });
		const before = await inventory(source);
		await prepareCodeMirrorLicenses(join(root, "ui"), desktop);
		assert.deepEqual(await inventory(join(desktop, "dist/third-party/codemirror")), before);
		assert.deepEqual(await inventory(source), before);
		const notice = join(source, codeMirrorLicenseAssets[2].file);
		const bytes = await readFile(notice);
		await rm(notice);
		await assert.rejects(prepareCodeMirrorLicenses(join(root, "ui"), desktop), /notice set changed/);
		await writeFile(notice, bytes);
		await writeFile(join(source, "licenses/extra.LICENSE"), "unreviewed");
		await assert.rejects(readCodeMirrorLicenseFiles(source), /notice set changed/);
		await rm(join(source, "licenses/extra.LICENSE"));
		await writeFile(join(source, "inventory.json"), "{}");
		await assert.rejects(readCodeMirrorLicenseFiles(source), /digest mismatch/);
		assert.deepEqual(await inventory(join(desktop, "dist/third-party/codemirror")), before);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("CodeMirror copying rejects each linked destination ancestor without changing the outside directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-codemirror-links-"));
	try {
		const desktop = join(root, "desktop");
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "sentinel"), "unchanged");
		const before = await inventory(outside);
		for (const component of [
			"",
			"dist",
			"dist/third-party",
			"dist/third-party/codemirror",
			"dist/third-party/codemirror/licenses",
		]) {
			const target = join(desktop, component);
			await mkdir(dirname(target), { recursive: true });
			await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
			await assert.rejects(prepareCodeMirrorLicenses(ui, desktop), /must not be a symlink/);
			assert.deepEqual(await inventory(outside), before);
			await rm(target);
			await rm(desktop, { recursive: true, force: true });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("all actual CodeMirror installed identities and exact direct versions match the lock", async () => {
	const lock = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8"));
	await assertCodeMirrorDependencies(repository, lock);
	const entry = codeMirrorPackages.find((item) => item.name === "@codemirror/lang-markdown");
	for (const change of [
		{ version: "0.0.0" },
		{ integrity: "changed" },
		{ license: "UNDECLARED" },
		{ hasInstallScript: true },
	]) {
		const changed = structuredClone(lock);
		Object.assign(changed.packages[entry.path], change);
		await assert.rejects(assertCodeMirrorDependencies(repository, changed), /changed|requires review/);
	}
	const changed = structuredClone(lock);
	changed.packages["apps/hipi-work-ui"].dependencies["@codemirror/lang-markdown"] = "^6.5.2";
	await assert.rejects(assertCodeMirrorDependencies(repository, changed), /locked direct version changed/);
});

test("CodeMirror retained owner association keeps both state versions bound to their exact installed paths", () => {
	for (const entry of codeMirrorPackages) {
		const info = { name: entry.name, version: entry.version, license: entry.license };
		assert.equal(codeMirrorPackageForOwner(entry.path, info, { integrity: entry.integrity }), entry);
	}
	const states = codeMirrorPackages.filter((entry) => entry.name === "@codemirror/state");
	assert.equal(states.length, 2);
	const [direct, nested] = states;
	assert.throws(
		() => codeMirrorPackageForOwner(direct.path, nested, { integrity: nested.integrity }),
		/version changed/,
	);
	assert.throws(
		() => codeMirrorPackageForOwner("node_modules/wrong-copy", direct, { integrity: direct.integrity }),
		/reviewed package path/,
	);
	assert.throws(
		() => codeMirrorPackageForOwner("node_modules/@lezer/new", { name: "@lezer/new", version: "1.0.0" }, {}),
		/reviewed package path/,
	);
	assert.equal(
		codeMirrorPackageForOwner("packages/work-ui", { name: "@hipi/work-ui", version: "0.0.1" }, {}),
		undefined,
	);
});
