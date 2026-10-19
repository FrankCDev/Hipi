import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import asarLookupPath from "../packaging/asar-path.cjs";
import verifyPack from "../packaging/verify-pack.cjs";
import { inventory } from "./release-policy.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const { createPackageWithOptions } = builderRequire("@electron/asar");

async function fixture(change, check) {
	const root = await mkdtemp(join(tmpdir(), "hipi-asar-check-"));
	try {
		const app = join(root, "app");
		const out = join(root, "out");
		await mkdir(join(app, "dist"), { recursive: true });
		await mkdir(join(out, "resources"), { recursive: true });
		await mkdir(join(app, "dist/branding"), { recursive: true });
		await writeFile(join(app, "dist/branding/icon.png"), Buffer.from([137, 80, 78, 71]));
		await mkdir(join(app, "licenses/作者 名"), { recursive: true });
		await writeFile(join(app, "licenses/作者 名/LICENSE"), "Fixture license");
		for (const file of ["runtime.mjs", "preview-parser.mjs", "maintenance.mjs", "main.mjs"])
			await writeFile(join(app, "dist", file), "export {};\n");
		await writeFile(join(app, "build-provenance.json"), JSON.stringify({ payload: await inventory(app) }));
		await change(app);
		await createPackageWithOptions(app, join(out, "resources/app.asar"), {
			unpack: "**/{runtime,preview-parser,maintenance}.mjs",
		});
		await check({ appOutDir: out, electronPlatformName: "linux" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("post-pack verifier accepts exact ASAR inventory and unpacked entries", async () => {
	await fixture(async () => {}, verifyPack);
});

test("installed ASAR traversal requires native lookup separators for nested POSIX inventory paths", async () => {
	const implementation = join(dirname(builderRequire.resolve("@electron/asar")), "filesystem.js");
	const source = await readFile(implementation, "utf8");
	const localRequire = createRequire(implementation);
	for (const pathApi of [posix, win32]) {
		const module = { exports: {} };
		// Execute the pinned upstream implementation with only its path dependency
		// switched, rather than approximating Windows traversal in our own mock.
		runInNewContext(source, {
			module,
			exports: module.exports,
			require: (name) => (name === "path" ? pathApi : localRequire(name)),
			process,
		});
		const filesystem = new module.exports.Filesystem(pathApi.resolve("fixture"));
		const icon = { size: 4, offset: "0" };
		const license = { size: 15, offset: "4" };
		filesystem.setHeader(
			{
				files: {
					dist: { files: { branding: { files: { "icon.png": icon } } } },
					licenses: { files: { "作者 名": { files: { LICENSE: license } } } },
				},
			},
			0,
		);
		if (pathApi === win32) assert.throws(() => filesystem.getFile("dist/branding/icon.png"), /not found/);
		assert.equal(filesystem.getFile(asarLookupPath("dist/branding/icon.png", pathApi)), icon);
		assert.equal(filesystem.getFile(asarLookupPath("licenses/作者 名/LICENSE", pathApi)), license);
		const listed = filesystem.listFiles().map((file) => file.replaceAll("\\", "/").replace(/^\//, ""));
		const files = listed.filter((file) => !filesystem.getFile(asarLookupPath(file, pathApi)).files);
		assert.deepEqual([...files], ["dist/branding/icon.png", "licenses/作者 名/LICENSE"]);
	}
});

test("post-pack verifier rejects extra source maps even if builder includes them", async () => {
	await fixture(
		(app) => writeFile(join(app, "dist/private.mjs.map"), "{}"),
		(context) => assert.rejects(verifyPack(context), /missing\/unexpected/),
	);
});

test("post-pack verifier rejects payload tampering after provenance capture", async () => {
	await fixture(
		(app) => writeFile(join(app, "dist/main.mjs"), "tampered"),
		(context) => assert.rejects(verifyPack(context), /Packaged digest/),
	);
});

test("post-pack verifier rejects a missing real worker entry", async () => {
	await fixture(
		async () => {},
		async (context) => {
			await rm(join(context.appOutDir, "resources/app.asar.unpacked/dist/preview-parser.mjs"));
			await assert.rejects(verifyPack(context));
		},
	);
});

test("post-pack verifier rejects a missing real maintenance entry", async () => {
	await fixture(
		async () => {},
		async (context) => {
			await rm(join(context.appOutDir, "resources/app.asar.unpacked/dist/maintenance.mjs"));
			await assert.rejects(verifyPack(context));
		},
	);
});
