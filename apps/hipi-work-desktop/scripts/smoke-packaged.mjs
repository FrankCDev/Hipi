import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brandIconSha256, inventory, sha256 } from "./release-policy.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = await realpath(resolve(scripts, "../../.."));
const output = join(root, ".artifacts/hipi-work/packages");
assert.equal(process.argv.length, 2, "This smoke accepts no overrides or cross-platform shortcuts");
assert.ok(["x64", "arm64"].includes(process.arch), "Unsupported host architecture");
const platformKey = { linux: "linux", win32: "win", darwin: "mac" }[process.platform];
assert.ok(platformKey, "Unsupported host OS");
// electron-builder 26.15.3 PlatformPackager.computeAppOutDir: x64 is the default suffix.
const unpacked = `${platformKey}${process.arch === "x64" ? "" : `-${process.arch}`}${process.platform === "darwin" ? "" : "-unpacked"}`;
const sourceApp = join(output, unpacked, ...(process.platform === "darwin" ? ["Hipi Work.app"] : []));
const binaryRelative = { linux: "hipi-work", win32: "Hipi Work.exe", darwin: "Contents/MacOS/Hipi Work" }[
	process.platform
];
const resourcesRelative = process.platform === "darwin" ? "Contents/Resources" : "resources";
const provenanceBytes = await readFile(join(output, "release-provenance.json"));
const provenance = JSON.parse(provenanceBytes.toString("utf8"));
assert.equal(provenance.platform, process.platform);
assert.equal(provenance.architecture, process.arch);
assert.equal(sha256(JSON.stringify(provenance.sourceSnapshot)), provenance.sourceSnapshotSha256);
// Source fixture must use the same source modules and lock as the packaged build.
for (const entry of provenance.sourceSnapshot) {
	if (entry.file.startsWith("packages/") || entry.file === "package-lock.json") {
		assert.equal(sha256(await readFile(join(root, entry.file))), entry.sha256, `Stale fixture source: ${entry.file}`);
	}
}

async function treeBytes(directory) {
	let bytes = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) bytes += await treeBytes(path);
		else if (entry.isFile()) bytes += (await lstat(path)).size;
		else assert.ok(entry.isSymbolicLink(), "Unexpected package filesystem entry");
	}
	return bytes;
}

const tempParent = await realpath(tmpdir());
const delta = relative(root, tempParent);
assert.ok(delta.startsWith("..") || isAbsolute(delta), "Smoke temporary directory must be outside checkout");
const packageBytes = await treeBytes(sourceApp);
const free = await statfs(tempParent);
const requiredBytes = packageBytes * 2 + 256 * 1024 * 1024;
assert.ok(free.bavail * free.bsize > requiredBytes, "Insufficient space for relocated package plus fixture reserve");
const temporary = await realpath(await mkdtemp(join(tempParent, "Hipi 打包 验证-")));
const evidence = {
	schemaVersion: 1,
	status: "running",
	startedAt: new Date().toISOString(),
	platform: process.platform,
	architecture: process.arch,
	osRelease: release(),
	hostNode: process.version,
	sourceSnapshotSha256: provenance.sourceSnapshotSha256,
	releaseProvenanceSha256: sha256(provenanceBytes),
	smokeScriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
	fixtureScriptSha256: sha256(await readFile(join(scripts, "smoke-packaged-fixture.mjs"))),
	builtinsScriptSha256: sha256(await readFile(join(scripts, "smoke-packaged-builtins.mjs"))),
	packageBytes,
	checks: [],
	notValidated: [
		"GUI",
		"utilityProcess lifecycle",
		"keychain",
		"installation",
		"signing/notarization",
		"updates",
		"power-loss recovery",
	],
};
const active = new Set();
const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR)$/i.test(key)),
);
Object.assign(env, { HOME: temporary, USERPROFILE: temporary, TMP: temporary, TEMP: temporary, TMPDIR: temporary });

function run(binary, args, electron = false) {
	return new Promise((resolveRun, reject) => {
		let failure;
		let result;
		// Do not reject on timeout: wait for close, so cleanup never races a live child or worker.
		const child = execFile(
			binary,
			args,
			{
				cwd: temporary,
				env: electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
				encoding: "utf8",
				maxBuffer: 2 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				failure ??= error;
				result = { stdout, stderr };
			},
		);
		active.add(child);
		const timeout = setTimeout(() => {
			failure = new Error(`Smoke child timed out: ${args[0]}`);
			child.kill("SIGKILL");
		}, 60000);
		child.once("close", () => {
			clearTimeout(timeout);
			active.delete(child);
			if (failure) reject(new Error(`${failure.message}\n${result?.stderr ?? ""}`));
			else resolveRun(result.stdout);
		});
	});
}

try {
	const app = join(temporary, process.platform === "darwin" ? "搬迁 应用.app" : "搬迁 应用");
	await cp(sourceApp, app, { recursive: true, verbatimSymlinks: true });
	const binary = join(app, binaryRelative);
	const resources = join(app, resourcesRelative);
	const entry = join(resources, "app.asar.unpacked/dist/maintenance.mjs");
	evidence.binarySha256 = sha256(await readFile(binary));
	evidence.asarSha256 = sha256(await readFile(join(resources, "app.asar")));
	evidence.maintenanceSha256 = sha256(await readFile(entry));
	assert.equal(
		evidence.maintenanceSha256,
		provenance.payload.find((item) => item.file === "dist/maintenance.mjs")?.sha256,
	);
	const probe = join(temporary, "内置 验证.mjs");
	await cp(join(scripts, "smoke-packaged-builtins.mjs"), probe);
	evidence.runtime = JSON.parse(await run(binary, [probe, resources, brandIconSha256], true));
	assert.equal(evidence.runtime.electron, provenance.electron);
	assert.equal(evidence.runtime.sourceSnapshotSha256, provenance.sourceSnapshotSha256);
	assert.equal(evidence.runtime.platform, process.platform);
	assert.equal(evidence.runtime.architecture, process.arch);
	evidence.checks.push("relocated packaged Electron", "SQLite", "parser worker", "icon digest");
	assert.match(await run(binary, [entry, "--help"], true), /offline store maintenance/);
	evidence.checks.push("maintenance --help");
	const source = join(temporary, "原 工作库");
	const fixture = JSON.parse(
		await run(process.execPath, ["--conditions=source", join(scripts, "smoke-packaged-fixture.mjs"), source]),
	);
	assert.equal(fixture.execution, "done");
	evidence.fixture = fixture;
	const backup = join(temporary, "新 备份");
	const archive = join(temporary, "历史 档案");
	const destination = join(temporary, "历史 导出.ndjson");
	const execute = async (args) => {
		const value = JSON.parse(await run(binary, [entry, ...args], true));
		assert.equal(value.ok, true);
		assert.equal(value.command, args[0]);
		evidence.checks.push(args[0]);
		return value.result;
	};
	const backedUp = await execute(["backup", "--source", source, "--destination", backup]);
	const verified = await execute(["verify", "--backup", backup]);
	assert.equal(verified.verified, true);
	assert.equal(verified.manifestDigest, backedUp.manifestDigest);
	assert.equal(verified.workspaceCount, 1);
	await execute(["restore", "--backup", backup, "--destination", archive]);
	const beforeReads = await inventory(archive);
	const info = await execute(["inspect", "--archive", archive]);
	assert.equal(info.readOnly, true);
	assert.equal(info.mode, "recovery_archive");
	assert.equal(info.backupId, backedUp.backupId);
	await execute(["workspaces", "--archive", archive]);
	await execute(["conversations", "--archive", archive, "--workspace", "work"]);
	const scope = ["--archive", archive, "--workspace", "work", "--conversation", fixture.conversationId];
	const history = await execute(["history", ...scope]);
	assert.match(JSON.stringify(history), /Packaged maintenance fixture 中文原文/);
	const activities = await execute(["activities", ...scope]);
	assert.equal(activities.readOnly, true);
	assert.equal(activities.evidence, "snapshot_only");
	const exported = await execute(["export-history", ...scope, "--output", destination]);
	const exportBytes = await readFile(destination);
	const lines = exportBytes
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(lines[0].type, "snapshot");
	assert.equal(lines[0].readOnly, true);
	assert.match(lines[0].warning, /Historical snapshot only/);
	assert.equal(lines.at(-1).type, "complete");
	assert.equal(lines.at(-1).messages, exported.messages);
	assert.ok(exported.messages >= 2);
	assert.match(exportBytes.toString("utf8"), /Packaged maintenance fixture 中文原文/);
	assert.deepEqual(await inventory(archive), beforeReads, "Read-only archive changed");
	evidence.checks.push(
		"snapshot-only metadata",
		"Chinese text round-trip",
		"complete export",
		"unchanged archive hashes",
	);
	evidence.exportSha256 = sha256(exportBytes);
	evidence.status = "passed";
} catch (error) {
	evidence.status = "failed";
	evidence.error = error.message;
	throw error;
} finally {
	assert.equal(active.size, 0, "Refusing cleanup while child processes remain alive");
	await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
	evidence.finishedAt = new Date().toISOString();
	await mkdir(output, { recursive: true });
	await writeFile(join(output, "packaged-smoke.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(
	"Relocated packaged Electron Node-mode smoke passed. Native GUI, installation and recovery gates remain pending.",
);
