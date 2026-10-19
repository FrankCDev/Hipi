import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
	AGENT_LIMITS,
	type AgentContext,
	type AgentContextRequest,
	type FileOperation,
	fitsPayloadBudget,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type RetainedContextRequest,
	type ToolApproval,
} from "../src/contracts.ts";
import { WorkRuntime, type WorkspacePort } from "../src/core.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";
import { deniedFeatureMutations, deniedFeatureReads } from "./feature-port-fixture.ts";
import { fixtureRuntime } from "./transport-fixture.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const model = { provider: "provider", modelId: "model" };
const digest = "a".repeat(64);
const input: AgentContextRequest = {
	...scope,
	requestId: "request",
	rootId: "root",
	pathPrefixes: ["src"],
	model,
	expiresAt: 2000000000000,
	disclosureVersion: 1,
};
const context: AgentContext = { ...input, grantId: "grant", revision: 1, status: "active", purpose: "live-files" };
const retainedInput: RetainedContextRequest = {
	...scope,
	requestId: "retained-request",
	sourceGrantId: context.grantId,
	model,
	expiresAt: input.expiresAt,
	disclosureVersion: 1,
};
const retainedContext: AgentContext = {
	...context,
	...retainedInput,
	grantId: "retained-grant",
	purpose: "retained-context",
};
const approval: ToolApproval = {
	...scope,
	approvalId: "approval",
	taskId: "task",
	callId: "call",
	submissionIds: ["submission"],
	receiptIds: ["receipt"],
	toolName: "hipi_files_save",
	model,
	rootId: "root",
	path: "src/file.ts",
	ifMatch: digest,
	text: "replacement",
	beforeText: "original",
	beforeTextTruncated: false,
	argumentsDigest: digest,
	contentDigest: digest,
	grantId: "grant",
	grantRevision: 1,
	expiresAt: 2000000000000,
	createdAt: 1900000000000,
	revision: 1,
	status: "pending",
};
const operation: FileOperation = {
	...scope,
	operationId: "operation",
	approvalId: "approval",
	taskId: "task",
	callId: "call",
	rootId: "root",
	path: "src/file.ts",
	argumentsDigest: digest,
	contentDigest: digest,
	status: "unknown",
	revision: 1,
};

function request(method: string, params: unknown) {
	return parseRequest({ version: PROTOCOL_VERSION, expectedStoreId: "store", method, params });
}

test("Agent context disclosure requires complete scoped model and canonical path prefixes", () => {
	assert.deepEqual(request("authorizeAgentContext", input).params, input);
	assert.deepEqual(request("authorizeAgentContext", { ...input, pathPrefixes: [""] }).params, {
		...input,
		pathPrefixes: [""],
	});
	for (const patch of [
		{ conversationId: undefined },
		{ model: undefined },
		{ model: { ...model, credentials: "secret" } },
		{ rootId: "/tmp/root" },
		{ pathPrefixes: [] },
		{ pathPrefixes: Array(1) },
		{ pathPrefixes: ["src", "src"] },
		{ pathPrefixes: Array.from({ length: AGENT_LIMITS.pathPrefixes + 1 }, (_, i) => `dir-${i}`) },
		{ disclosureVersion: "1" },
		{ disclosureVersion: 2 },
		{ expiresAt: -1 },
		{ expiresAt: NaN },
		{ expiresAt: Infinity },
		{ expiresAt: 1.5 },
		{ expiresAt: Number.MAX_SAFE_INTEGER + 1 },
		{ writable: true },
		{ providerKey: "secret" },
		{ purpose: "live-files" },
		{ purpose: "retained-context" },
		{ sourceGrantId: "grant" },
	]) {
		assert.throws(() => request("authorizeAgentContext", { ...input, ...patch }), { code: "INVALID_REQUEST" });
	}
	for (const path of ["/absolute", "../escape", "src/../escape", "C:\\root", "a//b", "./src", "con", "%2e%2e"]) {
		assert.throws(() => request("authorizeAgentContext", { ...input, pathPrefixes: [path] }), {
			code: "INVALID_REQUEST",
		});
	}
});

test("retained disclosure accepts only a source grant, model, expiry and scoped request identity", () => {
	assert.deepEqual(request("authorizeRetainedContext", retainedInput).params, retainedInput);
	for (const patch of [
		{ workspaceId: undefined },
		{ conversationId: undefined },
		{ requestId: undefined },
		{ requestId: "" },
		{ sourceGrantId: undefined },
		{ sourceGrantId: "" },
		{ sourceGrantId: "../grant" },
		{ model: undefined },
		{ model: { ...model, credentials: "secret" } },
		{ expiresAt: undefined },
		{ expiresAt: -1 },
		{ expiresAt: NaN },
		{ expiresAt: Infinity },
		{ expiresAt: 1.5 },
		{ expiresAt: Number.MAX_SAFE_INTEGER + 1 },
		{ disclosureVersion: undefined },
		{ disclosureVersion: "1" },
		{ disclosureVersion: 2 },
		{ rootId: "different-root" },
		{ pathPrefixes: [""] },
		{ path: "private.txt" },
		{ purpose: "live-files" },
		{ purpose: "retained-context" },
		{ writable: true },
		{ providerKey: "secret" },
	]) {
		assert.throws(() => request("authorizeRetainedContext", { ...retainedInput, ...patch }), {
			code: "INVALID_REQUEST",
		});
	}
});

test("grant purpose is mandatory and source identity is exclusive to retained contexts", () => {
	assert.deepEqual(parseResult("authorizeRetainedContext", retainedContext), retainedContext);
	assert.throws(() => parseResult("authorizeRetainedContext", context), { code: "INVALID_REQUEST" });
	assert.throws(() => parseResult("authorizeAgentContext", retainedContext), { code: "INVALID_REQUEST" });
	assert.deepEqual(parseResult("revokeAgentContext", retainedContext), retainedContext);
	assert.deepEqual(parseResult("listAgentContexts", { items: [context, retainedContext], nextCursor: null }), {
		items: [context, retainedContext],
		nextCursor: null,
	});
	for (const value of [
		{ ...context, purpose: undefined },
		{ ...context, purpose: "history" },
		{ ...context, sourceGrantId: "grant" },
		{ ...context, sourceGrantId: undefined },
		{ ...retainedContext, sourceGrantId: undefined },
		{ ...retainedContext, sourceGrantId: "" },
		{ ...retainedContext, purpose: "live-files" },
		{ ...retainedContext, absolutePath: "/tmp/private" },
	]) {
		for (const method of ["authorizeAgentContext", "authorizeRetainedContext", "revokeAgentContext"] as const) {
			assert.throws(() => parseResult(method, value), { code: "INVALID_REQUEST" });
		}
		assert.throws(() => parseResult("listAgentContexts", { items: [value], nextCursor: null }), {
			code: "INVALID_REQUEST",
		});
	}
});

test("Agent context results reject extra fields, duplicate grants and unknown grant states", () => {
	for (const status of ["active", "revoked", "expired", "invalidated"] as const) {
		assert.deepEqual(parseResult("authorizeAgentContext", { ...context, status }), { ...context, status });
	}
	assert.deepEqual(parseResult("listAgentContexts", { items: [context], nextCursor: null }), {
		items: [context],
		nextCursor: null,
	});
	for (const patch of [{ revision: 0 }, { revision: 1.5 }, { status: "approved" }, { absolutePath: "/tmp/file" }]) {
		assert.throws(() => parseResult("revokeAgentContext", { ...context, ...patch }), { code: "INVALID_REQUEST" });
	}
	assert.throws(() => parseResult("listAgentContexts", { items: [context, context], nextCursor: null }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("listAgentContexts", { items: Array(1), nextCursor: null }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(
		() =>
			parseResult("listAgentContexts", {
				items: Array.from({ length: AGENT_LIMITS.contexts + 1 }, (_, i) => ({ ...context, grantId: `grant-${i}` })),
				nextCursor: null,
			}),
		{ code: "INVALID_REQUEST" },
	);
});

test("approval decisions bind request, approval revision and both digests", () => {
	const decision = {
		...scope,
		requestId: "decision",
		approvalId: "approval",
		expectedRevision: 1,
		decision: "approve",
		argumentsDigest: digest,
		contentDigest: digest,
	};
	assert.deepEqual(request("decideToolApproval", decision).params, decision);
	for (const patch of [
		{ requestId: undefined },
		{ expectedRevision: 0 },
		{ expectedRevision: "1" },
		{ argumentsDigest: undefined },
		{ argumentsDigest: digest.toUpperCase() },
		{ contentDigest: digest.slice(1) },
		{ decision: "approved" },
		{ text: "changed after review" },
	]) {
		assert.throws(() => request("decideToolApproval", { ...decision, ...patch }), { code: "INVALID_REQUEST" });
	}
	const revoke = { ...scope, requestId: "revoke", grantId: "grant", expectedRevision: 1 };
	assert.deepEqual(request("revokeAgentContext", revoke).params, revoke);
	assert.throws(() => request("revokeAgentContext", { ...revoke, expectedRevision: 0 }), { code: "INVALID_REQUEST" });
});

test("approval records validate complete proposed content and bounded baseline preview", () => {
	assert.deepEqual(parseResult("decideToolApproval", approval), approval);
	for (const status of ["pending", "approved", "rejected", "expired", "invalidated", "consumed"] as const) {
		assert.equal(parseResult("decideToolApproval", { ...approval, status }).status, status);
	}
	for (const patch of [
		{ toolName: "saveText" },
		{ model: { ...model, key: "secret" } },
		{ path: "/absolute/file" },
		{ path: "../escape" },
		{ beforeTextTruncated: undefined },
		{ beforeTextTruncated: "false" },
		{ grantRevision: 0 },
		{ revision: 0 },
		{ ifMatch: "any" },
		{ text: "\ud800" },
		{ text: "\u0000" },
		{ text: "x".repeat(AGENT_LIMITS.textBytes + 1) },
		{ text: "😀".repeat(AGENT_LIMITS.textBytes / 4 + 1) },
		{ beforeText: "x".repeat(AGENT_LIMITS.beforeTextBytes + 1) },
		{ submissionIds: ["submission", "submission"] },
		{ submissionIds: Array(1) },
		{ receiptIds: Array.from({ length: 65 }, (_, i) => `receipt-${i}`) },
		{ status: "completed" },
		{ absolutePath: "/tmp/file" },
	]) {
		assert.throws(() => parseResult("decideToolApproval", { ...approval, ...patch }), { code: "INVALID_REQUEST" });
	}
	const largest = {
		...approval,
		text: "\t".repeat(AGENT_LIMITS.textBytes),
		beforeText: "\t".repeat(AGENT_LIMITS.beforeTextBytes),
		beforeTextTruncated: true,
	};
	assert.deepEqual(parseResult("decideToolApproval", largest), largest);
	assert.equal(fitsPayloadBudget({ items: [largest], nextCursor: "cursor" }), true);
});

test("approval listing pages are bounded and reject unknown cursor options", () => {
	const page = { items: [approval], nextCursor: "opaque-cursor" };
	assert.deepEqual(parseResult("listToolApprovals", page), page);
	assert.deepEqual(parseResult("listToolApprovals", { items: [], nextCursor: null }), { items: [], nextCursor: null });
	assert.deepEqual(request("listToolApprovals", { ...scope, cursor: "opaque-cursor" }).params, {
		...scope,
		cursor: "opaque-cursor",
	});
	for (const value of [
		{ ...page, items: [approval, approval] },
		{ ...page, items: Array(1) },
		{ items: [] },
		{ ...page, nextCursor: "" },
	]) {
		assert.throws(() => parseResult("listToolApprovals", value), { code: "INVALID_REQUEST" });
	}
	assert.throws(() => request("listToolApprovals", { ...scope, limit: 2 }), { code: "INVALID_REQUEST" });
	assert.deepEqual(request("listAgentContexts", { ...scope, cursor: "cursor" }).params, {
		...scope,
		cursor: "cursor",
	});
	assert.throws(() => request("listActiveAgentContexts", { ...scope, cursor: "cursor" }), { code: "INVALID_REQUEST" });
});

test("file operation query never implies reconciliation and accepts only bounded structured evidence", () => {
	const params = { ...scope, operationId: "operation" };
	assert.deepEqual(request("getFileOperation", params).params, params);
	assert.deepEqual(request("getFileOperation", { ...params, reconcile: true }).params, { ...params, reconcile: true });
	assert.deepEqual(request("getFileOperation", { ...params, reconcile: false }).params, {
		...params,
		reconcile: false,
	});
	assert.throws(() => request("getFileOperation", { ...params, reconcile: "true" }), { code: "INVALID_REQUEST" });
	assert.throws(() => request("getFileOperation", { ...params, retry: true }), { code: "INVALID_REQUEST" });
	assert.equal(parseResult("getFileOperation", null), null);
	for (const status of ["prepared", "executing", "confirmed", "conflict", "unknown", "observed_match"] as const) {
		const value = { ...operation, status, evidence: { revision: digest, contentDigest: digest } };
		assert.deepEqual(parseResult("getFileOperation", value), value);
	}
	for (const patch of [
		{ status: "succeeded" },
		{ revision: 0 },
		{ path: "C:/root/file" },
		{ evidence: { revision: digest } },
		{ evidence: { revision: digest, contentDigest: digest, absolutePath: "/tmp/file" } },
		{ error: "internal host path" },
	]) {
		assert.throws(() => parseResult("getFileOperation", { ...operation, ...patch }), { code: "INVALID_REQUEST" });
	}
});

test("application dispatch forwards all authorization calls only after store validation", async () => {
	const calls: { method: string; params: unknown }[] = [];
	const port: WorkspacePort = {
		...deniedFeatureMutations,
		workspace: { workspaceId: scope.workspaceId, name: "Workspace" },
		async createConversation() {
			throw new Error("unexpected");
		},
		async getConversation() {
			throw new Error("unexpected");
		},
		async renameConversation() {
			throw new Error("unexpected");
		},
		async archiveConversation() {
			throw new Error("unexpected");
		},
		async restoreConversation() {
			throw new Error("unexpected");
		},
		async getConversationCommandResult() {
			throw new Error("unexpected");
		},
		async getConversationModel() {
			throw new Error("unexpected");
		},
		async continueWorkspace() {
			throw new Error("unexpected");
		},
		async cancelExecution() {
			throw new Error("unexpected");
		},
		async submit() {
			throw new Error("unexpected");
		},
		async getReceipt() {
			throw new Error("unexpected");
		},
		async snapshot() {
			throw new Error("unexpected");
		},
		async getHistory() {
			throw new Error("unexpected");
		},
		async getMessageText() {
			throw new Error("unexpected");
		},
		async observe() {
			throw new Error("unexpected");
		},
		async close() {},
		async authorizeAgentContext(params) {
			calls.push({ method: "authorizeAgentContext", params });
			return context;
		},
		async authorizeRetainedContext(params) {
			calls.push({ method: "authorizeRetainedContext", params });
			return retainedContext;
		},
		async revokeAgentContext(params) {
			calls.push({ method: "revokeAgentContext", params });
			return context;
		},
		async listAgentContexts(params) {
			calls.push({ method: "listAgentContexts", params });
			return { items: [context], nextCursor: null };
		},
		async listActiveAgentContexts(params) {
			calls.push({ method: "listActiveAgentContexts", params });
			return [context];
		},
		async listPendingToolApprovals(params) {
			calls.push({ method: "listPendingToolApprovals", params });
			return { items: [approval], nextCursor: null };
		},
		async getAgentCommandResult(params) {
			calls.push({ method: "getAgentCommandResult", params });
			return { method: "authorizeAgentContext", result: context };
		},
		async listToolApprovals(params) {
			calls.push({ method: "listToolApprovals", params });
			return { items: [approval], nextCursor: null };
		},
		async decideToolApproval(params) {
			calls.push({ method: "decideToolApproval", params });
			return approval;
		},
		async getFileOperation(params) {
			calls.push({ method: "getFileOperation", params });
			return operation;
		},
	};
	const runtime = new WorkRuntime({
		...deniedFeatureReads,
		storeId: "store",
		getAgentCommandResult: (params) => port.getAgentCommandResult(params),
		async getConversation() {
			throw new Error("unexpected");
		},
		async getConversationCommandResult() {
			throw new Error("unexpected");
		},
		async getWorkspace() {
			return port.workspace;
		},
		async listModels() {
			return { models: [], providers: [] };
		},
		async listWorkspaces() {
			return { items: [], nextCursor: null };
		},
		async listConversations() {
			return { items: [], nextCursor: null };
		},
		async openWorkspace() {
			return port;
		},
		async close() {},
	});
	try {
		assert.deepEqual(await runtime.call("authorizeAgentContext", input), context);
		assert.deepEqual(await runtime.call("authorizeRetainedContext", retainedInput), retainedContext);
		assert.deepEqual(calls.at(-1)?.params, retainedInput);
		await runtime.call("revokeAgentContext", {
			...scope,
			requestId: "revoke",
			grantId: "grant",
			expectedRevision: 1,
		});
		await runtime.call("listAgentContexts", scope);
		await runtime.call("listToolApprovals", scope);
		await runtime.call("listActiveAgentContexts", scope);
		await runtime.call("listPendingToolApprovals", scope);
		await runtime.call("getAgentCommandResult", { ...scope, requestId: input.requestId });
		await runtime.call("decideToolApproval", {
			...scope,
			requestId: "decision",
			approvalId: "approval",
			expectedRevision: 1,
			decision: "reject",
			argumentsDigest: digest,
			contentDigest: digest,
		});
		await runtime.call("getFileOperation", { ...scope, operationId: "operation" });
		assert.deepEqual(
			calls.map((call) => call.method),
			[
				"authorizeAgentContext",
				"authorizeRetainedContext",
				"revokeAgentContext",
				"listAgentContexts",
				"listToolApprovals",
				"listActiveAgentContexts",
				"listPendingToolApprovals",
				"getAgentCommandResult",
				"decideToolApproval",
				"getFileOperation",
			],
		);
		assert.deepEqual(calls.at(-1)?.params, { ...scope, operationId: "operation" });
		await assert.rejects(
			runtime.execute({
				version: PROTOCOL_VERSION,
				expectedStoreId: "other",
				method: "authorizeAgentContext",
				params: input,
			}),
			{ code: "STORE_MISMATCH" },
		);
		await assert.rejects(
			runtime.execute({
				version: PROTOCOL_VERSION,
				expectedStoreId: "other",
				method: "authorizeRetainedContext",
				params: retainedInput,
			}),
			{ code: "STORE_MISMATCH" },
		);
		assert.equal(calls.length, 10);
	} finally {
		await runtime.close();
	}
});

// This fixture denies authorization. It tests transport dispatch, not business authorization end to end.
test(
	"HTTP and IPC preserve fail-closed authorization for every authorization command",
	{ timeout: 15000 },
	async () => {
		const runtime = fixtureRuntime();
		const origin = "http://127.0.0.1:4000";
		const server = await serveLoopback(runtime, { origin });
		const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--transport-fixture"], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const ipc = createNodeIpcClient(child);
		const target = { workspaceId: "test", conversationId: "conversation" };
		try {
			for (const client of [createHttpClient({ ...server, origin }), ipc]) {
				await assert.rejects(client.call("authorizeAgentContext", { ...input, ...target }), {
					code: "UNAUTHORIZED",
				});
				await assert.rejects(client.call("authorizeRetainedContext", { ...retainedInput, ...target }), {
					code: "UNAUTHORIZED",
				});
				await assert.rejects(
					client.call("revokeAgentContext", {
						...target,
						requestId: "revoke",
						grantId: "grant",
						expectedRevision: 1,
					}),
					{ code: "UNAUTHORIZED" },
				);
				await assert.rejects(client.call("listAgentContexts", target), { code: "UNAUTHORIZED" });
				await assert.rejects(client.call("listToolApprovals", target), { code: "UNAUTHORIZED" });
				await assert.rejects(client.call("listPendingToolApprovals", target), { code: "UNAUTHORIZED" });
				await assert.rejects(client.call("listActiveAgentContexts", target), { code: "UNAUTHORIZED" });
				await assert.rejects(client.call("getAgentCommandResult", { ...target, requestId: "request" }), {
					code: "UNAUTHORIZED",
				});
				await assert.rejects(
					client.call("decideToolApproval", {
						...target,
						requestId: "decision",
						approvalId: "approval",
						expectedRevision: 1,
						decision: "approve",
						argumentsDigest: digest,
						contentDigest: digest,
					}),
					{ code: "UNAUTHORIZED" },
				);
				await assert.rejects(client.call("getFileOperation", { ...target, operationId: "operation" }), {
					code: "UNAUTHORIZED",
				});
			}
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
