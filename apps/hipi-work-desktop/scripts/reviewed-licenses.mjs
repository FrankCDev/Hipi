import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Shared mechanics for explicitly pinned license sets, never directory discovery or automatic approval.
export function createReviewedLicenseSet({
	label,
	vendorDirectory,
	inventoryUrl,
	inventorySha256,
	readmeSha256,
	protectedNames,
}) {
	const inventoryBytes = readFileSync(inventoryUrl);
	assert.equal(
		createHash("sha256").update(inventoryBytes).digest("hex"),
		inventorySha256,
		`${label} inventory changed`,
	);
	const reviewed = JSON.parse(inventoryBytes.toString("utf8"));
	const packages = Object.freeze(
		reviewed.packages.map((entry) =>
			Object.freeze({
				...entry,
				lifecycle: Object.freeze(entry.lifecycle),
				notices: Object.freeze(entry.notices.map((notice) => Object.freeze(notice))),
			}),
		),
	);
	const assets = Object.freeze(
		[
			{ file: "inventory.json", sha256: inventorySha256 },
			{ file: "README.md", sha256: readmeSha256 },
			...packages.flatMap((entry) => entry.notices.map(({ file, sha256 }) => ({ file, sha256 }))),
		].map((asset) => Object.freeze({ ...asset, payload: `dist/third-party/${vendorDirectory}/${asset.file}` })),
	);

	function assertAsset(path, bytes) {
		const asset = assets.find((entry) => entry.payload === path);
		assert.ok(asset, `Unreviewed ${label} license payload`);
		assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `${label} license digest mismatch`);
	}

	async function readFiles(directory) {
		assert.ok((await lstat(directory)).isDirectory(), `${label} license directory must not be a symlink`);
		assert.deepEqual(
			(await readdir(directory)).sort(),
			["README.md", "inventory.json", "licenses"],
			`${label} input set changed`,
		);
		assert.ok((await lstat(join(directory, "licenses"))).isDirectory(), `${label} notices must not be a symlink`);
		assert.deepEqual(
			(await readdir(join(directory, "licenses"))).sort(),
			assets
				.filter((asset) => asset.file.startsWith("licenses/"))
				.map((asset) => asset.file.slice(9))
				.sort(),
			`${label} notice set changed`,
		);
		const result = [];
		for (const asset of assets) {
			const file = join(directory, asset.file);
			assert.ok((await lstat(file)).isFile(), `${label} license input must be a regular file`);
			const bytes = await readFile(file);
			assertAsset(asset.payload, bytes);
			result.push({ ...asset, bytes });
		}
		return result;
	}

	async function prepare(ui, desktop) {
		const files = await readFiles(join(ui, `vendor/${vendorDirectory}`));
		const destination = join(desktop, `dist/third-party/${vendorDirectory}`);
		// Do not let recursive mkdir follow an unchecked parent before rejecting it.
		for (const component of [
			"",
			"dist",
			"dist/third-party",
			`dist/third-party/${vendorDirectory}`,
			`dist/third-party/${vendorDirectory}/licenses`,
		]) {
			const directory = join(desktop, component);
			try {
				assert.ok((await lstat(directory)).isDirectory(), `${label} license destination must not be a symlink`);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
				await mkdir(directory);
			}
		}
		for (const file of files) {
			const target = join(destination, file.file);
			try {
				assert.ok((await lstat(target)).isFile(), `${label} license destination must be a regular file`);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await writeFile(target, file.bytes);
		}
		await readFiles(destination);
	}

	async function assertDependencies(root, lock) {
		const ui = JSON.parse(await readFile(join(root, "apps/hipi-work-ui/package.json"), "utf8"));
		for (const id of reviewed.direct) {
			const entry = packages.find((item) => `${item.name}@${item.version}` === id);
			assert.ok(entry, `${label} direct dependency is not inventoried`);
			assert.equal(ui.dependencies?.[entry.name], entry.version, `${label} direct version changed`);
			assert.equal(
				lock.packages?.["apps/hipi-work-ui"]?.dependencies?.[entry.name],
				entry.version,
				`${label} locked direct version changed`,
			);
		}
		for (const entry of packages) {
			const info = JSON.parse(await readFile(join(root, entry.path, "package.json"), "utf8"));
			const locked = lock.packages?.[entry.path];
			assert.equal(info.name, entry.name, `${label} installed package name changed`);
			assert.equal(info.version, entry.version, `${label} installed package version changed`);
			assert.equal(info.license, entry.license, `${label} installed license changed`);
			assert.equal(locked?.version, entry.version, `${label} locked package version changed`);
			assert.equal(locked?.integrity, entry.integrity, `${label} locked integrity changed`);
			assert.equal(locked?.license, entry.license, `${label} locked license changed`);
			assert.notEqual(locked?.hasInstallScript, true, `${label} install lifecycle requires review`);
			for (const phase of ["preinstall", "install", "postinstall"])
				assert.equal(info.scripts?.[phase], undefined, `${label} install lifecycle requires review`);
		}
	}

	function packageForOwner(path, info, locked) {
		const entry = packages.find((item) => item.path === path);
		if (!entry) {
			assert.ok(
				!packages.some((item) => item.name === info.name && item.version === info.version) &&
					!protectedNames.test(info.name),
				`${label} bundle owner is not at its reviewed package path`,
			);
			return undefined;
		}
		assert.equal(info.name, entry.name, `${label} bundle owner name changed`);
		assert.equal(info.version, entry.version, `${label} bundle owner version changed`);
		assert.equal(info.license, entry.license, `${label} bundle owner license changed`);
		assert.equal(locked?.integrity, entry.integrity, `${label} bundle owner integrity changed`);
		return entry;
	}

	return Object.freeze({ packages, assets, assertAsset, readFiles, prepare, assertDependencies, packageForOwner });
}
