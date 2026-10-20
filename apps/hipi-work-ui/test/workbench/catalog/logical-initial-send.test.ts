import assert from "node:assert/strict";
import {
	type AppClient,
	AppError,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	type ProjectCommandResult,
	parseRequest,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { admitInitialSend, readInitialSendRecovery } from "../../../src/features/workbench/catalog/initial-send.ts";
import { readCatalogRecovery } from "../../../src/features/workbench/catalog/prepared-task.ts";
import { CatalogSession, type ProjectPinLifecycle } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { parseStoredRequest } from "../../../src/features/workbench/recovery/stored-request.ts";

function fixture() {
	const local = new LocalState();
	local.write("new-chat-draft.source", "Original input");
	local.write(
		"new-chat.active",
		JSON.stringify({ version: 1, generation: "generation", sourceKey: "new-chat-draft.source" }),
	);
	const calls: Method[] = [];
	const conversation = {
		workspaceId: "physical",
		conversationId: "conversation",
		title: "Title",
		revision: 1,
		createdAt: 1,
		archivedAt: null,
	};
	let receipt: ProjectCommandResult | null = null;
	let pending = false;
	let rewriteReceipt: (value: ProjectCommandResult | null) => ProjectCommandResult | null = (value) => value;
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>) => {
			calls.push(method);
			const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
			let result: unknown;
			switch (request.method) {
				case "getProjectCatalogState":
					result = { state: "ready", generation: 1, defaultWorkspaceId: null };
					break;
				case "createProjectConversation":
					if (pending) {
						receipt = {
							status: "pending",
							method: "createProjectConversation",
							params: request.params,
							stage: "reserved",
							reserved: {
								workspaceId: "physical",
								innerRequestId: "inner",
								createDefault: request.params.projectId === null,
							},
						};
						throw new Error("lost reply");
					}
					result = {
						conversation,
						membership: {
							workspaceId: "physical",
							conversationId: "conversation",
							projectId: request.params.projectId,
							revision: 1,
						},
					};
					receipt = {
						status: "completed",
						method: "createProjectConversation",
						params: request.params,
						result: parseResult("createProjectConversation", result),
					};
					break;
				case "getProjectCommandResult":
					result = rewriteReceipt(receipt);
					break;
				case "getProject":
					result = { projectId: "logical", homeWorkspaceId: "different", name: "Project", revision: 1 };
					break;
				case "getConversation":
					result = conversation;
					break;
				case "getConversationModel":
					result = {
						model: { provider: "fake", modelId: "test" },
						credentialState: "configured",
						executionState: "ready",
					};
					break;
				case "submit":
					result = { ...request.params, text: undefined, receiptId: "receipt", state: "accepted" };
					delete (result as Record<string, unknown>).text;
					break;
				default:
					throw new Error(`Unexpected ${method}`);
			}
			return parseResult(method, result);
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const input = {
		workspaceId: "physical",
		projectId: "logical",
		text: "Original input",
		title: "Title",
		sourceKey: "new-chat-draft.source",
		sourceGeneration: "generation",
		model: { provider: "fake", modelId: "test" },
	};
	return {
		local,
		client,
		calls,
		input,
		session: new CatalogSession(client, local),
		setPending(value: boolean) {
			pending = value;
		},
		rewrite(next: typeof rewriteReceipt) {
			rewriteReceipt = next;
		},
	};
}

test("logical first Send keeps project identity separate and proves the physical target through the logical receipt", async () => {
	const f = fixture();
	await f.session.sendInitial(f.input);
	assert.equal(f.session.getSnapshot().failed, false);
	assert.equal(f.session.getSnapshot().submission?.workspaceId, "physical");
	assert.equal(f.session.getSnapshot().receipt?.state, "accepted");
	assert.equal(f.calls.filter((method) => method === "createProjectConversation").length, 1);
	assert.equal(f.calls.includes("createConversation"), false);
	assert.equal(f.calls.includes("getConversationCommandResult"), false);
	assert.equal(f.local.read(f.input.sourceKey), "");
});

test("pending logical creation stays distinct from absence and reload only checks until explicit retry", async () => {
	const f = fixture();
	f.setPending(true);
	await f.session.sendInitial(f.input);
	assert.equal(f.session.getSnapshot().projectPending, true);
	assert.equal(f.session.getSnapshot().notFound, false);
	const reloaded = new CatalogSession(f.client, f.local);
	await reloaded.check();
	assert.equal(f.calls.filter((method) => method === "createProjectConversation").length, 1);
	assert.equal(f.calls.includes("submit"), false);
	f.setPending(false);
	await reloaded.retry();
	assert.equal(reloaded.getSnapshot().receipt?.state, "accepted");
});

test("v6 logical creation is tagged and cannot be interpreted as a v8 physical command", async () => {
	const f = fixture();
	const saved = await admitInitialSend(f.local, f.input, new AbortController().signal);
	const raw = JSON.parse(f.local.read("command.catalog") ?? "null");
	assert.equal(raw.version, 6);
	assert.equal(raw.kind, "logical-initial-send");
	assert.deepEqual(readInitialSendRecovery(raw), saved);
	assert.throws(() => parseStoredRequest({ ...saved.request, version: 8 }));
	assert.equal(readCatalogRecovery(JSON.stringify({ ...raw, version: 5 })).incompatible, true);
	assert.throws(() => readInitialSendRecovery({ ...raw, initialSend: { ...raw.initialSend, workspaceId: "guessed" } }));
});

test("projectless Send uses the logical command without inventing a default marker or physical Chats create", async () => {
	const f = fixture();
	await f.session.sendInitial({ ...f.input, projectId: null, workspaceId: null });
	assert.equal(f.session.getSnapshot().failed, false);
	assert.equal(f.calls.includes("createWorkspace"), false);
	assert.equal(f.local.read("default-chat-workspace"), null);
});

test("mismatched logical receipt request identity never authorizes a handoff", async () => {
	const f = fixture();
	f.rewrite((receipt) =>
		receipt?.method === "createProjectConversation"
			? { ...receipt, params: { ...receipt.params, requestId: "foreign" } }
			: receipt,
	);
	await f.session.sendInitial(f.input);
	assert.equal(f.session.getSnapshot().failed, true);
	assert.equal(f.calls.includes("submit"), false);
	assert.equal(f.local.read(f.input.sourceKey), f.input.text);
	assert.ok(f.local.read("command.catalog"));
});

test("tampered saved canonical Scope is re-proved after reload and never submitted", async () => {
	const f = fixture();
	f.setPending(true);
	await f.session.sendInitial(f.input);
	const saved = JSON.parse(f.local.read("command.catalog") ?? "null");
	saved.request = null;
	saved.initialSend.workspaceId = "foreign";
	saved.initialSend.conversationId = "conversation";
	f.local.write("command.catalog", JSON.stringify(saved));
	const reloaded = new CatalogSession(f.client, f.local);
	await reloaded.check();
	assert.equal(reloaded.getSnapshot().failed, true);
	assert.equal(f.calls.includes("submit"), false);
	assert.equal(f.local.read(f.input.sourceKey), f.input.text);
	assert.equal(JSON.parse(f.local.read("command.catalog") ?? "null").initialSend.workspaceId, "foreign");
});

test("logical consent rejects a different physical home before create, grant or Submit", async () => {
	const f = fixture();
	const session = new CatalogSession(f.client, f.local, {
		getProject: async () => {
			throw new Error("must not read wrong folder");
		},
	});
	await session.sendInitial({
		...f.input,
		context: {
			workspaceId: "physical",
			bindingId: "binding",
			bindingRevision: 1,
			rootId: "root",
			model: f.input.model,
			pathPrefixes: ["src"],
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		},
	});
	assert.equal(session.getSnapshot().failed, true);
	assert.equal(session.getSnapshot().initialConsentInvalidated, true);
	assert.equal(f.calls.includes("createProjectConversation"), false);
	assert.equal(f.calls.includes("authorizeAgentContext"), false);
	assert.equal(f.calls.includes("submit"), false);
	assert.equal(f.local.read(f.input.sourceKey), f.input.text);
});

test("only an authoritative atomic metadata rejection plus exact absent receipt releases recovery", async () => {
	for (const outcome of ["rejected", "unknown", "lookup-failed", "creation"] as const) {
		const local = new LocalState();
		const client: AppClient = {
			call: async <M extends Method>(method: M, _params: Params<M>) => {
				if (method === "getProjectCommandResult") {
					if (outcome === "lookup-failed") throw new Error("offline lookup");
					return parseResult(method, null);
				}
				if (outcome === "unknown") throw new Error("lost response");
				throw new AppError("IDEMPOTENCY_CONFLICT");
			},
			observe: async () => ({ dispose: async () => {} }),
		};
		const session = new CatalogSession(client, local);
		await session.execute(
			outcome === "creation"
				? { version: PROTOCOL_VERSION, method: "createProject", params: { requestId: "command", name: "Name" } }
				: {
						version: PROTOCOL_VERSION,
						method: "renameProject",
						params: { requestId: "command", projectId: "project", expectedRevision: 1, name: "Name" },
					},
		);
		assert.equal(session.getSnapshot().pending === null, outcome === "rejected", outcome);
		if (outcome === "rejected") {
			assert.equal(session.getSnapshot().failed, true);
			assert.equal(session.getSnapshot().errorCode, "IDEMPOTENCY_CONFLICT");
		} else assert.notEqual(local.read("command.catalog"), JSON.stringify({ version: 2, request: null }));
	}
});

test("project pin lifecycle confirms current presentation and never invents initiation on restored recovery", async () => {
	const params = { requestId: "pin", projectId: "logical", expectedPresentationRevision: 0, pinned: true };
	const command = { version: PROTOCOL_VERSION, method: "setProjectPinned", params } as const;
	const receipt = {
		status: "completed",
		method: "setProjectPinned",
		params,
		result: { projectId: "logical", pinned: true, revision: 1 },
	} as const;
	const current = { projectId: "logical", pinned: false, revision: 2 };
	const client: AppClient = {
		call: async <M extends Method>(method: M, _params: Params<M>) =>
			parseResult(
				method,
				method === "setProjectPinned" ? receipt.result : method === "getProjectCommandResult" ? receipt : current,
			),
		observe: async () => ({ dispose: async () => {} }),
	};
	for (const restored of [false, true]) {
		const local = new LocalState();
		if (restored)
			local.write("command.catalog", JSON.stringify({ version: 6, kind: "project-command", request: command }));
		const session = new CatalogSession(client, local);
		const events: ProjectPinLifecycle[] = [];
		session.subscribeProjectPinLifecycle((event) => events.push(event));
		if (restored) await session.check();
		else await session.execute(command);
		assert.deepEqual(
			events.map((event) => event.phase),
			restored ? ["confirmed"] : ["initiated", "admitted", "confirmed"],
		);
		const confirmed = events.at(-1);
		assert.equal(confirmed?.phase, "confirmed");
		if (confirmed?.phase === "confirmed") assert.deepEqual(confirmed.result, current);
		assert.equal(session.getSnapshot().pending, null);
	}
});
