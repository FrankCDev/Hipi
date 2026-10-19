import assert from "node:assert/strict";
import test from "node:test";
import { Cdp, endpoint, pageTarget } from "./cdp.mjs";

class Socket extends EventTarget {
	readyState = 1;
	sent = [];
	send(value) {
		this.sent.push(JSON.parse(value));
	}
	close() {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
	answer(value) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
	}
}
test("only a canonical literal loopback endpoint on the owned port is accepted", () => {
	assert.equal(
		endpoint("ws://127.0.0.1:1234/devtools/page/ab-12", 1234, "page"),
		"ws://127.0.0.1:1234/devtools/page/ab-12",
	);
	for (const value of [
		"ws://localhost:1234/devtools/page/a",
		"ws://0.0.0.0:1234/devtools/page/a",
		"ws://2130706433:1234/devtools/page/a",
		"ws://127.0.0.1:1235/devtools/page/a",
		"ws://user@127.0.0.1:1234/devtools/page/a",
		"ws://127.0.0.1:1234/devtools/page/a?x=1",
		"ws://127.0.0.1:1234/devtools/browser/a",
	])
		assert.throws(() => endpoint(value, 1234, "page"));
});
test("responses are correlated, protocol errors reject, events unsubscribe", async () => {
	const socket = new Socket();
	const cdp = new Cdp(socket);
	let events = 0;
	const off = cdp.onEvent(() => events++);
	const a = cdp.request("A");
	const b = cdp.request("B");
	socket.answer({ id: 2, result: { ok: 2 } });
	socket.answer({ method: "Log.entryAdded", params: {} });
	off();
	socket.answer({ method: "Log.entryAdded", params: {} });
	socket.answer({ id: 1, error: { code: -1 } });
	await assert.rejects(a, /CDP A failed/);
	assert.deepEqual(await b, { ok: 2 });
	assert.equal(events, 1);
	cdp.close();
});
test("timeout and transport close reject every outstanding request, no lingering timers", async () => {
	const socket = new Socket();
	const cdp = new Cdp(socket, 10);
	await assert.rejects(cdp.request("slow"), /timed out/);
	assert.equal(socket.readyState, 3);
	await assert.rejects(cdp.request("late"), /closed/);
	const other = new Socket();
	const connection = new Cdp(other);
	const pending = connection.request("pending");
	other.close();
	await assert.rejects(pending, /closed/);
});
test("malformed messages fail closed and quit does not await an unsupported acknowledgement", async () => {
	const socket = new Socket();
	const cdp = new Cdp(socket);
	cdp.requestQuit();
	assert.equal(socket.sent[0].method, "Browser.close");
	const pending = cdp.request("pending");
	socket.answer({ unexpected: true });
	await assert.rejects(pending, /Malformed/);
});

test("discovery selects only the exact application page and rejects ambiguous or remote targets", async (context) => {
	let targets = [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/page/blank" }];
	context.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(url, "http://127.0.0.1:1234/json/list");
		assert.equal(options.redirect, "error");
		return new Response(JSON.stringify(targets));
	});
	assert.equal(await pageTarget(1234), undefined);
	const app = {
		type: "page",
		url: "hipi-work://app/index.html",
		webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/page/app",
	};
	targets = [app];
	assert.equal(await pageTarget(1234), app.webSocketDebuggerUrl);
	targets = [app, app];
	await assert.rejects(pageTarget(1234), /Ambiguous/);
	targets = [{ ...app, webSocketDebuggerUrl: "ws://example.com:1234/devtools/page/app" }];
	await assert.rejects(pageTarget(1234), /endpoint/);
});

test("discovery rejects oversized streamed content without buffering the whole response", async (context) => {
	let cancelled = false;
	context.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(600 * 1024));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	await assert.rejects(pageTarget(1234), /too large/);
	assert.equal(cancelled, true);
});

test("early discovery rejection cancels error and oversized-header response bodies", async (context) => {
	let cancelled = 0;
	let status = 500;
	let headers = {};
	context.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled++;
					},
				}),
				{ status, headers },
			),
	);
	await assert.rejects(pageTarget(1234), /Invalid CDP discovery/);
	assert.equal(cancelled, 1);
	status = 200;
	headers = { "content-length": "2000000" };
	await assert.rejects(pageTarget(1234), /Invalid CDP discovery/);
	assert.equal(cancelled, 2);
});
