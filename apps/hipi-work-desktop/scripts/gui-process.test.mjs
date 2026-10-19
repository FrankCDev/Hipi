import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("leader exit with inherited stdio still open never authorizes signaling an old process group", async (context) => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "hipi-gui-exit-test-")));
	const fixture = join(directory, "child.mjs");
	await writeFile(
		fixture,
		"import { spawn } from 'node:child_process';\nif (process.argv.includes('--descendant')) setTimeout(() => {}, 500); else { spawn(process.execPath, [import.meta.filename, '--descendant'], { stdio: 'inherit' }); process.exit(0); }\n",
	);
	const child = startProcess(process.execPath, [fixture], { cwd: directory, env: {} });
	try {
		await until(() => child.child.exitCode === 0, "leader exited");
		assert.equal(child.closed, false);
		const signal = context.mock.method(process, "kill", () => {
			throw new Error("Exited leader must not be signalled");
		});
		await child.terminate();
		assert.equal(signal.mock.callCount(), 0);
		assert.equal(child.closed, true);
	} finally {
		await child.wait();
		await rm(directory, { recursive: true, force: true });
	}
});
