import assert from "node:assert/strict";
import { test } from "node:test";
import { type Frame, type ObservationStatus, PROTOCOL_VERSION, type Request } from "@hipi/work-runtime/contracts";
import { createDesktopClient, type DesktopBridge } from "../src/app/desktop-client.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const handshake = { ok: true, result: { protocolVersion: PROTOCOL_VERSION, storeId: "store" } };
function fixture(initial = true) {
	const requests: Request[] = [];
	let callback: (event: unknown) => void | Promise<void> = () => {};
	let disposed = 0;
	let reply: (input: Request) => Promise<unknown> = async () => handshake;
	const bridge: DesktopBridge = {
		async request(input) {
			requests.push(input as Request);
			return reply(input as Request);
		},
		subscribe(input, listener) {
			assert.deepEqual(input, { scope, expectedStoreId: "store" });
			callback = listener;
			if (initial)
				queueMicrotask(() => {
					void listener({ kind: "frame", frame: frame(0) });
				});
			return () => {
				disposed++;
			};
		},
	};
	return {
		client: createDesktopClient(bridge),
		requests,
		emit: (event: unknown) => callback(event),
		get disposed() {
			return disposed;
		},
		setReply(value: typeof reply) {
			reply = value;
		},
	};
}
function frame(version: number, epoch = "epoch"): Frame {
	return {
		kind: "snapshot",
		epoch,
		version,
		snapshot: {
			...scope,
			messages: [],
			partial: "",
			partialLength: 0,
			partialTruncated: false,
			historyCursor: null,
			running: false,
		},
	};
}

test("desktop calls pin identity and never automatically replay commands on host loss", async () => {
	const f = fixture();
	await f.client.call("handshake", {});
	f.setReply(async () => {
		throw new Error("private host path");
	});
	await assert.rejects(f.client.call("submit", { ...scope, requestId: "request", text: "work" }), {
		code: "CLOSED",
		message: "CLOSED",
	});
	assert.equal(f.requests.length, 2);
	assert.equal(f.requests[1]?.expectedStoreId, "store");
});

test("incompatible handshake results reject before desktop commands or subscriptions", async () => {
	for (const protocolVersion of [7, 8, 9, PROTOCOL_VERSION + 1]) {
		const requests: unknown[] = [];
		let subscriptions = 0;
		const client = createDesktopClient({
			async request(input) {
				requests.push(input);
				return { ok: true, result: { protocolVersion, storeId: "wrong-protocol" } };
			},
			subscribe() {
				subscriptions++;
				return () => {};
			},
		});
		await assert.rejects(client.call("createWorkspace", { workspaceId: "blocked", name: "Blocked" }), {
			code: "INVALID_REQUEST",
		});
		await assert.rejects(
			client.observe(scope, () => {}),
			{ code: "INVALID_REQUEST" },
		);
		assert.deepEqual(requests, [
			{ version: PROTOCOL_VERSION, method: "handshake", params: {} },
			{ version: PROTOCOL_VERSION, method: "handshake", params: {} },
		]);
		assert.equal(subscriptions, 0);
	}
});

test("cancelled requests stop waiting, suppress late results, and never send cancellation of execution", async () => {
	const f = fixture();
	await f.client.call("handshake", {});
	let complete: (value: unknown) => void = () => {};
	f.setReply(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const controller = new AbortController();
	const pending = f.client.call("submit", { ...scope, requestId: "original", text: "original" }, controller.signal);
	controller.abort();
	await assert.rejects(pending, { code: "CLOSED" });
	complete({ ok: true, result: { ...scope, requestId: "original", receiptId: "receipt", state: "accepted" } });
	await Promise.resolve();
	assert.equal(f.requests.length, 2);
	await assert.rejects(f.client.call("listWorkspaces", {}, controller.signal), { code: "CLOSED" });
	assert.equal(f.requests.length, 2);
});

test("a late aborted handshake cannot authorize a new store", async () => {
	const f = fixture();
	let complete: (value: unknown) => void = () => {};
	f.setReply(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const controller = new AbortController();
	const pending = f.client.call("handshake", {}, controller.signal);
	controller.abort();
	await assert.rejects(pending, { code: "CLOSED" });
	complete(handshake);
	await Promise.resolve();
	f.setReply(async (input) =>
		input.method === "handshake"
			? { ok: true, result: { protocolVersion: PROTOCOL_VERSION, storeId: "new-store" } }
			: { ok: true, result: { items: [], nextCursor: null } },
	);
	await f.client.call("listWorkspaces", {});
	assert.equal(f.requests[2]?.expectedStoreId, "new-store");
});

test("malformed results and store changes are rejected before restoration", async () => {
	const f = fixture();
	await f.client.call("handshake", {});
	f.setReply(async () => ({ ok: true, result: { protocolVersion: PROTOCOL_VERSION, storeId: "other" } }));
	await assert.rejects(f.client.call("handshake", {}), { code: "STORE_MISMATCH" });
	f.setReply(async () => ({ ok: true, result: "not a list" }));
	await assert.rejects(f.client.call("listWorkspaces", {}), { code: "INVALID_REQUEST" });
	assert.equal(f.requests[2]?.expectedStoreId, "store");
});

test("snapshot delivery awaits the consumer, ignores duplicates and closes foreign scopes", async () => {
	const f = fixture();
	const seen: number[] = [];
	const statuses: ObservationStatus[] = [];
	let release: () => void = () => {};
	const subscription = await f.client.observe(
		scope,
		async (value) => {
			if (value.version === 0) return;
			seen.push(value.version);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		undefined,
		(status) => statuses.push(status),
	);
	let delivered = false;
	const delivery = Promise.resolve(f.emit({ kind: "frame", frame: frame(1) })).then(() => {
		delivered = true;
	});
	await Promise.resolve();
	assert.equal(delivered, false);
	release();
	await delivery;
	await f.emit({ kind: "frame", frame: frame(1) });
	assert.deepEqual(seen, [1]);
	const foreign = frame(2);
	foreign.snapshot.workspaceId = "foreign";
	await f.emit({ kind: "frame", frame: foreign });
	assert.deepEqual(statuses.at(-1), { state: "closed", reason: "error", code: "INVALID_REQUEST" });
	assert.equal(f.disposed, 1);
	await subscription.dispose();
	await f.emit({ kind: "frame", frame: frame(3) });
	assert.deepEqual(seen, [1]);
	assert.equal(f.disposed, 1);
});

test("aborting slow observation releases subscription immediately and ignores late frames", async () => {
	const f = fixture();
	const controller = new AbortController();
	const statuses: ObservationStatus[] = [];
	let release: () => void = () => {};
	let calls = 0;
	const subscription = await f.client.observe(
		scope,
		async (value) => {
			if (value.version === 0) return;
			calls++;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		controller.signal,
		(status) => statuses.push(status),
	);
	const pending = f.emit({ kind: "frame", frame: frame(1) });
	controller.abort();
	await subscription.dispose();
	assert.equal(f.disposed, 1);
	assert.deepEqual(statuses, [{ state: "connected" }, { state: "closed", reason: "disposed" }]);
	await f.emit({ kind: "frame", frame: frame(2) });
	assert.equal(calls, 1);
	release();
	await pending;
});

test("host closure and callback errors terminate observation exactly once", async () => {
	for (const callbackThrows of [false, true]) {
		const f = fixture();
		const statuses: ObservationStatus[] = [];
		const subscription = await f.client.observe(
			scope,
			(value) => {
				if (callbackThrows && value.version > 0) throw new Error("consumer failure");
			},
			undefined,
			(status) => statuses.push(status),
		);
		if (callbackThrows) await f.emit({ kind: "frame", frame: frame(1) });
		else await f.emit({ kind: "status", status: { state: "closed", reason: "disconnected", code: "CLOSED" } });
		await subscription.dispose();
		assert.equal(statuses.length, 2);
		assert.equal(f.disposed, 1);
	}
});

test("healthy desktop observations stay connected through long idle periods and resume delivery", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	const statuses: ObservationStatus[] = [];
	const seen: number[] = [];
	const subscription = await f.client.observe(
		scope,
		(value) => {
			seen.push(value.version);
		},
		undefined,
		(status) => statuses.push(status),
	);
	try {
		context.mock.timers.tick(65000);
		assert.deepEqual(statuses, [{ state: "connected" }]);
		assert.equal(f.disposed, 0);
		context.mock.timers.tick(24 * 60 * 60 * 1000);
		await f.emit({ kind: "frame", frame: frame(1) });
		assert.deepEqual(seen, [0, 1]);
		assert.deepEqual(statuses, [{ state: "connected" }]);
		assert.equal(f.requests.length, 1);
	} finally {
		await subscription.dispose();
	}
	context.mock.timers.tick(65000);
	assert.equal(f.disposed, 1);
	assert.deepEqual(statuses, [{ state: "connected" }, { state: "closed", reason: "disposed" }]);
});

test("ongoing desktop frames do not expire and genuine host loss still closes once", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	const statuses: ObservationStatus[] = [];
	const seen: number[] = [];
	const subscription = await f.client.observe(
		scope,
		(value) => {
			seen.push(value.version);
		},
		undefined,
		(status) => statuses.push(status),
	);
	try {
		for (let version = 1; version <= 20; version++) {
			context.mock.timers.tick(5000);
			await f.emit({ kind: "frame", frame: frame(version) });
		}
		assert.deepEqual(
			seen,
			Array.from({ length: 21 }, (_, version) => version),
		);
		assert.deepEqual(statuses, [{ state: "connected" }]);
		assert.equal(f.disposed, 0);
		await f.emit({ kind: "status", status: { state: "closed", reason: "disconnected", code: "CLOSED" } });
		await f.emit({ kind: "frame", frame: frame(21) });
		assert.equal(seen.length, 21);
		assert.deepEqual(statuses, [{ state: "connected" }, { state: "closed", reason: "disconnected", code: "CLOSED" }]);
		assert.equal(f.disposed, 1);
	} finally {
		await subscription.dispose();
	}
	assert.equal(f.requests.length, 1);
	assert.equal(f.disposed, 1);
});

test("request deadlines remain bounded and never replay a command with an unknown outcome", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	await f.client.call("handshake", {});
	let complete: (value: unknown) => void = () => {};
	f.setReply(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const pending = f.client.call("submit", { ...scope, requestId: "original", text: "original" });
	const rejected = assert.rejects(pending, { code: "CLOSED" });
	context.mock.timers.tick(10000);
	await rejected;
	complete({ ok: true, result: { ...scope, requestId: "original", receiptId: "receipt", state: "accepted" } });
	await Promise.resolve();
	context.mock.timers.tick(65000);
	assert.equal(f.requests.length, 2);
	assert.deepEqual(f.requests[1]?.params, { ...scope, requestId: "original", text: "original" });
});

test("a silent host has bounded startup and does not report connected without a snapshot", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture(false);
	await f.client.call("handshake", {});
	const statuses: ObservationStatus[] = [];
	const observation = f.client.observe(
		scope,
		() => {},
		undefined,
		(status) => statuses.push(status),
	);
	const rejected = assert.rejects(observation, { code: "CLOSED" });
	await f.emit({ kind: "status", status: { state: "connected" } });
	assert.deepEqual(statuses, []);
	context.mock.timers.tick(10000);
	await rejected;
	assert.equal(f.disposed, 1);
});

test("terminal before initial snapshot rejects startup and releases the subscription", async () => {
	const f = fixture(false);
	await f.client.call("handshake", {});
	const observation = f.client.observe(scope, () => {});
	await f.emit({ kind: "status", status: { state: "closed", reason: "error", code: "STORE_MISMATCH" } });
	await assert.rejects(observation, { code: "STORE_MISMATCH" });
	assert.equal(f.disposed, 1);
});

test("cancel during initial handshake does not start a late observation", async () => {
	let finish: (value: unknown) => void = () => {};
	let subscribed = 0;
	const client = createDesktopClient({
		request: () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
		subscribe: () => {
			subscribed++;
			return () => {};
		},
	});
	const controller = new AbortController();
	const observation = client.observe(scope, () => {}, controller.signal);
	controller.abort();
	await assert.rejects(observation, { code: "CLOSED" });
	finish(handshake);
	await Promise.resolve();
	assert.equal(subscribed, 0);
});

test("synchronous terminal callbacks and throwing disposers do not escape cleanup", async () => {
	let disposed = 0;
	const client = createDesktopClient({
		request: async () => handshake,
		subscribe(_input, callback) {
			void callback({ kind: "status", status: { state: "closed", reason: "disconnected" } });
			return () => {
				disposed++;
				throw new Error("host gone");
			};
		},
	});
	await assert.rejects(
		client.observe(scope, () => {}),
		{ code: "CLOSED" },
	);
	assert.equal(disposed, 1);
});

test("unknown envelope keys fail closed", async () => {
	const f = fixture();
	await f.client.call("handshake", {});
	f.setReply(async () => ({ ok: false, error: "CLOSED", privatePath: "/secret" }));
	await assert.rejects(f.client.call("listWorkspaces", {}), { code: "INVALID_REQUEST" });
	const subscription = await f.client.observe(scope, () => {});
	await f.emit({ kind: "frame", frame: frame(1), unexpected: true });
	assert.equal(f.disposed, 1);
	await subscription.dispose();
});

test("late callbacks from a disposed generation do not overwrite a replacement observation", async () => {
	const callbacks: Array<(event: unknown) => void | Promise<void>> = [];
	const client = createDesktopClient({
		request: async () => handshake,
		subscribe(_input, callback) {
			callbacks.push(callback);
			queueMicrotask(() => {
				void callback({ kind: "frame", frame: frame(0) });
			});
			return () => {};
		},
	});
	const oldFrames: number[] = [];
	const newFrames: number[] = [];
	const first = await client.observe(scope, (value) => {
		oldFrames.push(value.version);
	});
	await first.dispose();
	const second = await client.observe(scope, (value) => {
		newFrames.push(value.version);
	});
	await callbacks[0]?.({ kind: "frame", frame: frame(99) });
	await callbacks[1]?.({ kind: "frame", frame: frame(1) });
	assert.deepEqual(oldFrames, [0]);
	assert.deepEqual(newFrames, [0, 1]);
	await second.dispose();
});
