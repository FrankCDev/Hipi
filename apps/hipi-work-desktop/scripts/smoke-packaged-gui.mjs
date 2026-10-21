import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, endpoint, pageTarget } from "./cdp.mjs";
import { sidebarWorkspaceIds } from "./gui/sidebar/manifest.mjs";
import { virtualizationWorkspaceIds } from "./gui/sidebar/virtualization-manifest.mjs";
import { runBetweenGuiSessions } from "./gui-between-runs.mjs";
import { fileFixture } from "./gui-file-fixture-data.mjs";
import { captureFailure, evaluate, exercise, until } from "./gui-flow.mjs";
import {
	readNativeLog,
	recordGuiFailure,
	recordRendererError,
	redactNativeLog,
	withNativeLogBudget,
} from "./gui-native-log.mjs";
import { assertNoPackageProcesses, debuggerClosed, startProcess } from "./gui-process.mjs";
import { profileEvidence, profileRootEvidence } from "./gui-profile-evidence.mjs";
import { captureWindowsIdentity, readWindowsDialogs } from "./gui-windows-dialogs.mjs";
import { createSidebarPolicy } from "./linux-sidebar-policy.mjs";
import { assertSourceSnapshot } from "./release-policy.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Existing void validators pass; incomplete host evidence must never become passed. */
export function guiAcceptanceResult(result) {
	if (result === undefined) return { status: "passed" };
	assert.ok(result && typeof result === "object", "Invalid GUI acceptance result");
	assert.ok(["passed", "unqualified"].includes(result.status), "Invalid GUI acceptance status");
	if (result.status === "passed") return { status: "passed" };
	assert.ok(typeof result.reason === "string" && result.reason.trim(), "Unqualified acceptance needs a reason");
	assert.ok(
		Array.isArray(result.missing) &&
			result.missing.length > 0 &&
			result.missing.every((item) => typeof item === "string" && item.trim()),
		"Unqualified acceptance needs missing evidence",
	);
	return { status: "unqualified", reason: result.reason, missing: [...result.missing] };
}
export function baselineResponseArguments(scenario) {
	assert.ok(
		["baseline", "long-history", "file-workbench", "sidebar", "sidebar-virtualization"].includes(scenario),
		"Unknown fixed GUI scenario",
	);
	return scenario === "baseline" ? ["--smoke-response=baseline-stream", "--smoke-scenario=baseline"] : [];
}
export async function createGuiProfile(temporaryParent = realpathSync(tmpdir())) {
	// Match smokeProfile's exact canonicalizer, including Windows path spelling.
	return realpathSync(await mkdtemp(join(temporaryParent, "Hipi GUI profile-")));
}
export function sourceProvenanceEvidence(provenance) {
	const sourceSnapshot = provenance.sourceSnapshot.map(({ file, sha256 }) => ({ file, sha256 }));
	assert.equal(hash(JSON.stringify(sourceSnapshot)), provenance.sourceSnapshotSha256);
	return { sourceSnapshotSha256: provenance.sourceSnapshotSha256, sourceSnapshot };
}
export async function assertScenarioWorkspaceDatabases(storeRoot, scenario, bindingWorkspaceId) {
	assert.ok(["baseline", "long-history", "file-workbench", "sidebar", "sidebar-virtualization"].includes(scenario));
	const workspaces = (await readdir(storeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	assert.equal(
		workspaces.length,
		scenario === "sidebar-virtualization"
			? 7
			: scenario === "long-history"
				? 1
				: ["file-workbench", "sidebar"].includes(scenario)
					? 3
					: 2,
		"Unexpected exact scenario workspace count",
	);
	if (scenario === "sidebar-virtualization")
		assert.deepEqual(
			workspaces.map((workspace) => workspace.name).sort(),
			[...virtualizationWorkspaceIds].sort(),
			"Virtual Recent must retain all seven exact fixture database identities",
		);
	if (scenario === "sidebar")
		assert.deepEqual(
			workspaces.map((workspace) => workspace.name).sort(),
			[...sidebarWorkspaceIds].sort(),
			"Sidebar must retain exact default and two project databases",
		);
	if (scenario === "file-workbench") {
		assert.ok(
			typeof bindingWorkspaceId === "string" && workspaces.some((workspace) => workspace.name === bindingWorkspaceId),
			"Native-created binding project database identity is missing",
		);
		assert.deepEqual(
			workspaces.map((workspace) => workspace.name).sort(),
			[fileFixture.workspaceId, fileFixture.otherWorkspaceId, bindingWorkspaceId].sort(),
			"File scenario must retain exact A/B and native-created binding database identities",
		);
	}
	for (const workspace of workspaces) {
		for (const database of ["owner.sqlite", "workspace.sqlite"]) {
			const path = join(storeRoot, workspace.name, database);
			assert.equal(realpathSync(path), path, "Workspace database escaped owned profile");
			assert.ok((await lstat(path)).isFile());
		}
	}
}
/** One lifecycle owns launch, evidence and cleanup for each independent private profile. */
export async function runPackagedGui({ scenario = "baseline", prepare, run, verify, validate, betweenRuns } = {}) {
	assert.ok(
		["baseline", "long-history", "file-workbench", "sidebar", "sidebar-virtualization"].includes(scenario),
		"Unknown fixed GUI scenario",
	);
	assert.ok(betweenRuns === undefined || typeof betweenRuns === "function", "Invalid between-runs callback");
	assert.ok(!betweenRuns || scenario === "baseline", "Maintenance hook requires the unchanged baseline GUI flow");
	const reportScenario = betweenRuns ? "maintenance" : scenario;
	assert.equal(
		scenario !== "baseline",
		typeof prepare === "function" && typeof run === "function" && typeof verify === "function",
	);
	assert.equal(process.argv.length, 2, "Usage: node apps/hipi-work-desktop/scripts/smoke-packaged-gui.mjs");
	const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
	const packages = join(root, ".artifacts/hipi-work/packages");
	const provenanceBytes = await readFile(join(packages, "release-provenance.json"));
	const provenance = JSON.parse(provenanceBytes.toString("utf8"));
	assert.equal(provenance.platform, process.platform);
	assert.equal(provenance.architecture, process.arch);
	const sourceEvidence = sourceProvenanceEvidence(provenance);
	await assertSourceSnapshot(root, provenance.sourceSnapshot);
	// Do not run against a pre-isolation package, which would silently ignore the testing flag.
	for (const name of ["launch/profile.ts", "main.ts", "launch/provider-mode.ts"]) {
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
	assert.ok(
		!mainSource.includes("app.requestSingleInstanceLock("),
		"Main must not bypass the reviewed launch boundary",
	);
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
	const temporaryParent = realpathSync(tmpdir());
	const delta = relative(root, temporaryParent);
	assert.ok(delta.startsWith("..") || isAbsolute(delta));
	const fs = await statfs(temporaryParent);
	assert.ok(
		fs.bavail * fs.bsize > (await size(sourceApp)) * 2 + 512 * 1024 * 1024,
		"Insufficient GUI smoke disk reserve",
	);
	const owned = realpathSync(await mkdtemp(join(temporaryParent, "Hipi GUI 中文 验证-")));
	const profile = await createGuiProfile(temporaryParent);
	const appDirectory = join(owned, key === "mac" ? "真实 应用.app" : "真实 应用");
	const artifacts = join(owned, "evidence");
	const nativeLogs = join(owned, "native-diagnostics");
	const evidence = {
		schemaVersion: 1,
		scenario: reportScenario,
		status: "running",
		platform: process.platform,
		architecture: process.arch,
		osRelease: release(),
		hostNode: process.version,
		electron: provenance.electron,
		startedAt: new Date().toISOString(),
		...sourceEvidence,
		releaseProvenanceSha256: hash(provenanceBytes),
		harnessSha256: hash(await readFile(fileURLToPath(import.meta.url))),
		visualReview: "not_run; screenshots require inspection",
		checks: [],
		fontObservations: [],
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
	let sidebarPolicy;
	let native;
	let windowsIdentity;
	let xvfb;
	let page;
	let browser;
	let safeCleanup = false;
	let messageKeys;
	let toolPackScope;
	let seed;
	let firstFlow;
	let reopenedFlow;
	// Failed fixture closure must retain the profile even if native processes are absent.
	let scenarioResourcesClosed = true;
	const betweenRunsLifecycle = { resourcesClosed: true };
	try {
		await mkdir(artifacts);
		await mkdir(nativeLogs);
		await cp(sourceApp, appDirectory, { recursive: true, verbatimSymlinks: true });
		const binary = join(
			appDirectory,
			{ linux: "hipi-work", win32: "Hipi Work.exe", darwin: "Contents/MacOS/Hipi Work" }[process.platform],
		);
		sidebarPolicy = createSidebarPolicy({ owned, binary, scenario });
		evidence.linuxSidebarPolicy = sidebarPolicy.evidence;
		await sidebarPolicy.setup();
		const resources = join(appDirectory, key === "mac" ? "Contents/Resources" : "resources");
		evidence.binarySha256 = hash(await readFile(binary));
		evidence.asarSha256 = hash(await readFile(join(resources, "app.asar")));
		if (prepare) {
			scenarioResourcesClosed = false;
			seed = await prepare({
				ownedProfileRoot: profile,
				assertAllOwnedProcessesExited: () => assertNoPackageProcesses(appDirectory),
			});
			scenarioResourcesClosed = true;
			evidence.seed = seed;
		}
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
			const spawnedAt = Date.now();
			native = startProcess(
				binary,
				[
					"--provider=deterministic",
					`--smoke-data-root=${profile}`,
					...baselineResponseArguments(scenario),
					`--user-data-dir=${join(profile, "profile")}`,
					"--remote-debugging-port=0",
					"--enable-logging=file",
					`--log-file=${join(nativeLogs, `chromium-${iteration}.log`)}`,
				],
				{ cwd: owned, env },
			);
			windowsIdentity = await captureWindowsIdentity({ pid: native.child.pid, binary, spawnedAt });
			const connection = await until(
				async () => {
					assert.equal(
						(await readNativeLog(nativeLogs, iteration, [owned, profile])).overflow,
						false,
						"Native file logging exceeded 1 MiB",
					);
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
			await sidebarPolicy.assertAttached(native.child.pid, iteration);
			browser = await Cdp.connect(connection.browser, connection.port, "browser");
			const target = await until(() => pageTarget(connection.port), "packaged application target");
			const catalog = join(profile, "profile/deterministic-store/catalog.sqlite");
			assert.equal(realpathSync(catalog), catalog, "Runtime store escaped owned profile");
			assert.ok((await lstat(catalog)).isFile(), "No actual runtime database in smoke profile");
			const storeOwner = join(profile, "profile/deterministic-store/store-owner.sqlite");
			assert.equal(realpathSync(storeOwner), storeOwner, "Store owner database escaped owned profile");
			assert.ok((await lstat(storeOwner)).isFile());
			assert.equal(realpathSync(portFile), portFile, "Debugging endpoint escaped owned session");
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
					recordRendererError(evidence, iteration, method, params, [owned, profile]);
				}
			});
			const fontObservations = [];
			evidence.fontObservations.push({ iteration, targets: fontObservations });
			const flow = await withNativeLogBudget(
				() =>
					run
						? run({
								cdp: page,
								directory: artifacts,
								reopened: iteration === 1,
								seed,
								previous: firstFlow,
								fontObservations,
								nativeContext: {
									pid: native.child.pid,
									display: env.DISPLAY,
									xvfbPid: xvfb?.child.pid,
									ownedProfileRoot: profile,
									binary,
								},
								record: (observation) => evidence.checks.push({ iteration, observation }),
							})
						: exercise(page, artifacts, iteration === 1, fontObservations),
				() => readNativeLog(nativeLogs, iteration, [owned, profile]),
			);
			if (iteration === 0) firstFlow = flow;
			else reopenedFlow = flow;
			if (scenario === "baseline" && iteration === 0) {
				messageKeys = flow.messageKeys;
				toolPackScope = flow.toolPacks.scope;
			} else if (scenario === "baseline") {
				assert.deepEqual(flow.messageKeys, messageKeys, "Restart duplicated or replaced persisted messages");
				assert.deepEqual(flow.toolPacks.scope, toolPackScope, "Restart changed tool-pack scope");
			}
			const storeRoot = join(profile, "profile/deterministic-store");
			await assertScenarioWorkspaceDatabases(storeRoot, scenario, flow.projectBinding?.workspaceId);
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
			await writeFile(join(artifacts, `native-${iteration}.log`), redactNativeLog(native.output, [owned, profile]));
			evidence.checks.push({ iteration, cleanExit: true });
			native = undefined;
			windowsIdentity = undefined;
			if (iteration === 0 && betweenRuns) {
				evidence.betweenRuns = await runBetweenGuiSessions(
					betweenRuns,
					{
						ownedProfileRoot: profile,
						ownedApplicationRoot: appDirectory,
						ownedScratchRoot: owned,
						firstFlow,
						releaseProvenance: provenance,
						assertAllOwnedProcessesExited: () => assertNoPackageProcesses(appDirectory),
					},
					betweenRunsLifecycle,
				);
			}
		}
		if (verify) {
			scenarioResourcesClosed = false;
			evidence.coldVerification = await verify({
				ownedProfileRoot: profile,
				seed,
				gui: firstFlow,
				assertAllOwnedProcessesExited: () => assertNoPackageProcesses(appDirectory),
			});
			scenarioResourcesClosed = true;
		}
		const acceptance = guiAcceptanceResult(validate?.({ first: firstFlow, reopened: reopenedFlow }));
		await xvfb?.terminate();
		xvfb = undefined;
		safeCleanup = true;
		await assertSourceSnapshot(root, provenance.sourceSnapshot);
		evidence.acceptance = acceptance;
		evidence.status = acceptance.status;
		if (acceptance.status === "unqualified") process.exitCode = 1;
	} catch (error) {
		evidence.status = "failed";
		if (native) evidence.nativeProcessAtFailure = { exited: native.exited, closed: native.closed };
		recordGuiFailure(evidence, "failure", error, [owned, profile]);
		if (native && !native.closed && native.child.exitCode === null && native.child.signalCode === null) {
			evidence.windowsDialogs = await readWindowsDialogs(windowsIdentity);
		}
		evidence.profileMetadata = await profileEvidence(profile);
		evidence.profileRootMetadata = await profileRootEvidence(profile);
		if (page) evidence.failureCapture = await captureFailure(page, artifacts);
		page?.close();
		browser?.close();
		try {
			const stopped = await Promise.allSettled([native?.terminate(), xvfb?.terminate()]);
			assert.ok(
				stopped.every((result) => result.status === "fulfilled"),
				"A native process could not be terminated",
			);
			await assertNoPackageProcesses(appDirectory);
			safeCleanup = scenarioResourcesClosed && betweenRunsLifecycle.resourcesClosed;
		} catch (cleanupError) {
			recordGuiFailure(evidence, "cleanupFailure", cleanupError, [owned, profile]);
		}
		if (native)
			await writeFile(join(artifacts, "failure-native.log"), redactNativeLog(native.output, [owned, profile]));
		process.exitCode = 1;
	} finally {
		try {
			await sidebarPolicy?.cleanup(async () => {
				await native?.terminate();
				await assertNoPackageProcesses(appDirectory);
			});
		} catch (error) {
			evidence.status = "failed";
			safeCleanup = false;
			recordGuiFailure(evidence, "policyCleanupFailure", error, [owned, profile]);
			process.exitCode = 1;
		}
		evidence.nativeFileLogs = [];
		for (const iteration of [0, 1]) {
			try {
				const log = await readNativeLog(nativeLogs, iteration, [owned, profile]);
				evidence.nativeFileLogs.push({ iteration, exists: log.exists, overflow: log.overflow });
				if (log.exists) await writeFile(join(artifacts, `chromium-${iteration}.log`), log.text);
				if (log.overflow) {
					evidence.status = "failed";
					evidence.failure ??= "Native file logging exceeded 1 MiB";
					process.exitCode = 1;
				}
			} catch {
				evidence.nativeFileLogs.push({ iteration, unavailable: true });
				evidence.status = "failed";
				evidence.failure ??= "Native file log collection failed";
				process.exitCode = 1;
			}
		}
		evidence.finishedAt = new Date().toISOString();
		evidence.cleanup = safeCleanup
			? "confirmed processes stopped"
			: "retained owned directories: process or fixture closure unconfirmed";
		const destination = join(packages, reportScenario === "baseline" ? "gui-smoke" : `gui-${reportScenario}`);
		await mkdir(destination, { recursive: true });
		for (const entry of await readdir(artifacts)) {
			const bytes = await readFile(join(artifacts, entry));
			await writeFile(join(destination, entry), bytes);
			evidence.artifacts.push({ file: entry, bytes: bytes.length, sha256: hash(bytes) });
		}
		await writeFile(
			join(destination, reportScenario === "baseline" ? "packaged-gui-smoke.json" : `packaged-${reportScenario}.json`),
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
		if (safeCleanup) {
			await rm(owned, { recursive: true, force: true, maxRetries: 3 });
			await rm(profile, { recursive: true, force: true, maxRetries: 3 });
		}
	}
	console.log(`Packaged GUI ${reportScenario}: ${evidence.status}. This does not establish full native RC acceptance.`);
	return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runPackagedGui();
