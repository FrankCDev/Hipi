import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ErrorCode,
	type Frame,
	PROTOCOL_VERSION,
	type Request,
	type Snapshot,
} from "@hipi/work-runtime/contracts";
import { createDesktopClient, type DesktopBridge } from "../src/app/desktop-client.ts";
import {
	OBSERVATION_RECOVERY_DELAYS_MS,
	OBSERVATION_STABLE_CONNECTION_MS,
	type ObservationConnection,
	observeConversation,
} from "../src/features/workbench/observation-session.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function frame(partial: string, epoch = "epoch", version = 0): Frame {
	return {
		kind: "snapshot",
		epoch,
		version,
		snapshot: {
			...scope,
			messages: [],
			partial,
			partialLength: partial.length,
			partialTruncated: false,
			historyCursor: null,
			running: false,
		},
	};
}

function fixture(initialHandshakeError?: ErrorCode) {
	const calls: Request[] = [];
	const callbacks: Array<Parameters<DesktopBridge["subscribe"]>[1]> = [];
	const states: ObservationConnection[] = [];
	const snapshots: Snapshot[] = [];
	let active = 0;
	let released = 0;
	let handshakeError = initialHandshakeError;
	let storeId = "store";
	let epoch = "epoch";
	let snapshotScope = scope;
	let replyWait: Promise<void> | undefined;
	const client = createDesktopClient({
		async request(input) {
			const request = input as Request;
			calls.push(request);
			if (replyWait) await replyWait;
			if (request.method === "handshake")
				return handshakeError
					? { ok: false, error: handshakeError }
					: { ok: true, result: { protocolVersion: PROTOCOL_VERSION, storeId } };
			assert.equal(request.method, "snapshot", "Recovery can read, never send or resume execution");
			return { ok: true, result: { ...frame("preflight", epoch).snapshot, ...snapshotScope } };
		},
		subscribe(_input, listener) {
			callbacks.push(listener);
			active++;
			assert.equal(active, 1, "An old observation must be released before replacement");
			const next = frame(`observed-${callbacks.length}`, epoch);
			queueMicrotask(() => {
				void listener({ kind: "frame", frame: next });
			});
			return () => {
				active--;
				released++;
			};
		},
	});
	const subscription = observeConversation(
		client,
		scope,
		(snapshot) => snapshots.push(snapshot),
		(state) => states.push(state),
	);
	return {
		calls,
		callbacks,
		states,
		snapshots,
		subscription,
		get active() {
			return active;
		},
		get released() {
			return released;
		},
		setHandshakeError(error: ErrorCode) {
			handshakeError = error;
		},
		setStore(value: string) {
			storeId = value;
		},
		setEpoch(value: string) {
			epoch = value;
		},
		setSnapshotScope(value: typeof scope) {
			snapshotScope = value;
		},
		setReplyWait(value: Promise<void>) {
			replyWait = value;
		},
		async disconnect() {
			await callbacks.at(-1)?.({ kind: "status", status: { state: "closed", reason: "disconnected" } });
			await tick();
		},
	};
}

test("transient loss rebuilds one verified read-only observation without flashing stale content", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		await tick();
		assert.equal(f.states.at(-1)?.connection, "connected");
		await f.disconnect();
		assert.deepEqual(f.states.at(-1), { connection: "connecting", errorCode: null, showConnectionNotice: false });
		assert.equal(f.snapshots.at(-1)?.partial, "observed-1");
		assert.equal(f.active, 0);
		context.mock.timers.tick(249);
		await tick();
		assert.equal(f.callbacks.length, 1);
		context.mock.timers.tick(1);
		await tick();
		assert.equal(f.callbacks.length, 2);
		assert.equal(f.active, 1);
		assert.deepEqual(f.states.at(-1), { connection: "connected", errorCode: null, showConnectionNotice: false });
		assert.equal(f.snapshots.at(-1)?.partial, "observed-2");
		assert.deepEqual(
			f.calls.map((request) => request.method),
			["handshake", "snapshot", "handshake", "snapshot"],
		);
		await f.callbacks[0]?.({ kind: "frame", frame: frame("late-old-frame", "epoch", 99) });
		await f.callbacks[0]?.({ kind: "status", status: { state: "closed", reason: "error", code: "INTERNAL" } });
		assert.equal(f.snapshots.at(-1)?.partial, "observed-2");
		assert.equal(f.states.at(-1)?.connection, "connected");
		context.mock.timers.tick(65000);
		assert.equal(f.active, 1);
		assert.equal(f.states.at(-1)?.connection, "connected");
	} finally {
		await f.subscription.dispose();
	}
	assert.equal(f.active, 0);
	assert.equal(f.released, 2);
});

test("failed handshakes back off finitely, show a delayed notice, and never duplicate subscriptions", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		await tick();
		f.setHandshakeError("CLOSED");
		await f.disconnect();
		for (const delay of OBSERVATION_RECOVERY_DELAYS_MS) {
			const before = f.calls.length;
			context.mock.timers.tick(delay - 1);
			await tick();
			assert.equal(f.calls.length, before);
			context.mock.timers.tick(1);
			await tick();
			assert.equal(f.calls.length, before + 1);
		}
		assert.ok(f.states.slice(2).some((state) => state.connection === "connecting" && state.showConnectionNotice));
		assert.deepEqual(f.states.at(-1), { connection: "stale", errorCode: "CLOSED", showConnectionNotice: true });
		assert.equal(f.callbacks.length, 1);
		assert.equal(f.released, 1);
		context.mock.timers.tick(24 * 60 * 60 * 1000);
		await tick();
		assert.equal(f.calls.length, 2 + OBSERVATION_RECOVERY_DELAYS_MS.length);
		assert.equal(f.snapshots.at(-1)?.partial, "observed-1");
	} finally {
		await f.subscription.dispose();
	}
});

test("stable connections renew the outage budget but rapid flapping remains bounded", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		await tick();
		for (let outage = 0; outage < OBSERVATION_RECOVERY_DELAYS_MS.length + 1; outage++) {
			await f.disconnect();
			context.mock.timers.tick(250);
			await tick();
			assert.equal(f.states.at(-1)?.connection, "connected");
			context.mock.timers.tick(OBSERVATION_STABLE_CONNECTION_MS);
			await tick();
		}
		for (const delay of OBSERVATION_RECOVERY_DELAYS_MS) {
			await f.disconnect();
			context.mock.timers.tick(delay);
			await tick();
			assert.equal(f.states.at(-1)?.connection, "connected");
		}
		await f.disconnect();
		assert.equal(f.states.at(-1)?.connection, "stale");
		const attempts = f.callbacks.length;
		context.mock.timers.tick(65000);
		await tick();
		assert.equal(f.callbacks.length, attempts);
	} finally {
		await f.subscription.dispose();
	}
});

test("initial authorization and wrong-scope snapshots fail before any projection is cached", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	for (const kind of ["authorization", "scope"]) {
		const f = fixture(kind === "authorization" ? "UNAUTHORIZED" : undefined);
		try {
			if (kind === "scope") f.setSnapshotScope({ ...scope, workspaceId: "foreign" });
			await tick();
			assert.equal(f.snapshots.length, 0);
			assert.equal(f.callbacks.length, 0);
			assert.deepEqual(f.states.at(-1), {
				connection: "stale",
				errorCode: kind === "authorization" ? "UNAUTHORIZED" : "INVALID_REQUEST",
				showConnectionNotice: true,
			});
			context.mock.timers.tick(65000);
			await tick();
			assert.equal(f.calls.length, kind === "authorization" ? 1 : 2);
		} finally {
			await f.subscription.dispose();
		}
	}
});

test("changed store and authorization or protocol failures stop automatic recovery", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	for (const code of ["STORE_MISMATCH", "UNAUTHORIZED", "INVALID_REQUEST"] as const) {
		const f = fixture();
		try {
			await tick();
			if (code === "STORE_MISMATCH") f.setStore("replacement");
			else f.setHandshakeError(code);
			await f.disconnect();
			context.mock.timers.tick(250);
			await tick();
			assert.deepEqual(f.states.at(-1), { connection: "stale", errorCode: code, showConnectionNotice: true });
			context.mock.timers.tick(65000);
			await tick();
			assert.equal(f.callbacks.length, 1);
			assert.equal(f.calls.length, 3);
			assert.equal(f.snapshots.at(-1)?.partial, "observed-1");
		} finally {
			await f.subscription.dispose();
		}
	}
});

test("replacement runtime epochs never overwrite cached content or silently resume recovery", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		await tick();
		f.setEpoch("replacement-runtime");
		await f.disconnect();
		context.mock.timers.tick(250);
		await tick();
		assert.deepEqual(f.states.at(-1), { connection: "stale", errorCode: "CLOSED", showConnectionNotice: true });
		assert.equal(f.snapshots.at(-1)?.partial, "observed-1");
		assert.equal(f.snapshots.length, 2, "Neither unverified preflight nor replacement frame enters the cache");
		assert.equal(f.active, 0);
		assert.equal(f.released, 2);
		context.mock.timers.tick(65000);
		await tick();
		assert.equal(f.callbacks.length, 2);
	} finally {
		await f.subscription.dispose();
	}
});

test("navigation during backoff cancels recovery timers without changing cached state", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	await tick();
	await f.disconnect();
	await f.subscription.dispose();
	const stateCount = f.states.length;
	context.mock.timers.tick(65000);
	await tick();
	assert.equal(f.calls.length, 2);
	assert.equal(f.callbacks.length, 1);
	assert.equal(f.active, 0);
	assert.equal(f.states.length, stateCount);
});

test("unmount during recovery handshake suppresses late replies and does not create a new observation", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	await tick();
	let reply: () => void = () => {};
	f.setReplyWait(
		new Promise<void>((resolve) => {
			reply = resolve;
		}),
	);
	await f.disconnect();
	context.mock.timers.tick(250);
	await tick();
	assert.equal(f.calls.length, 3);
	await f.subscription.dispose();
	const stateCount = f.states.length;
	reply();
	await tick();
	context.mock.timers.tick(65000);
	assert.equal(f.calls.length, 3);
	assert.equal(f.callbacks.length, 1);
	assert.equal(f.states.length, stateCount);
	assert.equal(f.snapshots.at(-1)?.partial, "observed-1");
});
