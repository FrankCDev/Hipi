const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const pin = require("./node-maintenance-runtime.json");
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const { FuseV1Options, FuseVersion, getCurrentFuseWire } = builderRequire("@electron/fuses");

const linuxFuses = Object.freeze({
	runAsNode: false,
	enableNodeOptionsEnvironmentVariable: false,
	enableNodeCliInspectArguments: false,
	onlyLoadAppFromAsar: true,
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function linuxPackagingOptions(root, platform = process.platform) {
	if (platform !== "linux") return {};
	return {
		electronFuses: linuxFuses,
		extraResources: [{ from: path.join(root, ".artifacts/hipi-work/maintenance-runtime"), to: "maintenance-runtime" }],
		extraFiles: [{ from: path.join(__dirname, "hipi-work-maintenance"), to: "hipi-work-maintenance" }],
	};
}

function assertRuntimeTarget(platform, architecture) {
	assert.equal(platform, pin.platform, "Maintenance runtime platform has not been reviewed");
	assert.equal(architecture, pin.architecture, "Maintenance runtime architecture has not been reviewed");
}

async function regularBytes(file, mode) {
	const info = await lstat(file);
	assert.ok(info.isFile() && info.nlink === 1, `Expected unlinked regular file: ${file}`);
	if (mode !== undefined) assert.equal(info.mode & 0o7777, mode, `Unexpected file mode: ${file}`);
	return readFile(file);
}

async function runtimeInventory(directory, prefix = "") {
	assert.ok((await lstat(path.join(directory, prefix))).isDirectory(), "Maintenance runtime directory must not be a symlink");
	const result = [];
	for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
		const file = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) result.push(...await runtimeInventory(directory, file));
		else {
			assert.ok(entry.isFile(), `Unexpected maintenance runtime entry: ${file}`);
			result.push(file);
		}
	}
	return result.sort();
}

async function verifyMaintenanceRuntime(directory) {
	assert.deepEqual(await runtimeInventory(directory), [...pin.files.map((item) => item.file), "provenance.json"].sort(), "Unexpected maintenance runtime payload");
	const provenance = JSON.parse(await regularBytes(path.join(directory, "provenance.json"), 0o644));
	assert.deepEqual(provenance, { schemaVersion: 1, ...pin }, "Maintenance runtime provenance differs from reviewed pin");
	for (const item of pin.files) {
		assert.equal(digest(await regularBytes(path.join(directory, item.file), item.mode)), item.sha256, `Maintenance runtime digest: ${item.file}`);
	}
	return provenance;
}

async function prepareMaintenanceRuntime(archive, destination) {
	assert.equal(digest(await regularBytes(archive)), pin.sha256, "Official Node archive digest mismatch");
	await mkdir(path.dirname(destination), { recursive: true });
	const temporary = await mkdtemp(path.join(path.dirname(destination), ".maintenance-runtime-"));
	try {
		for (const item of pin.files) {
			// Extract only exact members of the already authenticated official archive
			// to stdout, never let archive paths or links write into our filesystem.
			const bytes = execFileSync("/usr/bin/tar", ["-xJOf", archive, `node-v${pin.version}-${pin.platform}-${pin.architecture}/${item.file}`], {
				timeout: 60_000, maxBuffer: 160 * 1024 * 1024,
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
			});
			assert.equal(digest(bytes), item.sha256, `Official Node member digest: ${item.file}`);
			const target = path.join(temporary, item.file);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, bytes, { flag: "wx", mode: item.mode });
			await chmod(target, item.mode);
		}
		await writeFile(path.join(temporary, "provenance.json"), `${JSON.stringify({ schemaVersion: 1, ...pin }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
		await verifyMaintenanceRuntime(temporary);
		// Do not overwrite an existing preparation. Identical re-runs are idempotent;
		// an altered existing tree needs deliberate cleanup rather than silent repair.
		try { await lstat(destination); }
		catch (error) {
			if (error.code !== "ENOENT") throw error;
			await rename(temporary, destination);
			return verifyMaintenanceRuntime(destination);
		}
		return verifyMaintenanceRuntime(destination);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

async function verifyLinuxFuses(binary) {
	await regularBytes(binary, 0o755);
	const wire = await getCurrentFuseWire(binary);
	assert.equal(wire.version, FuseVersion.V1, "Unknown Electron fuse wire");
	for (const [name, expected] of [
		["RunAsNode", false], ["EnableNodeOptionsEnvironmentVariable", false],
		["EnableNodeCliInspectArguments", false], ["OnlyLoadAppFromAsar", true],
	]) assert.equal(wire[FuseV1Options[name]], expected ? 49 : 48, `Unsafe Linux Electron fuse: ${name}`);
	return { ...linuxFuses };
}

async function verifyLinuxMaintenancePackage(directory) {
	const runtime = await verifyMaintenanceRuntime(path.join(directory, "resources/maintenance-runtime"));
	const launcher = await regularBytes(path.join(directory, "hipi-work-maintenance"), 0o755);
	assert.deepEqual(launcher, await readFile(path.join(__dirname, "hipi-work-maintenance")), "Unreviewed maintenance launcher");
	return { runtime, launcherSha256: digest(launcher) };
}

module.exports = { assertRuntimeTarget, linuxFuses, linuxPackagingOptions, pin, prepareMaintenanceRuntime, verifyLinuxFuses, verifyLinuxMaintenancePackage, verifyMaintenanceRuntime };
