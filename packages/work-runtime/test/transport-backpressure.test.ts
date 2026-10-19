import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import test from "node:test";
import { type Frame, LIMITS, type ObservationStatus } from "../src/contracts.ts";
import { serveLoopback, type TransportRuntime } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { fixtureRuntime } from "./transport-fixture.ts";

const origin = "http://127.0.0.1:4000";
const scope = { workspaceId: "test", conversationId: "conversation" };
const frame: Frame = {
	kind: "snapshot",
	epoch: "backpressure",
	version: 1,
	snapshot: {
		...scope,
		messages: [],
		partial: "界".repeat(LIMITS.partialPreview),
		partialLength: LIMITS.partialPreview,
		partialTruncated: false,
		historyCursor: null,
		running: false,
	},
};

test("HTTP delivers legal frames above Windows' 16 KiB high-water mark in order", { timeout: 10000 }, async (t) => {
	const previous = getDefaultHighWaterMark(false);
	setDefaultHighWaterMark(false, 16 * 1024);
	t.after(() => setDefaultHighWaterMark(false, previous));
	const runtime = fixtureRuntime();
	const disposed = Promise.withResolvers<void>();
	const transport: TransportRuntime = {
		execute: (request) => runtime.execute(request),
		async observe(_scope, listener) {
			await listener(frame);
			await listener({ ...frame, version: 2 });
			return {
				async dispose() {
					disposed.resolve();
				},
			};
		},
	};
	const server = await serveLoopback(transport, { origin });
	const received = Promise.withResolvers<void>();
	void received.promise.catch(() => {});
	const versions: number[] = [];
	const client = createHttpClient({ ...server, origin });
	let subscription: Awaited<ReturnType<typeof client.observe>> | undefined;
	try {
		assert.ok(Buffer.byteLength(JSON.stringify(frame)) > 16 * 1024);
		assert.ok(Buffer.byteLength(JSON.stringify(frame)) < LIMITS.frameBytes);
		subscription = await client.observe(
			scope,
			(value) => {
				assert.deepEqual(value.snapshot, frame.snapshot);
				versions.push(value.version);
				if (versions.length === 2) received.resolve();
			},
			t.signal,
			(status) => {
				if (status.state === "closed") received.reject(new Error(`Observation closed: ${status.reason}`));
			},
		);
		await received.promise;
		assert.deepEqual(versions, [1, 2]);
		await subscription.dispose();
		await disposed.promise;
	} finally {
		await subscription?.dispose();
		await server.close();
		await runtime.close();
	}
});

for (const end of [
	"server-close",
	"client-abort",
	"response-error",
	"response-finish",
	"source-close",
	"concurrent-write",
	"drain-timeout",
	"subscription-expiry",
] as const) {
	test(`HTTP stalled drain releases delivery and listeners on ${end}`, { timeout: 20000 }, async (t) => {
		const runtime = fixtureRuntime();
		const entered = Promise.withResolvers<ServerResponse>();
		const delivered = Promise.withResolvers<void>();
		const disposed = Promise.withResolvers<void>();
		const terminal = Promise.withResolvers<ObservationStatus>();
		const timers: { handle: ReturnType<typeof setTimeout>; delay: number | undefined }[] = [];
		const clearedTimers = new Set<ReturnType<typeof setTimeout>>();
		const timerCase = end === "drain-timeout" || end === "subscription-expiry";
		if (timerCase) {
			// Observe real timer allocation/cleanup without shortening the production drain deadline or mocking sockets.
			const schedule = globalThis.setTimeout;
			const clear = globalThis.clearTimeout;
			t.mock.method(
				globalThis,
				"setTimeout",
				<T extends unknown[]>(callback: (...args: T) => void, delay?: number, ...args: T) => {
					const handle = schedule(callback, delay, ...args);
					timers.push({ handle, delay });
					return handle;
				},
			);
			t.mock.method(globalThis, "clearTimeout", (handle: Parameters<typeof clearTimeout>[0]) => {
				if (handle && typeof handle === "object") clearedTimers.add(handle);
				clear(handle);
			});
		}
		let deliveryCompleted = false;
		let closeSource = () => {};
		let concurrentWrite: () => void | Promise<void> = () => {};
		const write = ServerResponse.prototype.write;
		// Keep real HTTP and force only the sink's drain to stall, without filling OS-dependent TCP buffers.
		t.mock.method(
			ServerResponse.prototype,
			"write",
			function (this: ServerResponse, ...args: Parameters<typeof write>) {
				const result = write.apply(this, args);
				if (typeof args[0] !== "string" || !args[0].startsWith("data: ")) return result;
				Object.defineProperty(this, "writableNeedDrain", { configurable: true, value: true });
				const emit = this.emit;
				t.mock.method(this, "emit", function (this: ServerResponse, event: string | symbol, ...values: unknown[]) {
					return event === "drain" ? false : emit.call(this, event, ...values);
				});
				entered.resolve(this);
				return false;
			},
		);
		const transport: TransportRuntime = {
			execute: (request) => runtime.execute(request),
			async observe(_scope, listener, _signal, onStatus) {
				closeSource = () => onStatus?.({ state: "closed", reason: "error", code: "INTERNAL" });
				concurrentWrite = () => listener({ ...frame, version: 2 });
				await listener(frame);
				deliveryCompleted = true;
				delivered.resolve();
				return {
					async dispose() {
						disposed.resolve();
					},
				};
			},
		};
		const subscriptionTimeoutMs = end === "subscription-expiry" ? 1000 : 60000;
		const server = await serveLoopback(transport, { origin, subscriptionTimeoutMs });
		let closing: Promise<void> | undefined;
		const closeServer = () => {
			closing ??= server.close();
			return closing;
		};
		t.after(closeServer);
		const abort = new AbortController();
		const client = createHttpClient({ ...server, origin });
		let subscription: Awaited<ReturnType<typeof client.observe>> | undefined;
		try {
			subscription = await client.observe(
				scope,
				() => {},
				AbortSignal.any([abort.signal, t.signal]),
				(status) => {
					if (status.state === "closed") terminal.resolve(status);
				},
			);
			const response = await entered.promise;
			assert.equal(response.listenerCount("drain"), 1);
			assert.equal(response.listenerCount("error"), 1);
			assert.equal(deliveryCompleted, false, "producer must wait for drain instead of queuing more frames");
			if (end === "server-close") await closeServer();
			else if (end === "client-abort") abort.abort();
			else if (end === "response-error") response.destroy(new Error("stalled sink failed"));
			else if (end === "source-close") closeSource();
			else if (end === "concurrent-write") await concurrentWrite();
			else if (end === "response-finish") response.end();
			await delivered.promise;
			await disposed.promise;
			assert.equal(response.listenerCount("drain"), 0);
			assert.equal(response.listenerCount("error"), 0);
			if (timerCase) {
				assert.equal(response.destroyed, true);
				assert.deepEqual(await terminal.promise, { state: "closed", reason: "disconnected" });
				for (const delay of [10000, subscriptionTimeoutMs]) {
					const scheduled = timers.filter((timer) => timer.delay === delay);
					assert.equal(scheduled.length, 1, `expected one ${delay} ms maintenance timer`);
					assert.ok(clearedTimers.has(scheduled[0].handle), `${delay} ms timer must be cleared`);
				}
			}
		} finally {
			abort.abort();
			await subscription?.dispose();
			await closeServer();
			await runtime.close();
		}
	});
}
