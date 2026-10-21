import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDevelopmentOutput, restartCoordinator, startDesktop } from "./process.mjs";

const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
test("CLI usage failure uses one structured readable event and never echoes supplied input", () => {
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./start.mjs", import.meta.url)), "--provider=private-token-value"],
		{
			encoding: "utf8",
			timeout: 10000,
		},
	);
	assert.equal(result.status, 1);
	assert.equal(result.stderr.includes("private-token-value"), false);
	assert.equal(result.stderr.includes("[desktop dev]"), false);
	assert.equal(result.stderr.match(/dev\.usage\.invalid/g)?.length, 1);
	assert.match(result.stderr, /--provider=production/);
	assert.match(result.stderr, /--provider=deterministic/);
});
test("new invocation cannot overwrite a surviving owner's lazy bundles", async () => {
	const repository = await mkdtemp(join(tmpdir(), "hipi-dev-output-"));
	let child;
	try {
		const first = await createDevelopmentOutput(repository);
		await writeFile(join(first, "preview-parser.mjs"), "old-owner");
		const output = [];
		child = startDesktop(process.execPath, [fixture, "lazy-read", join(first, "preview-parser.mjs")], {
			onOutput: (line) => output.push(line),
		});
		await child.ready;
		const next = await createDevelopmentOutput(repository);
		await writeFile(join(next, "preview-parser.mjs"), "new-owner");
		assert.notEqual(first, next);
		assert.equal(await readFile(join(first, "preview-parser.mjs"), "utf8"), "old-owner");
		assert.equal((await child.quit()).code, 0);
		assert.deepEqual(output, ["old-owner\n"]);
	} finally {
		await child?.quit();
		await rm(repository, { recursive: true, force: true });
	}
});
for (const timeout of [true, false]) {
	test(`hung startup accepts ${timeout ? "timeout" : "immediate cancellation"} before readiness`, async () => {
		const output = [];
		const child = startDesktop(process.execPath, [fixture, "hung-startup"], {
			readyTimeout: 150,
			onOutput: (line) => output.push(line),
		});
		if (timeout) await assert.rejects(child.ready, /did not report readiness/);
		assert.equal((await child.quit()).code, 0);
		assert.equal(child.isReady, false);
		assert.deepEqual(output, ["runtime-closed\n"]);
	});
}
test("real owned child readiness and orderly shutdown are observed", async () => {
	const child = startDesktop(process.execPath, [fixture, "ready"]);
	try {
		await child.ready;
		assert.equal(child.exited, false);
	} finally {
		assert.deepEqual(await child.quit(), { code: 0, signal: null, requested: true });
	}
	assert.equal(child.exited, true);
	assert.deepEqual(await child.quit(), { code: 0, signal: null, requested: true });
});
test("early process failure is not readiness", async () => {
	const child = startDesktop(process.execPath, [fixture, "fail"]);
	await assert.rejects(child.ready, /before readiness/);
	assert.equal((await child.completion).code, 7);
});
test("startup timeout is visible and shutdown still belongs to the real child", async () => {
	const child = startDesktop(process.execPath, [fixture, "silent"], { readyTimeout: 100 });
	try {
		await assert.rejects(child.ready, /did not report readiness/);
	} finally {
		assert.equal((await child.quit()).code, 0);
	}
});
test("rebuild bursts wait for previous child exit before publishing and coalesce pending revisions", async () => {
	const events = [];
	let child = startDesktop(process.execPath, [fixture, "slow"]);
	await child.ready;
	const first = child;
	const coordinator = restartCoordinator({
		stop: async () => {
			await child.quit();
			events.push("stopped");
		},
		publish: async () => {
			assert.equal(first.exited, true);
			events.push("published");
			return true;
		},
		start: async () => {
			child = startDesktop(process.execPath, [fixture, "slow"]);
			await child.ready;
			events.push("started");
		},
		failed: (error) => {
			throw error;
		},
	});
	try {
		coordinator.request();
		coordinator.request();
		coordinator.request();
		for (let attempts = 0; !events.includes("started") && attempts < 100; attempts++) await pause(10);
		assert.deepEqual(events, ["stopped", "published", "started"]);
	} finally {
		await coordinator.close();
	}
});
test("cancellation while old child is closing does not publish or start a replacement", async () => {
	const child = startDesktop(process.execPath, [fixture, "slow"]);
	await child.ready;
	let published = false;
	const coordinator = restartCoordinator({
		stop: () => child.quit(),
		publish: async () => {
			published = true;
			return true;
		},
		start: async () => assert.fail("must not start"),
		failed: assert.fail,
	});
	coordinator.request();
	await coordinator.close();
	assert.equal(published, false);
});
