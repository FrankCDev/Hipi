import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { until } from "./gui-flow.mjs";
import { queryWindowsPackageExit, startProcess, waitForCimExit } from "./gui-process.mjs";

test("native runner observes actual close before releasing a child", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "hipi-gui-child-test-")));
	const fixture = join(directory, "child.mjs");
	await writeFile(fixture, "console.log('ready'); setInterval(() => {}, 1000);\n");
	const child = startProcess(process.execPath, [fixture], { cwd: directory, env: {} });
	try {
		await until(() => child.output.includes("ready"), "child ready");
		assert.equal(child.closed, false);
		await child.terminate();
		assert.equal(child.closed, true);
		const result = await child.completion;
		assert.ok(result.signal !== null || result.code !== 0);
		assert.match(await readFile(fixture, "utf8"), /setInterval/);
	} finally {
		if (!child.closed) await child.terminate();
		await rm(directory, { recursive: true, force: true });
	}
});
test("spawn failure is an observed non-successful terminal state", async () => {
	const child = startProcess(join(tmpdir(), "hipi-does-not-exist-no-executable"), [], { env: {} });
	const result = await child.wait(5000);
	assert.notEqual(result.code, 0);
	assert.equal(child.closed, true);
	assert.match(child.output, /Spawn failed/);
});

test("terminate never signals the old PID or process group after observed close", async (context) => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "hipi-gui-closed-test-")));
	const fixture = join(directory, "child.mjs");
	await writeFile(fixture, "console.log('finished');\n");
	const child = startProcess(process.execPath, [fixture], { cwd: directory, env: {} });
	try {
		assert.equal((await child.wait()).code, 0);
		const signal = context.mock.method(process, "kill", () => {
			throw new Error("Old PID must never be signalled");
		});
		await child.terminate();
		assert.equal(signal.mock.callCount(), 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("exit-before-close waits without signaling on POSIX and Windows, independent of native stdio timing", async () => {
	const source = await readFile(new URL("./gui-process.mjs", import.meta.url), "utf8");
	const begin = source.indexOf("export function startProcess(");
	const end = source.indexOf("\nexport async function waitForCimExit", begin);
	assert.ok(begin >= 0 && end > begin, "Test must exercise the actual process owner implementation");
	const implementation = source.slice(begin, end).replace(/^export /, "");
	for (const platform of ["linux", "win32"]) {
		for (const observation of ["exit-event", "exit-code", "signal-code"]) {
			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				pid: 123,
				exitCode: null,
				signalCode: null,
			});
			let signals = 0;
			// The isolated implementation receives no real spawn, taskkill, or process.kill.
			// Even a regression cannot send this synthetic PID to an operating-system API.
			const forbiddenSignal = () => {
				signals++;
				throw new Error("Exited process identity must never be signalled");
			};
			const start = runInNewContext(`${implementation}\nstartProcess`, {
				spawn: () => child,
				execute: forbiddenSignal,
				process: { platform, kill: forbiddenSignal },
				until,
			});
			const owned = start("controlled-fixture", [], {});
			if (observation === "exit-event") child.emit("exit", 0, null);
			else if (observation === "exit-code") child.exitCode = 0;
			else child.signalCode = "SIGTERM";
			assert.equal(owned.closed, false);
			let settled = false;
			const stopping = owned.terminate().finally(() => {
				settled = true;
			});
			await Promise.resolve();
			assert.equal(settled, false, "Exit alone must not release resources before close");
			assert.equal(signals, 0);
			child.emit("close", 0, null);
			await stopping;
			assert.equal(owned.closed, true);
			assert.equal((await owned.completion).code, 0);
			await owned.terminate();
			assert.equal(signals, 0, "Neither exit nor close permits signalling the old identity");
		}
	}
});

test("CIM exit observation authorizes cleanup only after an actual zero result within the shared deadline", async () => {
	let time = 0;
	const budgets = [];
	let calls = 0;
	const clock = {
		milliseconds: 1000,
		now: () => time,
		pause: async (ms) => {
			time += ms;
		},
	};
	await waitForCimExit(async (timeout) => {
		budgets.push(timeout);
		time += 100;
		if (++calls < 3) throw Object.assign(new Error("still present"), { code: 2 });
	}, clock);
	assert.equal(calls, 3);
	assert.deepEqual(budgets, [1000, 650, 300]);
	time = 0;
	await assert.rejects(
		waitForCimExit(async () => {
			throw Object.assign(new Error("still present"), { code: 2 });
		}, clock),
		/remain.*deadline/,
	);
	assert.equal(time, 1000);
	time = 0;
	calls = 0;
	await assert.rejects(
		waitForCimExit(async () => {
			calls++;
			throw Object.assign(new Error("query denied"), { code: 1 });
		}, clock),
		/query denied/,
	);
	assert.equal(calls, 1);
	assert.equal(time, 0);
	await assert.rejects(
		waitForCimExit(async (timeout) => {
			time += timeout;
		}, clock),
		/deadline/,
	);
});

test("Windows exit query requires complete fixed outcomes and preserves query scope, environment and deadline", async () => {
	const prefix = ["start", "query", "query-return"].map((phase) => `HIPI_PACKAGE_EXIT_PHASE:${phase}\n`).join("");
	const absent = `${prefix}HIPI_PACKAGE_EXIT_PHASE:absent\n`;
	const present = `${prefix}HIPI_PACKAGE_EXIT_PHASE:present\n`;
	const directory = "C:\\owned-private-package";
	await queryWindowsPackageExit(directory, 4321, async (command, args, options) => {
		assert.equal(command, "powershell.exe");
		assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
		assert.ok(!args[3].includes(directory));
		assert.match(args[3], /Get-CimInstance Win32_Process -ErrorAction Stop \| Where-Object/);
		assert.match(
			args[3],
			/StartsWith\(\$p \+ \[IO.Path\]::DirectorySeparatorChar, \[StringComparison\]::OrdinalIgnoreCase\)/,
		);
		assert.equal(options.timeout, 4321);
		assert.equal(options.maxBuffer, 1024 * 1024);
		assert.equal(options.env.HIPI_SMOKE_PACKAGE, directory);
		assert.ok(Object.keys(options.env).every((name) => /^(PATH|SYSTEMROOT|WINDIR|HIPI_SMOKE_PACKAGE)$/i.test(name)));
		return { stdout: absent, stderr: "" };
	});
	for (const stdout of ["", prefix, absent.trimEnd(), `${absent}private-output\n`, "x".repeat(4097), present])
		await assert.rejects(
			queryWindowsPackageExit(directory, 1000, async () => ({ stdout, stderr: "" })),
			{
				message: "Packaged exit observation did not confirm a result",
			},
		);
	await assert.rejects(queryWindowsPackageExit(directory, 1000, async () => ({ stdout: absent, stderr: "private" })));
	for (const [stdout, phase] of [
		["", "helper-start"],
		["HIPI_PACKAGE_EXIT_PHASE:start\nHIPI_PACKAGE_EXIT_PHASE:query\n", "query"],
		["private\n", "output-invalid"],
	]) {
		const failure = Object.assign(new Error("command=private"), {
			code: null,
			killed: true,
			signal: "SIGTERM",
			stdout,
		});
		await assert.rejects(
			queryWindowsPackageExit(directory, 1000, async () => {
				throw failure;
			}),
			(error) => {
				assert.equal(error, failure);
				assert.equal(error.packageExitPhase, phase);
				return true;
			},
		);
	}
	await assert.rejects(
		queryWindowsPackageExit(directory, 1000, async () => {
			throw Object.assign(new Error("helpers present"), { code: 2, stdout: present, stderr: "" });
		}),
		{ code: 2, packageExitPhase: "present" },
	);
	for (const stdout of ["", absent, present.trimEnd(), `${present}private\n`])
		await assert.rejects(
			queryWindowsPackageExit(directory, 1000, async () => {
				throw Object.assign(new Error("private"), { code: 2, stdout, stderr: "" });
			}),
			(error) => {
				assert.notEqual(error.code, 2, "Unconfirmed output must not authorize retry");
				assert.equal(error.message, "Packaged exit observation did not confirm a result");
				return true;
			},
		);
});
