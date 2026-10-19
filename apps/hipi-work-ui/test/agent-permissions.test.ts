import assert from "node:assert/strict";
import {
	type AgentContext,
	type AppClient,
	AppError,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type Result,
	type ToolApproval,
} from "@hipi/work-runtime/contracts";
import { test, vi } from "vitest";
import { permissionLabels } from "../src/features/agent-permissions/labels.ts";
import { canDecide, PermissionSession } from "../src/features/agent-permissions/permission-session.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const digest = "a".repeat(64);
function fixture(local = new LocalState()) {
	const grant: AgentContext = {
		...scope,
		purpose: "live-files",
		requestId: "context_request",
		rootId: "root",
		pathPrefixes: [""],
		model: { provider: "fake", modelId: "test" },
		expiresAt: Date.now() + 60000,
		disclosureVersion: 1,
		grantId: "grant",
		revision: 1,
		status: "active",
	};
	const approval: ToolApproval = {
		...scope,
		approvalId: "approval",
		taskId: "task",
		callId: "call",
		submissionIds: ["submission"],
		receiptIds: ["receipt"],
		toolName: "hipi_files_save",
		model: grant.model,
		rootId: "root",
		path: "test.txt",
		ifMatch: digest,
		text: "after",
		beforeText: "before",
		beforeTextTruncated: false,
		argumentsDigest: digest,
		contentDigest: digest,
		grantId: "grant",
		grantRevision: 1,
		expiresAt: grant.expiresAt,
		createdAt: Date.now(),
		revision: 1,
		status: "pending",
	};
	const calls: { method: Method; params: unknown; signal?: AbortSignal }[] = [];
	const data: {
		contexts: AgentContext[];
		receipt: Result<"getAgentCommandResult">;
		approval: ToolApproval | null;
		contextNext: string | null;
		approvalNext: string | null;
	} = { contexts: [grant], receipt: null, approval, contextNext: null, approvalNext: null };
	let handler: (method: Method, params: unknown, signal?: AbortSignal) => Promise<unknown> = async () => undefined;
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) => {
			parseRequest({ version: PROTOCOL_VERSION, method, params });
			calls.push({ method, params, signal });
			let result = await handler(method, params, signal);
			if (result === undefined) {
				if (method === "listActiveAgentContexts")
					result = data.contexts.filter((item) => item.status === "active" && item.expiresAt > Date.now());
				else if (method === "listAgentContexts") result = { items: data.contexts, nextCursor: data.contextNext };
				else if (method === "listPendingToolApprovals" || method === "listToolApprovals")
					result = { items: data.approval ? [data.approval] : [], nextCursor: data.approvalNext };
				else if (method === "getAgentCommandResult") result = data.receipt;
				else throw new Error("Unexpected command");
			}
			return parseResult(method, result);
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	return {
		grant,
		approval,
		calls,
		data,
		local,
		client,
		session: new PermissionSession(client, scope, local),
		handle: (next: typeof handler) => {
			handler = next;
		},
	};
}
test("manual folder access and refresh never authorize; current views use only bounded active/pending reads", async () => {
	const f = fixture();
	await f.session.refresh();
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["listActiveAgentContexts", "listPendingToolApprovals"],
	);
	assert.equal(f.session.getSnapshot().approval?.text, "after");
	f.session.dispose();
});
test("lost decision uses exact read-only command result, even after pending-first membership changes", async () => {
	const f = fixture();
	await f.session.refresh();
	const original = { ...f.approval };
	f.handle(async (method) => {
		if (method === "decideToolApproval") {
			f.approval.status = "consumed";
			f.approval.revision = 3;
			f.data.receipt = { method, result: f.approval };
			f.data.approval = { ...original, approvalId: "other" };
			throw new Error("Lost response");
		}
	});
	await Promise.all([f.session.decide(original, "approve"), f.session.decide(original, "approve")]);
	assert.equal(f.calls.filter((call) => call.method === "decideToolApproval").length, 1);
	assert.equal(f.session.getSnapshot().uncertain, false);
	assert.equal(f.session.getSnapshot().approval?.approvalId, "other");
	assert.equal(f.calls.filter((call) => call.method === "getAgentCommandResult").length, 1);
	assert.equal(
		f.calls.some((call) => call.method === "listToolApprovals" || call.method === "continueWorkspace"),
		false,
	);
	f.session.dispose();
});
test("missing command result remains blocked and original payload survives session remount", async () => {
	const f = fixture();
	await f.session.refresh();
	f.handle(async (method) => {
		if (method === "decideToolApproval") throw new Error("Disconnected");
	});
	await f.session.decide(f.approval, "reject");
	assert.equal(f.session.getSnapshot().uncertain, true);
	const original = f.calls.find((call) => call.method === "decideToolApproval")?.params;
	f.session.dispose();
	const restored = new PermissionSession(f.client, scope, f.local);
	await restored.refresh();
	await restored.decide(f.approval, "approve");
	assert.equal(f.calls.filter((call) => call.method === "decideToolApproval").length, 1);
	await restored.retry();
	assert.deepEqual(f.calls.filter((call) => call.method === "decideToolApproval").at(-1)?.params, original);
	assert.equal(f.calls.filter((call) => call.method === "decideToolApproval").length, 2);
	restored.dispose();
});
test("grant/approval histories have separate bounded cursors; paging never replaces active decision authority", async () => {
	const f = fixture();
	f.data.contextNext = "context-next";
	f.data.approvalNext = "approval-next";
	await f.session.refresh();
	await f.session.contextHistory("history");
	await f.session.contextHistory("history", "context-next");
	assert.deepEqual(f.calls.filter((call) => call.method === "listAgentContexts").at(-1)?.params, {
		...scope,
		cursor: "context-next",
	});
	await f.session.approvalHistory("history");
	await f.session.page("approval-next");
	assert.deepEqual(f.calls.filter((call) => call.method === "listToolApprovals").at(-1)?.params, {
		...scope,
		cursor: "approval-next",
	});
	assert.equal(f.session.getSnapshot().activeContexts.length, 1);
	await f.session.approvalHistory("pending");
	assert.deepEqual(f.calls.filter((call) => call.method === "listPendingToolApprovals").at(-1)?.params, scope);
	f.session.dispose();
});
test("revocation, expiry, consumed, foreign scope and retained roles disable file approval", () => {
	const { grant, approval, session } = fixture();
	assert.equal(canDecide(approval, [grant], Date.now()), true);
	for (const invalid of [
		{ ...grant, status: "revoked" as const },
		{ ...grant, revision: 2 },
		{ ...grant, conversationId: "other" },
		{ ...grant, purpose: "retained-context" as const, sourceGrantId: grant.grantId },
	])
		assert.equal(canDecide(approval, [invalid], Date.now()), false);
	assert.equal(canDecide(approval, [grant], approval.expiresAt), false);
	for (const status of ["approved", "rejected", "expired", "invalidated", "consumed"] as const)
		assert.equal(canDecide({ ...approval, status }, [grant], Date.now()), false);
	session.dispose();
});
test("unknown file outcome reconciliation stays read-only and makes no authorship claim", async () => {
	const f = fixture();
	f.approval.operationId = "operation";
	f.approval.status = "consumed";
	f.handle(async (method) => {
		if (method === "getFileOperation")
			return {
				...scope,
				operationId: "operation",
				approvalId: "approval",
				taskId: "task",
				callId: "call",
				rootId: "root",
				path: "test.txt",
				argumentsDigest: digest,
				contentDigest: digest,
				revision: 2,
				status: "observed_match",
			};
	});
	await f.session.refresh(true);
	assert.equal(f.session.getSnapshot().operation?.status, "observed_match");
	assert.deepEqual(f.calls.at(-1)?.params, { ...scope, operationId: "operation", reconcile: true });
	assert.match(permissionLabels("en")["permissions.operation.observed"], /does not prove who/);
	assert.match(permissionLabels("en")["permissions.approval.partial"], /NOT a complete diff/);
	f.session.dispose();
});
test("unmount aborts; late responses cannot contaminate a reactivated session", async () => {
	const f = fixture();
	const pending = Promise.withResolvers<unknown>();
	f.handle(() => pending.promise);
	const first = f.session.refresh();
	f.session.dispose();
	f.session.activate();
	pending.resolve([f.grant]);
	await first;
	assert.equal(f.calls[0]?.signal?.aborted, true);
	assert.equal(f.session.getSnapshot().loaded, false);
	assert.equal(f.session.getSnapshot().failed, false);
	assert.equal(f.calls.length, 1);
	f.session.dispose();
});
test("an unresponsive read has bounded waiting and never publishes late data", async () => {
	vi.useFakeTimers();
	try {
		const f = fixture();
		const pending = Promise.withResolvers<unknown>();
		f.handle(() => pending.promise);
		const read = f.session.refresh();
		await vi.advanceTimersByTimeAsync(15000);
		await read;
		assert.equal(f.session.getSnapshot().busy, false);
		assert.equal(f.session.getSnapshot().failed, true);
		pending.resolve([f.grant]);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(f.session.getSnapshot().loaded, false);
		f.session.dispose();
	} finally {
		vi.useRealTimers();
	}
});
test("retained consent derives only from an existing live source; lost reply reads current authoritative result", async () => {
	const f = fixture();
	f.grant.status = "invalidated";
	await f.session.contextHistory("history");
	const input = {
		...scope,
		requestId: "retained_request",
		sourceGrantId: f.grant.grantId,
		model: f.grant.model,
		expiresAt: f.grant.expiresAt,
		disclosureVersion: 1 as const,
	};
	const retained: AgentContext = {
		...f.grant,
		...input,
		grantId: "retained",
		purpose: "retained-context",
		status: "revoked",
		revision: 2,
	};
	f.handle(async (method) => {
		if (method === "authorizeRetainedContext") {
			f.data.receipt = { method, result: retained };
			throw new Error("Lost");
		}
	});
	await f.session.authorizeRetained({ ...input, conversationId: "other" });
	await f.session.authorizeRetained({ ...input, sourceGrantId: "missing" });
	assert.equal(
		f.calls.some((call) => call.method === "authorizeRetainedContext"),
		false,
	);
	await f.session.authorizeRetained(input);
	assert.equal(f.session.getSnapshot().uncertain, false);
	assert.equal(f.session.getSnapshot().activeContexts.length, 0);
	assert.deepEqual(f.calls.find((call) => call.method === "authorizeRetainedContext")?.params, input);
	assert.equal(
		f.calls.some((call) => call.method === "continueWorkspace"),
		false,
	);
	f.session.dispose();
});
test("wrong purpose, source, model, path, scope or expiry never resolves an authorization merely by matching request ID", async () => {
	for (const mismatch of ["purpose", "source", "model", "range", "scope", "expiry"] as const) {
		const f = fixture();
		await f.session.refresh();
		const input = {
			...scope,
			requestId: "retained_request",
			sourceGrantId: f.grant.grantId,
			model: f.grant.model,
			expiresAt: f.grant.expiresAt,
			disclosureVersion: 1 as const,
		};
		const retained: AgentContext = { ...f.grant, ...input, grantId: "retained", purpose: "retained-context" };
		let returned: AgentContext = retained;
		if (mismatch === "purpose") returned = { ...f.grant, requestId: input.requestId };
		if (mismatch === "source") returned = { ...retained, sourceGrantId: "other" };
		if (mismatch === "model") returned = { ...retained, model: { ...retained.model, modelId: "other" } };
		if (mismatch === "range") returned = { ...retained, pathPrefixes: ["other"] };
		if (mismatch === "scope") returned = { ...retained, conversationId: "other" };
		if (mismatch === "expiry") returned = { ...retained, expiresAt: retained.expiresAt + 1 };
		f.data.receipt = { method: "authorizeRetainedContext", result: returned };
		f.handle(async (method) => {
			if (method === "authorizeRetainedContext") return returned;
		});
		await f.session.authorizeRetained(input);
		assert.equal(f.session.getSnapshot().uncertain, true, mismatch);
		await f.session.authorizeRetained(input);
		assert.equal(f.calls.filter((call) => call.method === "authorizeRetainedContext").length, 1);
		f.session.dispose();
	}
});
test("foreign history scope and operation identity are rejected while previous evidence remains", async () => {
	const f = fixture();
	await f.session.refresh();
	f.handle(async (method) => {
		if (method === "listAgentContexts") return { items: [{ ...f.grant, workspaceId: "other" }], nextCursor: null };
	});
	await f.session.contextHistory("history");
	assert.equal(f.session.getSnapshot().failed, true);
	assert.equal(f.session.getSnapshot().contexts[0]?.workspaceId, scope.workspaceId);
	f.session.dispose();
});

test("live authorization and revocation validate current authoritative results and clear recovery only after matching", async () => {
	const f = fixture();
	await f.session.refresh();
	const input = {
		...scope,
		requestId: "new-live",
		rootId: "root",
		pathPrefixes: ["src"],
		model: f.grant.model,
		expiresAt: f.grant.expiresAt,
		disclosureVersion: 1 as const,
	};
	f.handle(async (method) => {
		if (method === "authorizeAgentContext") {
			Object.assign(f.grant, input);
			return f.grant;
		}
		if (method === "revokeAgentContext") {
			f.grant.status = "revoked";
			f.grant.revision++;
			f.data.receipt = { method, result: f.grant };
			throw new Error("Lost revoke reply");
		}
	});
	await f.session.authorize(input);
	assert.equal(f.session.getSnapshot().uncertain, false);
	await f.session.revoke({ ...f.grant });
	assert.equal(f.session.getSnapshot().uncertain, false);
	assert.equal(f.session.getSnapshot().activeContexts.length, 0);
	assert.equal(f.local.hasUnsavedWork(), false);
	assert.equal(f.calls.filter((call) => call.method === "revokeAgentContext").length, 1);
	f.session.dispose();
});

test("same request ID with a foreign command-result method never unblocks a pending decision", async () => {
	const f = fixture();
	await f.session.refresh();
	f.data.receipt = { method: "authorizeAgentContext", result: f.grant };
	f.handle(async (method) => {
		if (method === "decideToolApproval") throw new Error("Lost");
	});
	await f.session.decide(f.approval, "approve");
	assert.equal(f.session.getSnapshot().uncertain, true);
	assert.equal(f.session.getSnapshot().failed, true);
	f.session.dispose();
});

test("stale pending cursor restarts once read-only without losing or replaying an unknown command", async () => {
	const f = fixture();
	await f.session.page("second-page");
	f.handle(async (method, params) => {
		if (method === "authorizeAgentContext") throw new Error("lost response");
		if (method === "listPendingToolApprovals" && "cursor" in (params as object)) throw new AppError("CURSOR_STALE");
	});
	await f.session.authorize({
		...scope,
		requestId: "unknown-live",
		rootId: "root",
		pathPrefixes: ["src"],
		model: f.grant.model,
		expiresAt: f.grant.expiresAt,
		disclosureVersion: 1,
	});
	assert.equal(f.session.getSnapshot().failed, false);
	assert.equal(f.session.getSnapshot().uncertain, true);
	assert.equal(f.session.getPending()?.params.requestId, "unknown-live");
	assert.equal(f.calls.filter((call) => call.method === "authorizeAgentContext").length, 1);
	assert.deepEqual(
		f.calls
			.filter((call) => call.method === "listPendingToolApprovals")
			.slice(-2)
			.map((call) => call.params),
		[{ ...scope, cursor: "second-page" }, scope],
	);
	assert.ok(f.local.hasUnsavedWork());
	f.session.dispose();
});
test("stale cursor fallback is bounded and does not reinterpret INVALID_REQUEST", async () => {
	for (const code of ["CURSOR_STALE", "INVALID_REQUEST"] as const) {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "listPendingToolApprovals") throw new AppError(code);
		});
		await f.session.page("second-page");
		assert.equal(f.session.getSnapshot().failed, true);
		assert.equal(
			f.calls.filter((call) => call.method === "listPendingToolApprovals").length,
			code === "CURSOR_STALE" ? 2 : 1,
		);
		assert.ok(f.calls.every((call) => call.method.startsWith("list")));
		f.session.dispose();
	}
});
