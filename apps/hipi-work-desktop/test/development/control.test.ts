import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentLifecycle } from "../../src/development/control.ts";

test("quit before readiness waits for actual runtime close and is idempotent", async () => {
	let stopped: (clean: boolean) => void = () => assert.fail("not started");
	const closing = new Promise<boolean>((resolve) => {
		stopped = resolve;
	});
	let stops = 0;
	const exits: boolean[] = [];
	const lifecycle = new DevelopmentLifecycle(
		() => {
			stops++;
			return closing;
		},
		async (clean) => {
			exits.push(clean);
		},
	);
	const first = lifecycle.quit();
	assert.equal(lifecycle.quit(), first);
	assert.equal(lifecycle.cancelled, true);
	assert.equal(stops, 1);
	assert.deepEqual(exits, []);
	stopped(true);
	await first;
	assert.deepEqual(exits, [true]);
});
test("failed runtime shutdown is never promoted to clean startup cancellation", async () => {
	const exits: boolean[] = [];
	const lifecycle = new DevelopmentLifecycle(
		async () => false,
		async (clean) => {
			exits.push(clean);
		},
	);
	await lifecycle.quit();
	assert.deepEqual(exits, [false]);
});
test("after window ownership transfers, quit uses dirty-safe window lifecycle rather than closing runtime", async () => {
	let windowRequests = 0;
	const lifecycle = new DevelopmentLifecycle(
		async () => assert.fail("window owns runtime"),
		async () => assert.fail("window owns exit"),
	);
	lifecycle.windowReady(() => {
		windowRequests++;
	});
	await lifecycle.quit();
	await lifecycle.quit();
	assert.equal(windowRequests, 2);
});
