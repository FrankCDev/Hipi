import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError, PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { HostConnection } from "../src/host-connection.ts";
import { CHANNEL, command, decode, encode } from "../src/protocol.ts";
import { createRuntimeRouter } from "../src/runtime-router.ts";
import { trustedSender } from "../src/sender.ts";

const generation = "generation-1";
const handshake = { version: PROTOCOL_VERSION, method: "handshake", params: {} };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("source guard rejects same URL foreign windows and child frames", () => {
	const owner = { mainFrame: { url: "hipi-work://app/index.html" } };
	assert.equal(trustedSender({ sender: owner, senderFrame: owner.mainFrame }, owner, owner.mainFrame.url), true);
	assert.equal(trustedSender({ sender: {}, senderFrame: owner.mainFrame }, owner, owner.mainFrame.url), false);
	assert.equal(
		trustedSender({ sender: owner, senderFrame: { url: owner.mainFrame.url } }, owner, owner.mainFrame.url),
		false,
	);
	assert.equal(
		trustedSender({ sender: owner, senderFrame: owner.mainFrame }, owner, "hipi-work://evil/index.html"),
		false,
	);
});
test("protocol rejects arbitrary methods and unknown fields", () => {
	assert.equal(CHANNEL, `hipi-work:v${PROTOCOL_VERSION}`);
	assert.throws(
		() => command(encode({ generation, id: "1", kind: "call", request: { ...handshake, method: "readFile" } })),
		AppError,
	);
	assert.throws(() => command(encode({ generation, id: "1", kind: "cancel", path: "/tmp" })), AppError);
	assert.throws(
		() => command(encode({ generation, id: "1", kind: "call", request: { ...handshake, version: 1 } })),
		AppError,
	);
});
test("obsolete handshake reply closes the host instead of accepting an incompatible runtime", async () => {
	const sent: string[] = [];
	let failures = 0;
	const host = new HostConnection(
		generation,
		(raw) => sent.push(raw),
		() => {
			failures++;
		},
	);
	const pending = host.call(handshake);
	const id = decode(sent[0]).id;
	host.receive(encode({ generation, id, kind: "result", result: { protocolVersion: 1, storeId: "store" } }));
	assert.deepEqual(await pending.result, { ok: false, error: "CLOSED" });
	assert.equal(host.activeCount, 0);
	assert.equal(failures, 1);
});
test("host loss resolves in-flight command as unknown and never replays", async () => {
	const sent: string[] = [];
	const host = new HostConnection(generation, (raw) => sent.push(raw));
	const pending = host.call(handshake);
	host.close();
	assert.deepEqual(await pending.result, { ok: false, error: "CLOSED" });
	assert.equal(sent.filter((raw) => decode(raw).kind === "call").length, 1);
	assert.equal(decode(sent[1]).kind, "cancel");
	assert.equal(host.activeCount, 0);
	await assert.rejects(host.call(handshake).result, { code: "CLOSED" });
});
test("incarnation mismatch cannot settle an active request", async () => {
	const sent: string[] = [];
	const host = new HostConnection(generation, (raw) => sent.push(raw));
	const pending = host.call(handshake);
	const id = decode(sent[0]).id;
	host.receive(
		encode({ generation: "old", id, kind: "result", result: { protocolVersion: PROTOCOL_VERSION, storeId: "wrong" } }),
	);
	assert.equal(host.activeCount, 1);
	host.receive(
		encode({ generation, id, kind: "result", result: { protocolVersion: PROTOCOL_VERSION, storeId: "store" } }),
	);
	assert.deepEqual(await pending.result, { ok: true, result: { protocolVersion: PROTOCOL_VERSION, storeId: "store" } });
	host.close();
});
test("host bounds active waits and releases observations on close", async () => {
	const host = new HostConnection(generation, () => undefined);
	const waits = Array.from({ length: 16 }, () => host.call(handshake).result);
	await assert.rejects(host.call(handshake).result, { code: "CAPACITY_EXCEEDED" });
	host.close();
	await Promise.all(waits);
});
test("cancel does not release runtime admission slot before accepted work settles", async () => {
	let finish: (() => void) | undefined;
	const operation = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let executed = 0;
	const output: string[] = [];
	const router = createRuntimeRouter(
		{
			execute: async () => {
				executed++;
				await operation;
				return { protocolVersion: PROTOCOL_VERSION, storeId: "store" };
			},
			observe: async () => {
				throw new Error("unused");
			},
			close: async () => undefined,
		},
		generation,
		(raw) => output.push(raw),
	);
	const running = router.receive(encode({ generation, id: "1", kind: "call", request: handshake }));
	await router.receive(encode({ generation, id: "1", kind: "cancel" }));
	assert.equal(router.activeCount(), 1);
	finish?.();
	await running;
	assert.equal(executed, 1);
	assert.equal(output.length, 0);
	assert.equal(router.activeCount(), 0);
	await router.shutdown();
});
test("observation checks pinned store, waits for ack, and cancels source", async () => {
	const output: string[] = [];
	let pinned: unknown;
	let delivered = false;
	let disposed = false;
	const router = createRuntimeRouter(
		{
			execute: async (value) => {
				pinned = value;
				return null;
			},
			observe: async (_scope, listener) => {
				await listener({
					kind: "snapshot",
					epoch: "e",
					version: 0,
					snapshot: {
						workspaceId: "w",
						conversationId: "c",
						messages: [],
						partial: "",
						running: false,
						partialLength: 0,
						partialTruncated: false,
						historyCursor: null,
					},
				});
				delivered = true;
				return {
					dispose: async () => {
						disposed = true;
					},
				};
			},
			close: async () => undefined,
		},
		generation,
		(raw) => output.push(raw),
	);
	const running = router.receive(
		encode({
			generation,
			id: "1",
			kind: "observe",
			input: { scope: { workspaceId: "w", conversationId: "c" }, expectedStoreId: "store" },
		}),
	);
	await tick();
	assert.deepEqual(pinned, {
		version: PROTOCOL_VERSION,
		method: "snapshot",
		params: { workspaceId: "w", conversationId: "c" },
		expectedStoreId: "store",
	});
	assert.equal(delivered, false);
	assert.equal(output.length, 1);
	await router.receive(encode({ generation, id: "1", kind: "ack" }));
	await tick();
	assert.equal(delivered, true);
	await router.receive(encode({ generation, id: "1", kind: "cancel" }));
	await running;
	assert.equal(disposed, true);
	assert.equal(router.activeCount(), 0);
	await router.shutdown();
});
test("shutdown failure cannot publish stopped or report a clean close", async () => {
	const output: string[] = [];
	const router = createRuntimeRouter(
		{
			execute: async () => null,
			observe: async () => {
				throw new Error("unused");
			},
			close: async () => {
				throw new Error("writer retained");
			},
		},
		generation,
		(raw) => output.push(raw),
	);
	await assert.rejects(router.receive(encode({ generation, kind: "shutdown" })), /writer retained/);
	assert.equal(output.length, 0);
});
test("throwing renderer callback cannot strand other waiters during close", async () => {
	const host = new HostConnection(generation, () => undefined);
	host.observe({ scope: { workspaceId: "w", conversationId: "c" }, expectedStoreId: "store" }, () => {
		throw new Error("renderer destroyed");
	});
	const pending = host.call(handshake);
	assert.doesNotThrow(() => host.close());
	assert.deepEqual(await pending.result, { ok: false, error: "CLOSED" });
	assert.equal(host.activeCount, 0);
});
test("a second unacknowledged frame closes bounded host connection", () => {
	const sent: string[] = [];
	const events: object[] = [];
	const host = new HostConnection(generation, (raw) => sent.push(raw));
	host.observe({ scope: { workspaceId: "w", conversationId: "c" }, expectedStoreId: "store" }, (value) =>
		events.push(value),
	);
	const id = decode(sent[0]).id;
	const frame = {
		kind: "snapshot",
		epoch: "e",
		version: 0,
		snapshot: {
			workspaceId: "w",
			conversationId: "c",
			messages: [],
			partial: "",
			running: false,
			partialLength: 0,
			partialTruncated: false,
			historyCursor: null,
		},
	};
	host.receive(encode({ generation, kind: "frame", id, frame }));
	host.receive(encode({ generation, kind: "frame", id, frame }));
	assert.equal(events.length, 2);
	assert.equal(host.activeCount, 0);
});
