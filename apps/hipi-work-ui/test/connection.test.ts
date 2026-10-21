import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { type AppClient, AppError, PROTOCOL_VERSION, parseResult } from "@hipi/work-runtime/contracts";
import {
	acquireStoreLease,
	connectionFailure,
	StoreInUseError,
	UnsupportedBrowserError,
	verifyConnection,
} from "../src/app/connection.ts";

// Observe the actual native request promises; do not replace Web Locks with a mock.
class NativeLockRequests implements LockManager {
	readonly requests: Promise<unknown>[] = [];
	query(): Promise<LockManagerSnapshot> {
		return navigator.locks.query();
	}
	request<T>(name: string, callback: LockGrantedCallback<T>): Promise<Awaited<T>>;
	request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<Awaited<T>>;
	request<T>(
		name: string,
		options: LockOptions | LockGrantedCallback<T>,
		callback?: LockGrantedCallback<T>,
	): Promise<Awaited<T>> {
		let request: Promise<Awaited<T>>;
		if (typeof options === "function") request = navigator.locks.request(name, options);
		else {
			assert.ok(callback);
			request = navigator.locks.request(name, options, callback);
		}
		this.requests.push(request);
		return request;
	}
	async released(): Promise<void> {
		const settled = await Promise.allSettled(this.requests.splice(0));
		for (const result of settled) {
			if (result.status === "rejected") assert.ok(result.reason instanceof StoreInUseError);
		}
		const snapshot = await this.query();
		assert.deepEqual(snapshot.held, [], "native held locks remain after release");
		assert.deepEqual(snapshot.pending, [], "native pending locks remain after release");
	}
}

function clientReturning(result: unknown | Promise<unknown>): AppClient {
	return {
		async call(method) {
			return parseResult(method, await result);
		},
		async observe() {
			throw new Error("Not used during handshake");
		},
	};
}

test("connection waits for a valid handshake before exposing trusted store identity", async () => {
	let complete: (result: unknown) => void = () => {};
	const response = new Promise<unknown>((resolve) => {
		complete = resolve;
	});
	let resolved = false;
	const verified = verifyConnection(clientReturning(response), new AbortController().signal).then((storeId) => {
		resolved = true;
		return storeId;
	});
	await Promise.resolve();
	assert.equal(resolved, false);
	complete({ protocolVersion: PROTOCOL_VERSION, storeId: "store-a" });
	assert.equal(await verified, "store-a");
});

test("malformed protocol and store identity never authorize restoration", async () => {
	for (const response of [
		{ protocolVersion: 999, storeId: "store" },
		{ protocolVersion: PROTOCOL_VERSION - 1, storeId: "store" },
		{ protocolVersion: PROTOCOL_VERSION, storeId: "../other" },
		{ storeId: "store" },
		null,
	]) {
		await assert.rejects(verifyConnection(clientReturning(response), new AbortController().signal), {
			code: "INVALID_REQUEST",
		});
	}
});

test("an aborted old handshake cannot become an active connection even if the client resolves late", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		verifyConnection(clientReturning({ protocolVersion: PROTOCOL_VERSION, storeId: "store" }), controller.signal),
		{
			name: "AbortError",
		},
	);
});

test("authentication, browser network and malformed response errors stay distinct", () => {
	assert.equal(connectionFailure(new AppError("UNAUTHORIZED")), "authError");
	assert.equal(connectionFailure(new TypeError("Failed to fetch")), "networkError");
	assert.equal(connectionFailure(new SyntaxError("Invalid JSON")), "protocolError");
	assert.equal(connectionFailure(new AppError("INVALID_REQUEST")), "protocolError");
	assert.equal(connectionFailure(new AppError("INTERNAL")), "runtimeError");
	assert.equal(connectionFailure(new StoreInUseError()), "inUse");
	assert.equal(connectionFailure(new UnsupportedBrowserError()), "unsupportedBrowser");
});

test("store editing lease excludes another tab until explicit disconnect release", async (t) => {
	const locks = new NativeLockRequests();
	const first = await acquireStoreLease("lease-test-store", locks);
	try {
		await assert.rejects(acquireStoreLease("lease-test-store", locks), StoreInUseError);
		const other = await acquireStoreLease("lease-other-store", locks);
		other.release();
	} finally {
		first.release();
	}
	await locks.released();
	const reconnected = await acquireStoreLease("lease-test-store", locks);
	reconnected.release();
	await locks.released();
	t.diagnostic("native lease requests settled; held and pending locks are empty");
});

test("missing browser Web Locks fails closed", async () => {
	await assert.rejects(acquireStoreLease("store", undefined), UnsupportedBrowserError);
});

test("abrupt owner termination releases the native store lease", async (t) => {
	const locks = new NativeLockRequests();
	const worker = new Worker(new URL("./fixtures/lease-worker.ts", import.meta.url));
	try {
		assert.deepEqual(await once(worker, "message"), ["acquired"]);
		await assert.rejects(acquireStoreLease("terminated-owner-store", locks), StoreInUseError);
	} finally {
		assert.equal(await worker.terminate(), 1, "abrupt worker termination must finish");
		assert.equal(worker.threadId, -1, "terminated worker must no longer have a thread");
	}
	await locks.released();
	t.diagnostic("abrupt worker termination completed; native held and pending locks are empty");
	const recovered = await acquireStoreLease("terminated-owner-store", locks);
	recovered.release();
	await locks.released();
	t.diagnostic("recovered native lease request settled; held and pending locks are empty");
});
