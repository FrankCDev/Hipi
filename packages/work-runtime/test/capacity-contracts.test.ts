import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
	AGENT_LIMITS,
	type AgentContext,
	AppError,
	type Conversation,
	LIMITS,
	PROTOCOL_VERSION,
	parseError,
	parseRequest,
	parseResult,
} from "../src/contracts.ts";
import { WorkRuntime } from "../src/core.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";
import { deniedFeatureReads } from "./feature-port-fixture.ts";
import { fixtureRuntime } from "./transport-fixture.ts";

const scope = { workspaceId: "test", conversationId: "conversation" };
const conversation: Conversation = { ...scope, title: "One", revision: 1, createdAt: null, archivedAt: null };
const grant: AgentContext = {
	...scope,
	requestId: "request",
	grantId: "grant",
	rootId: "root",
	pathPrefixes: ["src"],
	model: { provider: "faux", modelId: "faux-1" },
	expiresAt: 2000000000000,
	disclosureVersion: 1,
	revision: 2,
	status: "invalidated",
	purpose: "live-files",
};
function request(method: string, params: unknown) {
	return parseRequest({ version: PROTOCOL_VERSION, expectedStoreId: "fixture-store", method, params });
}

test("protocol 5 requires stable create identity and revision-bound directory mutations", () => {
	assert.equal(PROTOCOL_VERSION, 5);
	assert.throws(() => parseRequest({ version: 3, method: "listWorkspaces", params: {} }), { code: "INVALID_REQUEST" });
	const create = { workspaceId: "test", requestId: "create-1", title: "One" };
	assert.deepEqual(request("createConversation", create).params, create);
	for (const patch of [
		{ requestId: undefined },
		{ requestId: "" },
		{ requestId: "../request" },
		{ archivedAt: null },
	]) {
		assert.throws(() => request("createConversation", { ...create, ...patch }), { code: "INVALID_REQUEST" });
	}
	for (const method of ["renameConversation", "archiveConversation", "restoreConversation"]) {
		const params = {
			...scope,
			requestId: "mutation",
			expectedRevision: 1,
			...(method === "renameConversation" ? { title: "Renamed" } : {}),
		};
		assert.deepEqual(request(method, params).params, params);
		for (const patch of [
			{ expectedRevision: 0 },
			{ expectedRevision: 1.5 },
			{ requestId: undefined },
			{ resume: true },
			{ archivedAt: 1 },
		]) {
			assert.throws(() => request(method, { ...params, ...patch }), { code: "INVALID_REQUEST" });
		}
	}
	assert.throws(
		() => request("archiveConversation", { ...scope, requestId: "archive", expectedRevision: 1, title: "ignored" }),
		{ code: "INVALID_REQUEST" },
	);
});

test("directory metadata distinguishes unknown legacy creation time and rejects implicit defaults", () => {
	for (const method of [
		"getConversation",
		"createConversation",
		"renameConversation",
		"archiveConversation",
		"restoreConversation",
	] as const) {
		assert.deepEqual(parseResult(method, conversation), conversation);
		assert.deepEqual(parseResult(method, { ...conversation, createdAt: 0, archivedAt: 1 }), {
			...conversation,
			createdAt: 0,
			archivedAt: 1,
		});
		for (const patch of [
			{ revision: 0 },
			{ createdAt: undefined },
			{ archivedAt: undefined },
			{ createdAt: -1 },
			{ archivedAt: NaN },
			{ durableId: "private" },
		]) {
			assert.throws(() => parseResult(method, { ...conversation, ...patch }), { code: "INVALID_REQUEST" });
		}
	}
});

test("directory responses are bounded pages and filters/cursors reject unsupported options", () => {
	assert.deepEqual(request("listWorkspaces", { cursor: "opaque" }).params, { cursor: "opaque" });
	for (const filter of ["active", "archived", "all"]) {
		const params = { workspaceId: "test", filter, cursor: "opaque" };
		assert.deepEqual(request("listConversations", params).params, params);
	}
	for (const params of [
		{ workspaceId: "test", filter: "deleted" },
		{ workspaceId: "test", cursor: "" },
		{ workspaceId: "test", limit: 500 },
		{ workspaceId: "test", offset: 1 },
	]) {
		assert.throws(() => request("listConversations", params), { code: "INVALID_REQUEST" });
	}
	const items = Array.from({ length: LIMITS.directoryPage }, (_, index) => ({
		...conversation,
		conversationId: `conversation-${index}`,
	}));
	assert.deepEqual(parseResult("listConversations", { items, nextCursor: "opaque" }), { items, nextCursor: "opaque" });
	for (const value of [
		items,
		{ items },
		{ items: Array(1), nextCursor: null },
		{ items: [conversation, conversation], nextCursor: null },
		{ items: [...items, { ...conversation, conversationId: "overflow" }], nextCursor: null },
	]) {
		assert.throws(() => parseResult("listConversations", value), { code: "INVALID_REQUEST" });
	}
	const workspaces = Array.from({ length: LIMITS.directoryPage }, (_, index) => ({
		workspaceId: `workspace-${index}`,
		name: "Workspace",
	}));
	assert.equal(parseResult("listWorkspaces", { items: workspaces, nextCursor: null }).items.length, 50);
	assert.throws(() => parseResult("listWorkspaces", { items: [...workspaces, workspaces[0]], nextCursor: null }), {
		code: "INVALID_REQUEST",
	});
});

test("command result queries are read-only shapes and preserve terminal grant states", () => {
	assert.deepEqual(request("getConversationCommandResult", { workspaceId: "test", requestId: "create" }).params, {
		workspaceId: "test",
		requestId: "create",
	});
	assert.deepEqual(request("getAgentCommandResult", { ...scope, requestId: "grant" }).params, {
		...scope,
		requestId: "grant",
	});
	for (const method of ["getConversationCommandResult", "getAgentCommandResult"] as const) {
		assert.equal(parseResult(method, null), null);
		assert.throws(() => request(method, { ...scope, requestId: "request", retry: true }), {
			code: "INVALID_REQUEST",
		});
		assert.throws(() => parseResult(method, { method: "submit", result: conversation }), { code: "INVALID_REQUEST" });
	}
	for (const method of [
		"createConversation",
		"renameConversation",
		"archiveConversation",
		"restoreConversation",
	] as const) {
		const result = { method, result: conversation };
		assert.deepEqual(parseResult("getConversationCommandResult", result), result);
	}
	const result = { method: "authorizeAgentContext" as const, result: grant };
	assert.deepEqual(parseResult("getAgentCommandResult", result), result);
	assert.throws(() => parseResult("getAgentCommandResult", { ...result, method: "authorizeRetainedContext" }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("getAgentCommandResult", { ...result, replayed: true }), {
		code: "INVALID_REQUEST",
	});
});

test("active grants and audit pages have independent bounded semantics", () => {
	const items = Array.from({ length: AGENT_LIMITS.contexts }, (_, index) => ({ ...grant, grantId: `grant-${index}` }));
	assert.equal(parseResult("listAgentContexts", { items, nextCursor: "next" }).items.length, 64);
	assert.throws(() => parseResult("listActiveAgentContexts", [grant]), { code: "INVALID_REQUEST" });
	const active = items.slice(0, AGENT_LIMITS.activeContexts).map((item) => ({ ...item, status: "active" as const }));
	assert.equal(parseResult("listActiveAgentContexts", active).length, 32);
	assert.throws(
		() => parseResult("listActiveAgentContexts", [...active, { ...grant, grantId: "overflow", status: "active" }]),
		{ code: "INVALID_REQUEST" },
	);
	assert.throws(() => request("listActiveAgentContexts", { ...scope, cursor: "next" }), { code: "INVALID_REQUEST" });
	assert.deepEqual(parseResult("listPendingToolApprovals", { items: [], nextCursor: null }), {
		items: [],
		nextCursor: null,
	});
	for (const code of [
		"CONVERSATION_BUSY",
		"CONVERSATION_ARCHIVED",
		"RECONCILIATION_REQUIRED",
		"CURSOR_STALE",
		"INDEX_RECOVERY_REQUIRED",
	])
		assert.equal(parseError(code), code);
});

// Fixture transport checks do not substitute for PI persistence and archive-gate integration tests.
test(
	"HTTP and IPC share directory pages, exact reads, command lookup and mutation failures",
	{ timeout: 15000 },
	async () => {
		const runtime = fixtureRuntime();
		const origin = "http://127.0.0.1:4000";
		const server = await serveLoopback(runtime, { origin });
		const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--transport-fixture"], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const ipc = createNodeIpcClient(child);
		try {
			for (const client of [createHttpClient({ ...server, origin }), ipc]) {
				assert.deepEqual(await client.call("listWorkspaces", {}), {
					items: [{ workspaceId: "test", name: "Test" }],
					nextCursor: null,
				});
				assert.deepEqual(await client.call("listConversations", { workspaceId: "test", filter: "all" }), {
					items: [conversation],
					nextCursor: null,
				});
				assert.deepEqual(await client.call("getConversation", scope), conversation);
				assert.equal(
					await client.call("getConversationCommandResult", { workspaceId: "test", requestId: "unknown" }),
					null,
				);
				for (const method of ["archiveConversation", "restoreConversation"] as const)
					await assert.rejects(client.call(method, { ...scope, requestId: "mutation", expectedRevision: 1 }), {
						code: "NOT_FOUND",
					});
				await assert.rejects(
					client.call("renameConversation", {
						...scope,
						requestId: "rename",
						expectedRevision: 1,
						title: "Renamed",
					}),
					{ code: "NOT_FOUND" },
				);
			}
			await assert.rejects(
				runtime.execute({
					...request("getConversationCommandResult", { workspaceId: "test", requestId: "unknown" }),
					expectedStoreId: "other-store",
				}),
				{ code: "STORE_MISMATCH" },
			);
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

test("exact workspace lookup never opens a Harness or enumerates directory pages", async () => {
	let reads = 0;
	const runtime = new WorkRuntime({
		...deniedFeatureReads,
		storeId: "store",
		async getAgentCommandResult() {
			return { method: "authorizeAgentContext", result: grant };
		},
		async getConversation() {
			return conversation;
		},
		async getConversationCommandResult() {
			return { method: "createConversation", result: conversation };
		},
		async getWorkspace(input) {
			reads++;
			return { workspaceId: input.workspaceId, name: "Late workspace" };
		},
		async listModels() {
			throw new Error("unexpected model lookup");
		},
		async listWorkspaces() {
			throw new Error("unexpected directory scan");
		},
		async listConversations() {
			throw new Error("unexpected conversation scan");
		},
		async openWorkspace() {
			throw new Error("must not open a Harness");
		},
		async close() {},
	});
	try {
		assert.deepEqual(await runtime.call("getWorkspace", { workspaceId: "workspace-900" }), {
			workspaceId: "workspace-900",
			name: "Late workspace",
		});
		assert.deepEqual(await runtime.call("getConversation", scope), conversation);
		assert.deepEqual(
			await runtime.call("getConversationCommandResult", { workspaceId: scope.workspaceId, requestId: "create" }),
			{ method: "createConversation", result: conversation },
		);
		assert.deepEqual(await runtime.call("getAgentCommandResult", { ...scope, requestId: "request" }), {
			method: "authorizeAgentContext",
			result: grant,
		});
		assert.equal(reads, 1);
		await assert.rejects(
			runtime.execute({
				version: PROTOCOL_VERSION,
				expectedStoreId: "other",
				method: "getWorkspace",
				params: { workspaceId: "workspace-900" },
			}),
			{ code: "STORE_MISMATCH" },
		);
		assert.equal(reads, 1);
	} finally {
		await runtime.close();
	}
});

test("HTTP preserves capacity and archival errors with explicit retry semantics", async () => {
	const origin = "http://127.0.0.1:4000";
	const errors = [
		["CONVERSATION_BUSY", 409],
		["CONVERSATION_ARCHIVED", 409],
		["RECONCILIATION_REQUIRED", 409],
		["CURSOR_STALE", 409],
		["INDEX_RECOVERY_REQUIRED", 503],
	] as const;
	let current: (typeof errors)[number][0] = "CONVERSATION_BUSY";
	const server = await serveLoopback(
		{
			async execute() {
				throw new AppError(current);
			},
			async observe() {
				throw new Error("unexpected observation");
			},
		},
		{ origin },
	);
	try {
		for (const [code, status] of errors) {
			current = code;
			const response = await fetch(`${server.url}/call`, {
				method: "POST",
				headers: { Origin: origin, Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(request("getWorkspace", { workspaceId: "test" })),
			});
			assert.equal(response.status, status);
			assert.deepEqual(await response.json(), { error: code });
		}
	} finally {
		await server.close();
	}
});
