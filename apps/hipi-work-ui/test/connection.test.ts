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

test("store editing lease excludes another tab until explicit disconnect release", async () => {
	const first = await acquireStoreLease("lease-test-store", navigator.locks);
	try {
		await assert.rejects(acquireStoreLease("lease-test-store", navigator.locks), StoreInUseError);
		const other = await acquireStoreLease("lease-other-store", navigator.locks);
		other.release();
	} finally {
		first.release();
	}
	// Let the completed lock callback release its native lease before reconnecting.
	await new Promise((resolve) => setTimeout(resolve, 0));
	const reconnected = await acquireStoreLease("lease-test-store", navigator.locks);
	reconnected.release();
});

test("missing browser Web Locks fails closed", async () => {
	await assert.rejects(acquireStoreLease("store", undefined), UnsupportedBrowserError);
});

test("abrupt owner termination releases the native store lease", async () => {
	const worker = new Worker(new URL("./fixtures/lease-worker.ts", import.meta.url));
	try {
		await once(worker, "message");
		await assert.rejects(acquireStoreLease("terminated-owner-store", navigator.locks), StoreInUseError);
	} finally {
		await worker.terminate();
	}
	const recovered = await acquireStoreLease("terminated-owner-store", navigator.locks);
	recovered.release();
});
