import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { type AppClient, AppError, type ObservationStatus, PROTOCOL_VERSION } from "../src/contracts.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";
import { fixtureRuntime, fixtureTransport } from "./transport-fixture.ts";

const origin = "http://127.0.0.1:4000";
const scope = { workspaceId: "test", conversationId: "conversation" };
async function conformance(client: AppClient) {
	assert.deepEqual(await client.call("handshake", {}), {
		protocolVersion: PROTOCOL_VERSION,
		storeId: "fixture-store",
	});
	assert.deepEqual(await client.call("listModels", {}), {
		models: [{ provider: "faux", modelId: "faux-1", name: "Fixture" }],
		providers: [{ provider: "faux", name: "Fixture", credentialState: "configured" }],
	});
	const configuration = {
		model: { provider: "faux", modelId: "faux-1" },
		credentialState: "configured",
		executionState: "ready",
	};
	assert.deepEqual(await client.call("getConversationModel", scope), configuration);
	assert.deepEqual(await client.call("cancelExecution", scope), configuration);
	assert.deepEqual(await client.call("continueWorkspace", { workspaceId: "test" }), {
		workspaceId: "test",
		state: "authorized",
	});
	assert.deepEqual(await client.call("listWorkspaces", {}), {
		items: [{ workspaceId: "test", name: "Test" }],
		nextCursor: null,
	});
	assert.deepEqual(await client.call("listConversations", { workspaceId: "test" }), {
		items: [{ ...scope, title: "One", revision: 1, createdAt: null, archivedAt: null }],
		nextCursor: null,
	});
	assert.deepEqual(await client.call("createWorkspace", { workspaceId: "test", name: "Test" }), {
		workspaceId: "test",
		name: "Test",
	});
	assert.equal(
		(await client.call("createConversation", { requestId: "create-1", workspaceId: "test", title: "One" })).title,
		"One",
	);
	assert.deepEqual(await client.call("getHistory", scope), { ...scope, messages: [], nextCursor: null });
	await assert.rejects(client.call("getMessageText", { ...scope, messageId: "missing", offset: 0 }), {
		code: "NOT_FOUND",
	});
	const input = { ...scope, requestId: "request", text: "Hello" };
	const receipt = await client.call("submit", input);
	assert.equal(receipt.state, "dispatched");
	assert.deepEqual(await client.call("submit", input), receipt);
	await assert.rejects(
		client.call("submit", { ...input, text: "Changed" }),
		(error) => error instanceof AppError && error.code === "IDEMPOTENCY_CONFLICT",
	);
	assert.equal(
		(await client.call("getReceipt", { workspaceId: "test", requestId: "request" }))?.receiptId,
		receipt.receiptId,
	);
	await assert.rejects(
		client.observe({ ...scope, workspaceId: "missing" }, () => {}),
		(error) => error instanceof AppError && error.code === "NOT_FOUND",
	);
	await assert.rejects(
		client.call("openWorkspace", { workspaceId: "../unsafe" }),
		(error) => error instanceof AppError && error.code === "INVALID_REQUEST",
	);
	await assert.rejects(
		client.call("openWorkspace", { workspaceId: "missing" }),
		(error) => error instanceof AppError && error.code === "NOT_FOUND",
	);
	const signal = new AbortController();
	const statuses: ObservationStatus[] = [];
	let firstFrame: (() => void) | undefined;
	const observed = new Promise<void>((resolve) => {
		firstFrame = resolve;
	});
	const subscription = await client.observe(
		scope,
		(frame) => {
			assert.equal(frame.snapshot.workspaceId, "test");
			firstFrame?.();
		},
		signal.signal,
		async (status) => {
			statuses.push(status);
			throw new Error("Status callback rejection must be isolated");
		},
	);
	await observed;
	signal.abort();
	await subscription.dispose();
	assert.deepEqual(statuses, [{ state: "connected" }, { state: "closed", reason: "disposed" }]);
	// Cancellation is asynchronous over the wire; query until the service confirms resource release.
	for (let i = 0; i < 50; i++) {
		if ((await client.call("snapshot", scope)).partial === "0") break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal((await client.call("snapshot", scope)).partial, "0");
	const wait = new AbortController();
	const submission = client.call("submit", { ...input, requestId: "after-cancel" }, wait.signal);
	await new Promise((resolve) => setTimeout(resolve, 15));
	wait.abort();
	await assert.rejects(submission);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(
		(await client.call("getReceipt", { workspaceId: "test", requestId: "after-cancel" }))?.state,
		"dispatched",
	);
}

test(
	"HTTP loopback uses the same application semantics and releases cancelled subscriptions",
	{ timeout: 15000 },
	async () => {
		const runtime = fixtureRuntime();
		const server = await serveLoopback(runtime, { origin });
		try {
			await conformance(createHttpClient({ ...server, origin }));
		} finally {
			await server.close();
			await runtime.close();
		}
	},
);

test("Node child IPC uses the same semantics; disconnect rejects pending waits", { timeout: 15000 }, async () => {
	const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--transport-fixture"], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const client = createNodeIpcClient(child);
	try {
		await conformance(client);
		const statuses: ObservationStatus[] = [];
		await client.observe(
			scope,
			() => {},
			undefined,
			(status) => {
				statuses.push(status);
			},
		);
		const pending = client.call("submit", { ...scope, requestId: "disconnect", text: "Hello" });
		child.disconnect();
		await assert.rejects(pending, (error) => error instanceof AppError && error.code === "CLOSED");
		assert.deepEqual(statuses.at(-1), { state: "closed", reason: "disconnected" });
	} finally {
		client.close();
		if (child.exitCode === null) {
			child.kill();
			await once(child, "exit");
		}
	}
});

test(
	"HTTP rejects missing auth, malicious Origin, malformed payload, excessive body and Host",
	{ timeout: 15000 },
	async () => {
		const runtime = fixtureRuntime();
		const server = await serveLoopback(runtime, { origin });
		try {
			const headers = {
				Origin: origin,
				Authorization: `Bearer ${server.token}`,
				"Content-Type": "application/json",
			};
			const body = JSON.stringify({
				version: PROTOCOL_VERSION,
				method: "openWorkspace",
				params: { workspaceId: "test" },
			});
			for (const [patch, status] of [
				[{ Authorization: "wrong" }, 401],
				[{ Origin: "https://evil.example" }, 403],
			] as const) {
				const response = await fetch(`${server.url}/call`, {
					method: "POST",
					headers: { ...headers, ...patch },
					body,
				});
				assert.equal(response.status, status);
				assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
			}
			const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
				const raw = request(
					`${server.url}/call`,
					{ method: "POST", headers: { ...headers, Host: "evil.example" } },
					(response) => {
						response.resume();
						response.on("end", () => resolve(response.statusCode));
					},
				);
				raw.on("error", reject);
				raw.end(body);
			});
			assert.equal(rejectedHost, 403);
			const invalid = await fetch(`${server.url}/call`, { method: "POST", headers, body: "{" });
			assert.equal(invalid.status, 400);
			assert.deepEqual(await invalid.json(), { error: "INVALID_REQUEST" });
			const tooLarge = await fetch(`${server.url}/call`, { method: "POST", headers, body: " ".repeat(1048577) });
			assert.equal(tooLarge.status, 413);
			await tooLarge.body?.cancel();
			for (const key of ["secret", "toString", "__proto__"]) {
				const extra = await fetch(`${server.url}/call`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						version: PROTOCOL_VERSION,
						method: "openWorkspace",
						params: { workspaceId: "test", [key]: "ignored?" },
					}),
				});
				assert.equal(extra.status, 400);
				await extra.body?.cancel();
			}
		} finally {
			await server.close();
			await runtime.close();
		}
	},
);

test(
	"HTTP subscription expiry and disconnect are explicit; manual reconnect gets a snapshot",
	{ timeout: 15000 },
	async () => {
		const runtime = fixtureRuntime();
		const server = await serveLoopback(runtime, { origin, subscriptionTimeoutMs: 50 });
		let closed = false;
		try {
			const client = createHttpClient({ ...server, origin });
			const statuses: ObservationStatus[] = [];
			const watcher = await client.observe(
				scope,
				() => {},
				undefined,
				(status) => {
					statuses.push(status);
				},
			);
			for (let i = 0; i < 100 && statuses.at(-1)?.state !== "closed"; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			assert.deepEqual(statuses.at(-1), { state: "closed", reason: "expired" });
			await watcher.dispose();
			assert.deepEqual(statuses.at(-1), { state: "closed", reason: "expired" });
			const reconnected: ObservationStatus[] = [];
			let frames = 0;
			await client.observe(
				scope,
				() => {
					frames++;
				},
				undefined,
				(status) => {
					reconnected.push(status);
				},
			);
			for (let i = 0; i < 100 && frames === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
			assert.ok(frames > 0);
			await server.close();
			closed = true;
			for (let i = 0; i < 100 && reconnected.at(-1)?.state !== "closed"; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			assert.deepEqual(reconnected.at(-1), { state: "closed", reason: "disconnected" });
		} finally {
			if (!closed) await server.close();
			await runtime.close();
		}
	},
);

test("HTTP dispose releases the stream even when its consumer never resolves", { timeout: 5000 }, async () => {
	const runtime = fixtureRuntime();
	const server = await serveLoopback(runtime, { origin });
	try {
		const statuses: ObservationStatus[] = [];
		let seen = false;
		const watcher = await createHttpClient({ ...server, origin }).observe(
			scope,
			() => {
				seen = true;
				return new Promise<void>(() => {});
			},
			undefined,
			(status) => {
				statuses.push(status);
			},
		);
		for (let i = 0; i < 100 && !seen; i++) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(seen, true);
		await watcher.dispose();
		assert.deepEqual(statuses.at(-1), { state: "closed", reason: "disposed" });
	} finally {
		await server.close();
		await runtime.close();
	}
});

test(
	"source failure closes both transports explicitly; IPC adapter shutdown disconnects ready observers",
	{ timeout: 15000 },
	async () => {
		const runtime = fixtureRuntime();
		const server = await serveLoopback(fixtureTransport(runtime), { origin });
		const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--transport-fixture"], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const ipc = createNodeIpcClient(child);
		try {
			for (const client of [createHttpClient({ ...server, origin }), ipc]) {
				const statuses: ObservationStatus[] = [];
				const watcher = await client.observe(
					{ ...scope, conversationId: "source-close" },
					() => {},
					undefined,
					(status) => {
						statuses.push(status);
					},
				);
				for (let i = 0; i < 100 && statuses.at(-1)?.state !== "closed"; i++)
					await new Promise((resolve) => setTimeout(resolve, 5));
				assert.deepEqual(statuses.at(-1), { state: "closed", reason: "error", code: "INTERNAL" });
				await watcher.dispose();
			}
			const statuses: ObservationStatus[] = [];
			await ipc.observe(
				scope,
				() => {},
				undefined,
				(status) => {
					statuses.push(status);
				},
			);
			child.send("close-adapter");
			for (let i = 0; i < 100 && statuses.at(-1)?.state !== "closed"; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			assert.deepEqual(statuses.at(-1), { state: "closed", reason: "disconnected" });
		} finally {
			ipc.close();
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill();
				await exited;
			}
			await server.close();
			await runtime.close();
		}
	},
);
