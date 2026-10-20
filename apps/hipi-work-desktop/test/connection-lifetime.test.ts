import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkRuntime } from "@hipi/work-runtime";
import { type Frame, PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { HostConnection } from "../src/host-connection.ts";
import { decode, encode, record, WAIT_MS } from "../src/protocol.ts";
import { createRuntimeRouter } from "../src/runtime-router.ts";

const generation = "generation";
const input = { scope: { workspaceId: "workspace", conversationId: "conversation" }, expectedStoreId: "store" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function frame(version: number): Frame {
	return {
		kind: "snapshot",
		epoch: "epoch",
		version,
		snapshot: {
			...input.scope,
			messages: [],
			partial: "",
			running: false,
			partialLength: 0,
			partialTruncated: false,
			historyCursor: null,
		},
	};
}

test("host and runtime keep acknowledged observations through idle and release a genuine source failure", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let sourceListener: Parameters<WorkRuntime["observe"]>[1] | undefined;
	let sourceStatus: Parameters<WorkRuntime["observe"]>[3] | undefined;
	let sourceSignal: AbortSignal | undefined;
	let disposed = false;
	const commands: Record<string, unknown>[] = [];
	const events: object[] = [];
	const tasks = new Set<Promise<void>>();
	const host = new HostConnection(generation, (raw) => {
		commands.push(decode(raw));
		const task = router.receive(raw);
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => host.close());
	});
	const router = createRuntimeRouter(
		{
			execute: async () => null,
			observe: async (_scope, listener, signal, onStatus) => {
				sourceListener = listener;
				sourceStatus = onStatus;
				sourceSignal = signal;
				await listener(frame(0));
				return {
					dispose: async () => {
						disposed = true;
					},
				};
			},
			close: async () => {},
		},
		generation,
		(raw) => host.receive(raw),
	);
	const observation = host.observe(input, (value) => {
		events.push(value);
		if (record(value).kind === "frame") queueMicrotask(() => observation.ack());
	});
	try {
		await tick();
		context.mock.timers.tick(24 * 60 * 60 * 1000);
		assert.equal(host.activeCount, 1);
		assert.equal(router.activeCount(), 1);
		assert.equal(sourceSignal?.aborted, false);
		assert.equal(disposed, false);
		for (let version = 1; version <= 3; version++) {
			assert.ok(sourceListener);
			await sourceListener(frame(version));
			context.mock.timers.tick(65000);
		}
		assert.equal(events.length, 4);
		assert.equal(host.activeCount, 1);
		assert.equal(router.activeCount(), 1);
		assert.equal(commands.filter((value) => value.kind === "observe").length, 1);
		assert.equal(commands.filter((value) => value.kind === "ack").length, 4);
		assert.equal(commands.filter((value) => value.kind === "cancel").length, 0);
		assert.ok(sourceStatus);
		sourceStatus({ state: "closed", reason: "error", code: "INTERNAL" });
		await tick();
		assert.deepEqual(events.at(-1), {
			kind: "status",
			status: { state: "closed", reason: "error", code: "INTERNAL" },
		});
		assert.equal(host.activeCount, 0);
		assert.equal(router.activeCount(), 0);
		assert.equal(sourceSignal?.aborted, true);
		assert.equal(disposed, true);
		observation.dispose();
		assert.equal(events.length, 5);
	} finally {
		host.close();
		await Promise.all(tasks);
		await router.shutdown();
	}
});

test("host startup, command waits and each unacknowledged frame still have bounded deadlines", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const sent: Record<string, unknown>[] = [];
	const events: object[] = [];
	const host = new HostConnection(generation, (raw) => sent.push(decode(raw)));
	try {
		host.observe(input, (value) => events.push(value));
		context.mock.timers.tick(WAIT_MS - 1);
		assert.equal(host.activeCount, 1);
		context.mock.timers.tick(1);
		assert.equal(host.activeCount, 0);
		assert.deepEqual([...events], [{ kind: "status", status: { state: "closed", reason: "disconnected" } }]);

		const pending = host.call({ version: PROTOCOL_VERSION, method: "handshake", params: {} });
		context.mock.timers.tick(WAIT_MS);
		assert.deepEqual(await pending.result, { ok: false, error: "CLOSED" });
		assert.equal(host.activeCount, 0);
		assert.equal(sent.filter((value) => value.kind === "call").length, 1);

		const observation = host.observe(input, (value) => events.push(value));
		const id = sent.at(-1)?.id;
		host.receive(encode({ generation, id, kind: "frame", frame: frame(0) }));
		observation.ack();
		context.mock.timers.tick(65000);
		assert.equal(host.activeCount, 1);
		host.receive(encode({ generation, id, kind: "frame", frame: frame(1) }));
		context.mock.timers.tick(WAIT_MS - 1);
		assert.equal(host.activeCount, 1);
		context.mock.timers.tick(1);
		assert.equal(host.activeCount, 0);
		assert.deepEqual(events.at(-1), { kind: "status", status: { state: "closed", reason: "disconnected" } });
		observation.ack();
		observation.dispose();
		context.mock.timers.tick(65000);
		assert.equal(events.length, 4);
		assert.equal(sent.filter((value) => value.kind === "cancel").length, 3);
	} finally {
		host.close();
	}
});

test("runtime acknowledgement timeout aborts a stuck initial consumer and frees admission", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const sent: Record<string, unknown>[] = [];
	let sourceSignal: AbortSignal | undefined;
	const router = createRuntimeRouter(
		{
			execute: async () => null,
			observe: async (_scope, listener, signal) => {
				sourceSignal = signal;
				await listener(frame(0));
				return { dispose: async () => {} };
			},
			close: async () => {},
		},
		generation,
		(raw) => sent.push(decode(raw)),
	);
	const pending = router.receive(encode({ generation, id: "1", kind: "observe", input }));
	try {
		await tick();
		assert.equal(router.activeCount(), 1);
		assert.equal(sent[0]?.kind, "frame");
		context.mock.timers.tick(WAIT_MS);
		await pending;
		assert.equal(router.activeCount(), 0);
		assert.equal(sourceSignal?.aborted, true);
		assert.deepEqual(sent.at(-1), { generation, id: "1", kind: "error", error: "CLOSED" });
	} finally {
		await router.shutdown();
	}
});
