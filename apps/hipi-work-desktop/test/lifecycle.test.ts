import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { InvocationGate } from "../src/ipc/invocation-gate.ts";
import { decode, encode } from "../src/ipc/protocol.ts";
import { RuntimeSupervisor } from "../src/runtime/supervisor.ts";
import { WindowLifecycle } from "../src/shell/window-lifecycle.ts";

class Child extends EventEmitter {
	generation: string;
	sent: string[] = [];
	killed = false;
	constructor(generation: string) {
		super();
		this.generation = generation;
	}
	postMessage(raw: unknown) {
		assert.equal(typeof raw, "string");
		this.sent.push(String(raw));
	}
	kill() {
		this.killed = true;
		return true;
	}
	message(kind: string) {
		this.emit("message", encode({ generation: this.generation, kind }));
	}
}
function fixture() {
	const children: Child[] = [];
	const supervisor = new RuntimeSupervisor(
		(generation) => {
			const child = new Child(generation);
			children.push(child);
			return child;
		},
		() => undefined,
	);
	return { children, supervisor };
}
test("timed-out invocations retain quota until underlying invocation settles", async () => {
	const gate = new InvocationGate();
	let finish: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const calls = Array.from({ length: 16 }, () => gate.run(() => pending, 1));
	await Promise.all(calls);
	assert.equal(gate.pending, 16);
	assert.deepEqual(await gate.run(async () => "never"), { ok: false, error: "CAPACITY_EXCEEDED" });
	finish?.();
	await pending;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(gate.pending, 0);
});
test("supervisor restarts only after exit with fresh generation and no replay", async () => {
	const { children, supervisor } = fixture();
	const ready = supervisor.start();
	assert.throws(() => supervisor.connection(), { code: "CLOSED" });
	children[0].message("ready");
	await ready;
	const pending = supervisor.connection().call({ version: PROTOCOL_VERSION, method: "handshake", params: {} }).result;
	children[0].message("fatal");
	assert.equal(children.length, 1);
	assert.deepEqual(await pending, { ok: false, error: "CLOSED" });
	children[0].emit("exit", 1);
	assert.equal(children.length, 2);
	assert.notEqual(children[0].generation, children[1].generation);
	assert.equal(children[1].sent.length, 0);
	children[1].message("ready");
	children[0].message("ready");
	assert.equal(supervisor.connection().generation, children[1].generation);
	const closed = supervisor.close();
	assert.equal(decode(children[1].sent.at(-1)).kind, "shutdown");
	children[1].message("stopped");
	assert.equal(children[1].killed, true);
	children[1].emit("exit", 0);
	assert.equal(await closed, true);
});
test("close failure keeps ownership; shutdown does not resolve before actual exit", async () => {
	const { children, supervisor } = fixture();
	const ready = supervisor.start();
	children[0].message("ready");
	await ready;
	let settled = false;
	const closed = supervisor.close().then((result) => {
		settled = true;
		return result;
	});
	children[0].message("shutdownFailed");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	assert.equal(children.length, 1);
	assert.throws(() => supervisor.connection(), { code: "CLOSED" });
	children[0].emit("exit", 1);
	assert.equal(await closed, false);
});
test("unexpected exits exhaust a finite restart budget", async () => {
	const { children, supervisor } = fixture();
	const ready = supervisor.start();
	children[0].message("ready");
	await ready;
	for (let index = 0; index < 3; index++) children[index].emit("exit", 1);
	assert.equal(children.length, 3);
	assert.throws(() => supervisor.connection(), { code: "CLOSED" });
	assert.equal(await supervisor.close(), false);
});
test("cancelled window close leaves runtime usable; confirmed close shuts down once", async () => {
	let requests = 0;
	let shutdowns = 0;
	const lifecycle = new WindowLifecycle(
		() => {
			requests++;
		},
		async () => {
			shutdowns++;
			return true;
		},
	);
	lifecycle.requestQuit();
	assert.equal(requests, 1);
	assert.equal(shutdowns, 0);
	// beforeunload refused the first close; a later quit must still reach the window.
	lifecycle.requestQuit();
	assert.equal(requests, 2);
	assert.equal(shutdowns, 0);
	assert.equal(await lifecycle.windowClosed(), true);
	assert.equal(await lifecycle.windowClosed(), true);
	lifecycle.requestQuit();
	assert.equal(requests, 2);
	assert.equal(shutdowns, 1);
});
test("closing during startup rejects readiness; a late ready cannot reopen admission", async () => {
	const { children, supervisor } = fixture();
	const ready = supervisor.start();
	const closed = supervisor.close();
	await assert.rejects(ready, { code: "CLOSED" });
	children[0].message("ready");
	assert.throws(() => supervisor.connection(), { code: "CLOSED" });
	children[0].message("stopped");
	children[0].emit("exit", 0);
	assert.equal(await closed, true);
});
test("malformed utility reply revokes admission and requests exit before replacement", async () => {
	const { children, supervisor } = fixture();
	const ready = supervisor.start();
	children[0].message("ready");
	await ready;
	const result = supervisor.connection().call({ version: PROTOCOL_VERSION, method: "handshake", params: {} }).result;
	const id = decode(children[0].sent[0]).id;
	children[0].emit("message", encode({ generation: children[0].generation, id, kind: "invalid" }));
	assert.deepEqual(await result, { ok: false, error: "CLOSED" });
	assert.equal(children[0].killed, true);
	assert.equal(children.length, 1);
	assert.throws(() => supervisor.connection(), { code: "CLOSED" });
	children[0].emit("exit", 1);
	assert.equal(children.length, 2);
	const closed = supervisor.close();
	children[1].emit("exit", 1);
	await closed;
});
test("late readiness cannot revive a failed incarnation", async () => {
	const { children, supervisor } = fixture();
	const ready = supervisor.start();
	children[0].message("ready");
	await ready;
	children[0].message("fatal");
	children[0].message("ready");
	assert.throws(() => supervisor.connection(), { code: "CLOSED" });
	const closed = supervisor.close();
	children[0].emit("exit", 1);
	await closed;
});
test("late startup ready does not cancel the independent shutdown watchdog", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const { children, supervisor } = fixture();
	const ready = supervisor.start();
	const closed = supervisor.close();
	await assert.rejects(ready, { code: "CLOSED" });
	children[0].message("ready");
	context.mock.timers.tick(10001);
	assert.equal(children[0].killed, true);
	children[0].emit("exit", 1);
	assert.equal(await closed, false);
});
test("private credential replies cannot cross a utility replacement or leak into public replies", async () => {
	const children: Child[] = [];
	let resolveSecret: ((secret: string) => void) | undefined;
	const secret = new Promise<string>((resolve) => {
		resolveSecret = resolve;
	});
	const supervisor = new RuntimeSupervisor(
		(generation) => {
			const child = new Child(generation);
			children.push(child);
			return child;
		},
		() => undefined,
		{ get: () => secret, status: async () => "configured" },
	);
	const ready = supervisor.start();
	children[0].message("ready");
	await ready;
	children[0].emit(
		"message",
		encode({
			generation: children[0].generation,
			kind: "credentialRequest",
			id: "c1",
			operation: "get",
			provider: "openai",
		}),
	);
	children[0].emit("exit", 1);
	children[1].message("ready");
	resolveSecret?.("synthetic-secret");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		children.flatMap((child) => child.sent).some((raw) => raw.includes("synthetic-secret")),
		false,
	);
	const closed = supervisor.close();
	children[1].message("stopped");
	children[1].emit("exit", 0);
	assert.equal(await closed, true);
});
