import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertPierreDependencies,
	assertPierreLicenseAsset,
	pierreInventorySha256,
	pierreLicenseAssets,
	pierrePackageForOwner,
	pierrePackages,
	preparePierreLicenses,
	readPierreLicenseFiles,
} from "./pierre-licenses.mjs";
import { allowedPayload, inventory, requiredFiles } from "./release-policy.mjs";

const ui = fileURLToPath(new URL("../../hipi-work-ui/", import.meta.url));
const vendor = join(ui, "vendor/pierre");

async function fixture(run) {
	const root = await mkdtemp(join(tmpdir(), "hipi-pierre-notices-"));
	try {
		await cp(vendor, join(root, "ui/vendor/pierre"), { recursive: true });
		await run(root, join(root, "ui/vendor/pierre"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("Pierre inventory pins 55 installed identities and exactly 57 notices, not a directory wildcard", async () => {
	assert.equal(pierrePackages.length, 55);
	assert.equal(pierreLicenseAssets.length, 59);
	const files = await readPierreLicenseFiles(vendor);
	assert.equal(files.length, 59);
	assert.equal(pierreLicenseAssets.find((asset) => asset.file === "inventory.json").sha256, pierreInventorySha256);
	for (const asset of files) {
		assert.ok(requiredFiles.includes(asset.payload));
		assert.equal(allowedPayload(asset.payload), true);
		const tampered = Buffer.from(asset.bytes);
		tampered[tampered.length - 1] ^= 1;
		assert.throws(() => assertPierreLicenseAsset(asset.payload, tampered), /digest mismatch/);
	}
	for (const file of [
		"dist/third-party/pierre/source.js",
		"dist/third-party/pierre/licenses/other.LICENSE",
		"dist/third-party/pierre/licenses/../private.json",
		"dist/third-party/pierre/inventory.json.map",
	]) {
		assert.equal(allowedPayload(file), false);
		assert.throws(() => assertPierreLicenseAsset(file, Buffer.from("not reviewed")), /Unreviewed/);
	}
});

test("preparation copies only the reviewed inventory, README and notice bytes", async () => {
	await fixture(async (root, source) => {
		const before = await inventory(source);
		await preparePierreLicenses(join(root, "ui"), join(root, "desktop"));
		const destination = join(root, "desktop/dist/third-party/pierre");
		assert.deepEqual(await inventory(destination), before);
		assert.deepEqual(await inventory(source), before);
		assert.equal((await readPierreLicenseFiles(destination)).length, 59);
		await writeFile(join(destination, "licenses/extra.LICENSE"), "unreviewed");
		await assert.rejects(preparePierreLicenses(join(root, "ui"), join(root, "desktop")), /notice set changed/);
	});
});

test("missing or modified notices, README and inventory fail before copying", async () => {
	await fixture(async (root, source) => {
		const notice = pierreLicenseAssets.find((asset) => asset.file.endsWith("NOTICE.md"));
		const file = join(source, notice.file);
		const original = await readFile(file);
		await rm(file);
		await assert.rejects(preparePierreLicenses(join(root, "ui"), join(root, "desktop")), /notice set changed/);
		await assert.rejects(readFile(join(root, "desktop/dist/third-party/pierre/inventory.json")), { code: "ENOENT" });
		await writeFile(file, original);
		for (const path of [file, join(source, "README.md"), join(source, "inventory.json")]) {
			const saved = await readFile(path);
			await writeFile(path, Buffer.concat([saved, Buffer.from("\nchanged")]));
			await assert.rejects(readPierreLicenseFiles(source), /digest mismatch/);
			await writeFile(path, saved);
		}
		await writeFile(file, "replacement notice");
		const changedInventory = JSON.parse(await readFile(join(source, "inventory.json"), "utf8"));
		changedInventory.packages[0].notices = [];
		await writeFile(join(source, "inventory.json"), JSON.stringify(changedInventory));
		await assert.rejects(readPierreLicenseFiles(source), /digest mismatch/);
	});
});

test("preparation rejects linked destination ancestors before creating or writing through them", async () => {
	await fixture(async (root) => {
		const desktop = join(root, "desktop");
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "sentinel.txt"), "unchanged");
		const before = await inventory(outside);
		for (const component of [
			"",
			"dist",
			"dist/third-party",
			"dist/third-party/pierre",
			"dist/third-party/pierre/licenses",
		]) {
			const target = join(desktop, component);
			await mkdir(dirname(target), { recursive: true });
			await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
			await assert.rejects(preparePierreLicenses(join(root, "ui"), desktop), /must not be a symlink/);
			assert.deepEqual(await inventory(outside), before);
			await rm(target);
			await rm(desktop, { recursive: true, force: true });
		}
	});
});

test("unexpected files, nested directories and symlinks cannot enter the copied notice set", async () => {
	await fixture(async (_root, source) => {
		await writeFile(join(source, "private.txt"), "private");
		await assert.rejects(readPierreLicenseFiles(source), /input set changed/);
		await rm(join(source, "private.txt"));
		await mkdir(join(source, "licenses/nested"));
		await assert.rejects(readPierreLicenseFiles(source), /notice set changed/);
		await rm(join(source, "licenses/nested"), { recursive: true });
		const notice = join(source, pierreLicenseAssets[2].file);
		const original = await readFile(notice);
		await rm(notice);
		await mkdir(notice);
		await assert.rejects(readPierreLicenseFiles(source), /regular file/);
		await rm(notice, { recursive: true });
		await writeFile(notice, original);
		if (process.platform !== "win32") {
			await rename(notice, `${source}/../outside-notice`);
			await symlink(`${source}/../outside-notice`, notice);
			await assert.rejects(readPierreLicenseFiles(source), /regular file/);
			await rm(notice);
			await writeFile(notice, original);
			await rename(join(source, "licenses"), `${source}/../outside-licenses`);
			await symlink(`${source}/../outside-licenses`, join(source, "licenses"));
			await assert.rejects(readPierreLicenseFiles(source), /must not be a symlink/);
		}
	});
});

test("the actual installed closure and lock match the reviewed Pierre package metadata", async () => {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
	await assertPierreDependencies(root, lock);
});

test("installed and locked Pierre metadata must match every reviewed identity and lifecycle boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-pierre-metadata-"));
	try {
		const manifest = JSON.parse(await readFile(join(ui, "package.json"), "utf8"));
		const direct = Object.fromEntries(
			["@pierre/diffs", "@pierre/trees", "shiki"].map((name) => [name, manifest.dependencies[name]]),
		);
		const lock = { packages: { "apps/hipi-work-ui": { dependencies: direct } } };
		await mkdir(join(root, "apps/hipi-work-ui"), { recursive: true });
		await writeFile(join(root, "apps/hipi-work-ui/package.json"), JSON.stringify({ dependencies: direct }));
		for (const entry of pierrePackages) {
			const file = join(root, entry.path, "package.json");
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, JSON.stringify({ name: entry.name, version: entry.version, license: entry.license }));
			lock.packages[entry.path] = { version: entry.version, integrity: entry.integrity, license: entry.license };
		}
		await assertPierreDependencies(root, lock);
		const entry = pierrePackages.find((item) => item.name === "lru_map");
		for (const field of ["version", "integrity", "license", "hasInstallScript"]) {
			const saved = lock.packages[entry.path];
			lock.packages[entry.path] = { ...saved, [field]: field === "hasInstallScript" ? true : "changed" };
			await assert.rejects(assertPierreDependencies(root, lock), /changed|requires review/);
			lock.packages[entry.path] = saved;
		}
		const file = join(root, entry.path, "package.json");
		const info = JSON.parse(await readFile(file, "utf8"));
		for (const change of [
			{ name: "other" },
			{ version: "0.0.0" },
			{ license: "UNDECLARED" },
			{ scripts: { postinstall: "node bad.js" } },
		]) {
			await writeFile(file, JSON.stringify({ ...info, ...change }));
			await assert.rejects(assertPierreDependencies(root, lock), /changed|requires review/);
		}
		await writeFile(file, JSON.stringify(info));
		await rm(file);
		await assert.rejects(assertPierreDependencies(root, lock), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("license inclusion associates only the exact retained package owner, including the README license", () => {
	const entry = pierrePackages.find((item) => item.name === "lru_map");
	const info = { name: entry.name, version: entry.version, license: entry.license };
	const locked = { integrity: entry.integrity };
	const owner = pierrePackageForOwner(entry.path, info, locked);
	assert.equal(owner, entry);
	assert.equal(owner.notices[0].source, "README.md#MIT-license");
	assert.ok(requiredFiles.includes(`dist/third-party/pierre/${owner.notices[0].file}`));
	assert.throws(() => pierrePackageForOwner(entry.path, { ...info, version: "0.0.0" }, locked), /version changed/);
	assert.throws(() => pierrePackageForOwner(entry.path, info, { integrity: "changed" }), /integrity changed/);
	assert.throws(() => pierrePackageForOwner("node_modules/other-copy", info, locked), /reviewed package path/);
	assert.equal(pierrePackageForOwner("node_modules/diff", { name: "diff", version: "5.0.0" }, {}), undefined);
	assert.throws(
		() => pierrePackageForOwner("node_modules/@pierre/new", { name: "@pierre/new", version: "1.0.0" }, {}),
		/reviewed package path/,
	);
});
