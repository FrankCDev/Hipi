import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveBundleOwner } from "./bundle-owner.mjs";

async function fixture(run) {
	const root = await mkdtemp(join(tmpdir(), "hipi-bundle-owner-"));
	const put = async (path, value) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
	};
	try {
		await put("package.json", { name: "fixture", version: "1.0.0" });
		await run(root, put);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("nested module-scope manifests resolve to the exact locked distribution, not an outer package", async () => {
	await fixture(async (root, put) => {
		const path = "node_modules/@pierre/diffs/node_modules/diff";
		const info = { name: "diff", version: "9.0.0", license: "BSD-3-Clause" };
		const locked = { version: "9.0.0", integrity: "reviewed-integrity" };
		await put(`${path}/package.json`, info);
		await put(`${path}/libesm/package.json`, { type: "module", sideEffects: false });
		await put(`${path}/libesm/diff/array.js`, "export {};");
		const owner = await resolveBundleOwner(root, `${path}/libesm/diff/array.js`, { packages: { [path]: locked } });
		assert.equal(owner.key, path);
		assert.equal(owner.location, await realpath(join(root, path)));
		assert.deepEqual(owner.info, info);
		assert.equal(owner.locked, locked);
	});
});

test("multiple type-only scopes and named workspaces retain exact owner paths", async () => {
	await fixture(async (root, put) => {
		for (const path of ["node_modules/oniguruma-to-es", "packages/owned"]) {
			await put(`${path}/package.json`, {
				name: path === "packages/owned" ? "@hipi/owned" : "oniguruma-to-es",
				version: "4.3.6",
			});
			await put(`${path}/dist/package.json`, { type: "commonjs" });
			await put(`${path}/dist/esm/package.json`, { type: "module" });
			await put(`${path}/dist/esm/index.js`, "export {};");
			const owner = await resolveBundleOwner(root, `${path}/dist/esm/index.js`, {
				packages: { [path]: { version: "4.3.6" } },
			});
			assert.equal(owner.key, path);
		}
	});
});

test("private versionless subpath descriptors belong to the locked parent distribution", async () => {
	await fixture(async (root, put) => {
		const path = "node_modules/preact";
		const info = { name: "preact", version: "11.0.0-beta.0", license: "MIT" };
		const locked = { version: info.version, integrity: "reviewed-preact-integrity" };
		await put(`${path}/package.json`, info);
		for (const [directory, name] of [
			["hooks", "preact-hooks"],
			["jsx-runtime", "jsx-runtime"],
		]) {
			await put(`${path}/${directory}/package.json`, {
				name,
				private: true,
				main: "dist/index.js",
				module: "dist/index.mjs",
				license: "MIT",
				peerDependencies: { preact: "^10.0.0" },
			});
			await put(`${path}/${directory}/dist/index.mjs`, "export {};");
			const owner = await resolveBundleOwner(root, `${path}/${directory}/dist/index.mjs`, {
				packages: { [path]: locked },
			});
			assert.equal(owner.key, path);
			assert.deepEqual(owner.info, info);
			assert.equal(owner.locked, locked);
		}
	});
});

test("genuine nameless or malformed owners fail instead of inheriting repository identity", async () => {
	await fixture(async (root, put) => {
		const path = "node_modules/broken";
		await put(`${path}/index.js`, "export {};");
		const lock = { packages: { "": { version: "1.0.0" }, [path]: { version: "2.0.0" } } };
		for (const info of [
			{ type: "module" },
			{},
			{ name: "", version: "2.0.0" },
			{ name: "../escape", version: "2.0.0" },
			{ name: "broken" },
			{ version: "2.0.0" },
			null,
			[],
		]) {
			await put(`${path}/package.json`, info);
			await assert.rejects(resolveBundleOwner(root, `${path}/index.js`, lock));
		}
		await rm(join(root, path, "package.json"));
		await assert.rejects(resolveBundleOwner(root, `${path}/index.js`, lock), /manifest is missing/);
		await put(`${path}/package.json`, { type: "module" });
		await assert.rejects(
			resolveBundleOwner(root, `${path}/index.js`, { packages: { "": { version: "1.0.0" } } }),
			/Nameless bundle owner/,
		);
	});
});

test("unsupported nameless records, unlocked nested identity and mismatched versions fail closed", async () => {
	await fixture(async (root, put) => {
		const path = "node_modules/valid";
		await put(`${path}/package.json`, { name: "valid", version: "1.0.0" });
		await put(`${path}/dist/index.js`, "export {};");
		const lock = { packages: { [path]: { version: "1.0.0" } } };
		for (const info of [
			{ main: "index.js" },
			{ type: "module", dependencies: {} },
			{ type: "invalid" },
			{ type: "module", sideEffects: [] },
			{ name: "unlocked", version: "1.0.0" },
			{ name: "versionless" },
			{ name: "versionless", private: false },
			{ name: "../escape", private: true },
		]) {
			await put(`${path}/dist/package.json`, info);
			await assert.rejects(resolveBundleOwner(root, `${path}/dist/index.js`, lock));
		}
		await rm(join(root, path, "dist/package.json"));
		await assert.rejects(
			resolveBundleOwner(root, `${path}/dist/index.js`, { packages: { [path]: { version: "2.0.0" } } }),
			/locked version changed/,
		);
		await assert.rejects(
			resolveBundleOwner(root, `${path}/dist/index.js`, { packages: { [path]: { name: "other", version: "1.0.0" } } }),
			/locked name changed/,
		);
		await assert.rejects(resolveBundleOwner(root, `${path}/dist/index.js`, { packages: {} }), /locked package path/);
	});
});

test("input traversal, links outside the root and linked manifests cannot escape attribution boundaries", async () => {
	await fixture(async (root, put) => {
		const lock = { packages: { "": { version: "1.0.0" } } };
		await put("index.js", "export {};");
		for (const input of [
			"../outside.js",
			"/outside.js",
			"C:/outside.js",
			"node_modules\\outside.js",
			"./index.js",
			"src/../index.js",
			"index.js\0",
			"",
		]) {
			await assert.rejects(resolveBundleOwner(root, input, lock), /Invalid bundle input path/);
		}
		await assert.rejects(resolveBundleOwner(root, "package.json/missing", lock));
		if (process.platform !== "win32") {
			const outside = await mkdtemp(join(tmpdir(), "hipi-bundle-outside-"));
			try {
				await writeFile(join(outside, "index.js"), "export {};");
				await symlink(outside, join(root, "linked"));
				await assert.rejects(resolveBundleOwner(root, "linked/index.js", lock), /outside repository/);
				await put("nested/index.js", "export {};");
				await symlink(join(root, "package.json"), join(root, "nested/package.json"));
				await assert.rejects(resolveBundleOwner(root, "nested/index.js", lock), /regular file/);
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		}
	});
});
