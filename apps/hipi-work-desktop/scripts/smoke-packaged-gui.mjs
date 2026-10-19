import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, endpoint, pageTarget } from "./cdp.mjs";
import { evaluate, exercise, until } from "./gui-flow.mjs";
import { assertNoPackageProcesses, debuggerClosed, startProcess } from "./gui-process.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.argv.length, 2, "Usage: node apps/hipi-work-desktop/scripts/smoke-packaged-gui.mjs");
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
const packages = join(root, ".artifacts/hipi-work/packages");
const provenanceBytes = await readFile(join(packages, "release-provenance.json"));
const provenance = JSON.parse(provenanceBytes.toString("utf8"));
assert.equal(provenance.platform, process.platform);
assert.equal(provenance.architecture, process.arch);
assert.equal(hash(JSON.stringify(provenance.sourceSnapshot)), provenance.sourceSnapshotSha256);
// Do not run against a pre-isolation package, which would silently ignore the testing flag.
for (const name of ["smoke-profile.ts", "main.ts", "provider-mode.ts"]) {
	const file = `apps/hipi-work-desktop/src/${name}`;
	assert.equal(
		provenance.sourceSnapshot.find((item) => item.file === file)?.sha256,
		hash(await readFile(join(root, file))),
		"Package must contain the reviewed launch isolation change",
	);
}
const mainSource = await readFile(join(root, "apps/hipi-work-desktop/src/main.ts"), "utf8");
assert.match(
	mainSource,
	/prepareDesktopLaunch\(app,\s*process\.argv\)/,
	"Packaged main must invoke the reviewed launch boundary",
);
assert.ok(!mainSource.includes("app.requestSingleInstanceLock("), "Main must not bypass the reviewed launch boundary");
const key = { linux: "linux", darwin: "mac", win32: "win" }[process.platform];
assert.ok(key && ["x64", "arm64"].includes(process.arch));
const unpacked = `${key}${process.arch === "x64" ? "" : `-${process.arch}`}${key === "mac" ? "" : "-unpacked"}`;
const sourceApp = join(packages, unpacked, ...(key === "mac" ? ["Hipi Work.app"] : []));
async function size(directory) {
	let bytes = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) bytes += await size(path);
		else if (entry.isFile()) bytes += (await lstat(path)).size;
		else assert.ok(entry.isSymbolicLink());
	}
	return bytes;
}
const temporaryParent = await realpath(tmpdir());
const delta = relative(root, temporaryParent);
assert.ok(delta.startsWith("..") || isAbsolute(delta));
const fs = await statfs(temporaryParent);
assert.ok(
	fs.bavail * fs.bsize > (await size(sourceApp)) * 2 + 512 * 1024 * 1024,
	"Insufficient GUI smoke disk reserve",
);
const owned = await realpath(await mkdtemp(join(temporaryParent, "Hipi GUI 中文 验证-")));
const profile = await realpath(await mkdtemp(join(temporaryParent, "Hipi GUI profile-")));
const appDirectory = join(owned, key === "mac" ? "真实 应用.app" : "真实 应用");
const artifacts = join(owned, "evidence");
const evidence = {
	schemaVersion: 1,
	status: "running",
	platform: process.platform,
	architecture: process.arch,
	osRelease: release(),
	hostNode: process.version,
	electron: provenance.electron,
	startedAt: new Date().toISOString(),
	sourceSnapshotSha256: provenance.sourceSnapshotSha256,
	releaseProvenanceSha256: hash(provenanceBytes),
	harnessSha256: hash(await readFile(fileURLToPath(import.meta.url))),
	visualReview: "not_run; screenshots require inspection",
	checks: [],
	errors: [],
	artifacts: [],
	notValidated: [
		"installation",
		"signing/notarization",
		"real model",
		"keychain",
		"physical IME",
		"accessibility",
		"power-loss",
		"updates",
	],
};
let native;
let xvfb;
let page;
let browser;
let safeCleanup = false;
let messageKeys;
try {
	await mkdir(artifacts);
	await cp(sourceApp, appDirectory, { recursive: true, verbatimSymlinks: true });
	const binary = join(
		appDirectory,
		{ linux: "hipi-work", win32: "Hipi Work.exe", darwin: "Contents/MacOS/Hipi Work" }[process.platform],
	);
	const resources = join(appDirectory, key === "mac" ? "Contents/Resources" : "resources");
	evidence.binarySha256 = hash(await readFile(binary));
	evidence.asarSha256 = hash(await readFile(join(resources, "app.asar")));
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) =>
			/^(PATH|SYSTEMROOT|WINDIR|TMP|TEMP|TMPDIR|LANG|LC_ALL)$/i.test(name),
		),
	);
	for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
		env[name] = join(owned, name);
		await mkdir(env[name]);
	}
	if (process.platform === "linux") {
		assert.notEqual(process.getuid(), 0, "Sandboxed GUI smoke must not run as root");
		// Xvfb selects a free display and reports it on stdout. No system configuration changes.
		xvfb = startProcess("Xvfb", ["-displayfd", "1", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], {
			cwd: owned,
			env,
		});
		const display = await until(
			() => {
				assert.ok(!xvfb.closed, "Xvfb unavailable or failed");
				return xvfb.output.match(/(?:^|\n)(\d+)\s*(?:\n|$)/)?.[1];
			},
			"Xvfb display",
			15000,
		);
		env.DISPLAY = `:${display}`;
	}
	for (let iteration = 0; iteration < 2; iteration++) {
		const portFile = join(profile, "session/DevToolsActivePort");
		// This exact generated file is inside the harness-owned profile, after previous clean exit.
		await rm(portFile, { force: true });
		native = startProcess(
			binary,
			[
				"--provider=deterministic",
				`--smoke-data-root=${profile}`,
				`--user-data-dir=${join(profile, "profile")}`,
				"--remote-debugging-port=0",
			],
			{ cwd: owned, env },
		);
		const connection = await until(
			async () => {
				assert.ok(!native.closed, "Application exited before renderer readiness");
				assert.ok(!native.overflow, "Application logging overflow");
				let value;
				try {
					value = await readFile(portFile, "utf8");
				} catch (error) {
					if (error.code === "ENOENT") return;
					throw error;
				}
				const [rawPort, path] = value.trim().split(/\r?\n/);
				if (!/^\d+$/.test(rawPort) || !path) return;
				const port = Number(rawPort);
				return { port, browser: endpoint(`ws://127.0.0.1:${port}${path}`, port, "browser") };
			},
			"private DevToolsActivePort",
			30000,
		);
		browser = await Cdp.connect(connection.browser, connection.port, "browser");
		const target = await until(() => pageTarget(connection.port), "packaged application target");
		const catalog = join(profile, "profile/deterministic-store/catalog.sqlite");
		assert.equal(await realpath(catalog), catalog, "Runtime store escaped owned profile");
		assert.ok((await lstat(catalog)).isFile(), "No actual runtime database in smoke profile");
		const storeOwner = join(profile, "profile/deterministic-store/store-owner.sqlite");
		assert.equal(await realpath(storeOwner), storeOwner, "Store owner database escaped owned profile");
		assert.ok((await lstat(storeOwner)).isFile());
		assert.equal(await realpath(portFile), portFile, "Debugging endpoint escaped owned session");
		evidence.checks.push({ iteration, ownedRuntimeDatabase: true, ownedSessionEndpoint: true });
		page = await Cdp.connect(target, connection.port);
		assert.ok((await evaluate(page, "navigator.userAgent")).includes(`Electron/${provenance.electron}`));
		page.onEvent((method, params) => {
			if (
				method === "Runtime.exceptionThrown" ||
				method === "Inspector.targetCrashed" ||
				(method === "Runtime.consoleAPICalled" && params.type === "error") ||
				(method === "Log.entryAdded" && params.entry.level === "error")
			) {
				if (evidence.errors.length >= 50) throw new Error("Renderer error log overflow");
				evidence.errors.push({ iteration, method, detail: JSON.stringify(params).slice(0, 2000) });
			}
		});
		const flow = await exercise(page, artifacts, iteration === 1);
		if (iteration === 0) messageKeys = flow.messageKeys;
		else assert.deepEqual(flow.messageKeys, messageKeys, "Restart duplicated or replaced persisted messages");
		const storeRoot = join(profile, "profile/deterministic-store");
		const workspaces = (await readdir(storeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
		assert.equal(workspaces.length, 1, "Expected exactly one UI-created workspace");
		for (const database of ["owner.sqlite", "workspace.sqlite"]) {
			const path = join(storeRoot, workspaces[0].name, database);
			assert.equal(await realpath(path), path, "Workspace database escaped owned profile");
			assert.ok((await lstat(path)).isFile());
		}
		evidence.checks.push({ iteration, ownedWorkspaceDatabases: true });
		evidence.checks.push({ iteration, flow });
		assert.equal(evidence.errors.length, 0, "Renderer reported errors");
		browser.requestQuit();
		const exit = await native.wait();
		assert.equal(exit.code, 0, "Application shutdown was not clean");
		assert.equal(exit.signal, null);
		await until(() => debuggerClosed(connection.port), "private debugging listener closed", 5000);
		page.close();
		browser.close();
		page = undefined;
		browser = undefined;
		await assertNoPackageProcesses(appDirectory);
		await writeFile(
			join(artifacts, `native-${iteration}.log`),
			native.output
				.replaceAll(owned, "<temporary>")
				.replaceAll(profile, "<profile>")
				.replace(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/[^\s]+/g, "<private-debugger>"),
		);
		evidence.checks.push({ iteration, cleanExit: true });
		native = undefined;
	}
	await xvfb?.terminate();
	xvfb = undefined;
	safeCleanup = true;
	evidence.status = "passed";
} catch (error) {
	evidence.status = "failed";
	evidence.failure = error.message;
	page?.close();
	browser?.close();
	try {
		const stopped = await Promise.allSettled([native?.terminate(), xvfb?.terminate()]);
		assert.ok(
			stopped.every((result) => result.status === "fulfilled"),
			"A native process could not be terminated",
		);
		await assertNoPackageProcesses(appDirectory);
		safeCleanup = true;
	} catch (cleanupError) {
		evidence.cleanupFailure = cleanupError.message;
	}
	if (native)
		await writeFile(
			join(artifacts, "failure-native.log"),
			native.output
				.replaceAll(owned, "<temporary>")
				.replaceAll(profile, "<profile>")
				.replace(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/[^\s]+/g, "<private-debugger>"),
		);
	process.exitCode = 1;
} finally {
	evidence.finishedAt = new Date().toISOString();
	evidence.cleanup = safeCleanup
		? "confirmed processes stopped"
		: "retained owned directories: process exit unconfirmed";
	const destination = join(packages, "gui-smoke");
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(artifacts)) {
		const bytes = await readFile(join(artifacts, entry));
		await writeFile(join(destination, entry), bytes);
		evidence.artifacts.push({ file: entry, bytes: bytes.length, sha256: hash(bytes) });
	}
	await writeFile(join(destination, "packaged-gui-smoke.json"), `${JSON.stringify(evidence, null, 2)}\n`);
	if (safeCleanup) {
		await rm(owned, { recursive: true, force: true, maxRetries: 3 });
		await rm(profile, { recursive: true, force: true, maxRetries: 3 });
	}
}
console.log(`Packaged GUI smoke: ${evidence.status}. This does not establish full native RC acceptance.`);
