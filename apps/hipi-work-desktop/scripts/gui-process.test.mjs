import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { until } from "./gui-flow.mjs";
import { startProcess } from "./gui-process.mjs";

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
	const end = source.indexOf("\nexport async function assertNoPackageProcesses", begin);
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
