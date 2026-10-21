import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LIMITS, PROTOCOL_VERSION, parseRequest, parseResult } from "../src/contracts.ts";
import { openTestRuntime } from "../src/testing.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient, serveNodeIpc } from "../src/transport-ipc.ts";

const origin = "http://127.0.0.1:5173";

test("HTTP and IPC reject obsolete and future requests before runtime admission", { timeout: 15000 }, async () => {
	let admissions = 0;
	const server = await serveLoopback(
		{
			async execute() {
				admissions++;
				throw new Error("Protocol mismatch must be rejected before runtime admission");
			},
			async observe() {
				throw new Error("Protocol mismatch must not start an observation");
			},
		},
		{ origin },
	);
	const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--protocol-admission-fixture"], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	try {
		for (const version of [7, 8, 13, PROTOCOL_VERSION + 1, PROTOCOL_VERSION]) {
			for (const method of ["handshake", "createWorkspace"]) {
				const request = {
					version,
					method,
					params: method === "handshake" ? {} : { workspaceId: "must-not-exist", name: "Blocked" },
					...(method === "handshake" ? {} : { expectedStoreId: "fixture-store" }),
				};
				const expected = version === PROTOCOL_VERSION ? "INTERNAL" : "INVALID_REQUEST";
				const response = await fetch(`${server.url}/call`, {
					method: "POST",
					headers: {
						Origin: origin,
						Authorization: `Bearer ${server.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(request),
				});
				assert.equal(response.status, version === PROTOCOL_VERSION ? 500 : 400);
				assert.deepEqual(await response.json(), { error: expected });
				const message = once(child, "message");
				child.send(JSON.stringify({ id: "protocol", kind: "call", request }));
				const [raw] = await message;
				assert.deepEqual(JSON.parse(String(raw)), { id: "protocol", kind: "error", error: expected });
			}
			assert.equal(admissions, version === PROTOCOL_VERSION ? 2 : 0);
		}
	} finally {
		const exited = once(child, "exit");
		child.kill();
		await exited;
		await server.close();
	}
});

test(
	"HTTP and IPC clients reject protocol 7 handshake results before sending commands or observing",
	{ timeout: 15000 },
	async () => {
		const methods: string[] = [];
		const server = createServer((request, response) => {
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				methods.push(parseRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))).method);
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ result: { protocolVersion: 7, storeId: "old-store" } }));
			})().catch(() => response.destroy());
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--stale-protocol-fixture"], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const ipc = createNodeIpcClient(child);
		try {
			for (const client of [
				createHttpClient({ url: `http://127.0.0.1:${address.port}`, token: "fixture-token", origin }),
				ipc,
			]) {
				await assert.rejects(client.call("createWorkspace", { workspaceId: "must-not-exist", name: "Blocked" }), {
					code: "INVALID_REQUEST",
				});
				await assert.rejects(
					client.observe({ workspaceId: "test", conversationId: "conversation" }, () => {
						assert.fail("Protocol mismatch must not deliver frames");
					}),
					{ code: "INVALID_REQUEST" },
				);
			}
			assert.deepEqual(methods, ["handshake", "handshake"]);
			const message = once(child, "message");
			child.send("received-methods");
			const [raw] = await message;
			assert.deepEqual(JSON.parse(String(raw)), {
				id: "inspection",
				kind: "result",
				result: ["handshake", "handshake"],
			});
		} finally {
			ipc.close();
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill();
				await exited;
			}
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	},
);

test("authenticated handshake is read-only and identity binding rejects replacement behind the same endpoint", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-identity-"));
	const a = await openTestRuntime(join(directory, "a"));
	const b = await openTestRuntime(join(directory, "b"));
	let active = a;
	const server = await serveLoopback(
		{ execute: (raw) => active.execute(raw), observe: (...args) => active.observe(...args) },
		{ origin },
	);
	try {
		const client = createHttpClient({ ...server, origin });
		const identity = await client.call("handshake", {});
		assert.notEqual(identity.storeId, (await b.call("handshake", {})).storeId);
		assert.deepEqual(await client.call("listWorkspaces", {}), { items: [], nextCursor: null });
		await client.call("createWorkspace", { workspaceId: "work", name: "Original" });
		const conversation = await client.call("createConversation", {
			requestId: "create-1",
			workspaceId: "work",
			title: "Original",
		});
		await b.call("createWorkspace", { workspaceId: "work", name: "Other" });
		active = b;
		for (const call of [
			() => client.call("handshake", {}),
			() => client.call("listWorkspaces", {}),
			() => client.call("createWorkspace", { workspaceId: "misdirected", name: "Must not exist" }),
			() =>
				client.call("submit", {
					workspaceId: "work",
					conversationId: conversation.conversationId,
					requestId: "original-request",
					text: "Must not send",
				}),
			() => client.call("getReceipt", { workspaceId: "work", requestId: "original-request" }),
			() => client.observe({ workspaceId: "work", conversationId: conversation.conversationId }, () => {}),
		])
			await assert.rejects(call(), { code: "STORE_MISMATCH" });
		assert.deepEqual(await b.call("listWorkspaces", {}), {
			items: [{ workspaceId: "work", name: "Other" }],
			nextCursor: null,
		});
		assert.equal(await b.call("getReceipt", { workspaceId: "work", requestId: "original-request" }), null);
		active = a;
		assert.deepEqual(await client.call("handshake", {}), identity);
	} finally {
		await server.close();
		await a.close();
		await b.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("handshake rejects bad auth, Origin and protocol without leaking identity; diagnostics are bounded and redacted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-handshake-auth-"));
	const runtime = await openTestRuntime(directory);
	const events: unknown[] = [];
	const server = await serveLoopback(runtime, {
		origin,
		onDiagnostic: (event) => {
			events.push(event);
			throw new Error("Consumer failure");
		},
	});
	try {
		const headers = { Origin: origin, Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
		for (const patch of [{ Authorization: "wrong-secret" }, { Origin: "http://127.0.0.1:5174" }]) {
			const response = await fetch(`${server.url}/call`, {
				method: "POST",
				headers: { ...headers, ...patch },
				body: JSON.stringify({ version: PROTOCOL_VERSION, method: "handshake", params: {} }),
			});
			assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
		}
		const response = await fetch(`${server.url}/call`, {
			method: "POST",
			headers,
			body: JSON.stringify({ version: PROTOCOL_VERSION + 1, method: "handshake", params: {} }),
		});
		assert.deepEqual(await response.json(), { error: "INVALID_REQUEST" });
		for (let i = 0; i < 20; i++) {
			const rejected = await fetch(`${server.url}/call`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					version: PROTOCOL_VERSION,
					method: "createWorkspace",
					params: { workspaceId: "secret", name: "Private title" },
				}),
			});
			assert.deepEqual(await rejected.json(), { error: "STORE_MISMATCH" });
		}
		assert.equal(events.length, 16);
		assert.equal(JSON.stringify(events).includes(server.token), false);
		assert.equal(JSON.stringify(events).includes("Private"), false);
		assert.deepEqual(events.slice(0, 3), [
			{ code: "UNAUTHORIZED", reason: "invalid_credentials" },
			{ code: "UNAUTHORIZED", reason: "origin_mismatch" },
			{ code: "INVALID_REQUEST" },
		]);
		assert.deepEqual(
			events.slice(3),
			Array.from({ length: 13 }, () => ({ code: "STORE_MISMATCH" })),
		);
		assert.deepEqual(await runtime.call("listWorkspaces", {}), { items: [], nextCursor: null });
	} finally {
		await server.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("IPC requires inherited channel and rejects unbound or wrong-store calls before application mutation", async () => {
	const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--transport-fixture"], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	try {
		for (const message of [
			{ id: "unbound", kind: "call", request: { version: PROTOCOL_VERSION, method: "listWorkspaces", params: {} } },
			{
				id: "wrong",
				kind: "call",
				request: {
					version: PROTOCOL_VERSION,
					expectedStoreId: "other",
					method: "createWorkspace",
					params: { workspaceId: "bad", name: "Wrong" },
				},
			},
			{
				id: "observe",
				kind: "observe",
				expectedStoreId: "other",
				scope: { workspaceId: "test", conversationId: "conversation" },
			},
		]) {
			const response = once(child, "message");
			child.send(JSON.stringify(message));
			const [raw] = await response;
			assert.deepEqual(JSON.parse(String(raw)), { id: message.id, kind: "error", error: "STORE_MISMATCH" });
		}
		assert.throws(
			() => serveNodeIpc({ execute: async () => null, observe: async () => ({ dispose: async () => {} }) }),
			{ code: "CLOSED" },
		);
	} finally {
		const exited = once(child, "exit");
		child.kill();
		await exited;
	}
});

test("directory and handshake contracts reject unknown fields, invalid identity and oversized lists", () => {
	for (const method of ["listWorkspaces", "listConversations"] as const)
		assert.throws(() => parseResult(method, []), { code: "INVALID_REQUEST" });
	assert.throws(() => parseRequest({ version: 3, method: "handshake", params: {} }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(
		() => parseRequest({ version: PROTOCOL_VERSION, method: "handshake", params: { credential: "not-accepted" } }),
		{
			code: "INVALID_REQUEST",
		},
	);
	assert.throws(() => parseResult("handshake", { protocolVersion: PROTOCOL_VERSION + 1, storeId: "valid" }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("handshake", { protocolVersion: PROTOCOL_VERSION, storeId: "../path" }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(
		() =>
			parseResult("listWorkspaces", {
				items: Array.from({ length: LIMITS.directoryPage + 1 }, () => ({ workspaceId: "work", name: "Test" })),
				nextCursor: null,
			}),
		{ code: "INVALID_REQUEST" },
	);
});
