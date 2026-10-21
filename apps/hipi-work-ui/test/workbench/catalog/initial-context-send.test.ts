import assert from "node:assert/strict";
import {
	type AgentContext,
	type AppClient,
	type Conversation,
	type ConversationModel,
	LIMITS,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type Submit,
} from "@hipi/work-runtime/contracts";
import type { ProjectFolder } from "@hipi/work-runtime/files";
import { afterEach, test, vi } from "vitest";
import type { InitialSendInput, StagedProjectConsent } from "../../../src/features/workbench/catalog/initial-send.ts";
import { readCatalogRecovery } from "../../../src/features/workbench/catalog/prepared-task.ts";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import type { BrowserStorage } from "../../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { submitRequest } from "../../../src/features/workbench/submit-request.ts";

class MemoryStorage implements BrowserStorage {
	values = new Map<string, string>();
	fail: (key: string, value: string) => boolean = () => false;
	get length() {
		return this.values.size;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		if (this.fail(key, value)) throw new Error("storage denied");
		this.values.set(key, value);
	}
}
function locks() {
	const queues = new Map<string, Promise<unknown>>();
	vi.stubGlobal("navigator", {
		locks: {
			request: (name: string, work: () => unknown) => {
				const next = (queues.get(name) ?? Promise.resolve()).then(work);
				queues.set(
					name,
					next.catch(() => {}),
				);
				return next;
			},
		},
	});
}
const model = { provider: "fake", modelId: "test" };
const prompt = "  Inspect only the authorized source and documentation.\nKeep this exact original.  ";
function consent(): StagedProjectConsent {
	return {
		workspaceId: "project",
		bindingId: "binding",
		bindingRevision: 1,
		rootId: "root",
		model,
		pathPrefixes: ["src", "docs"],
		expiresAt: Date.now() + 60000,
		disclosureVersion: 1,
	};
}
function input(context = consent()): InitialSendInput {
	return {
		workspaceId: "project",
		sourceKey: "task-draft.project",
		text: prompt,
		title: "Inspect project",
		model,
		context,
	};
}
function accepted(submit: Submit) {
	return {
		workspaceId: submit.workspaceId,
		conversationId: submit.conversationId,
		requestId: submit.requestId,
		receiptId: "receipt",
		state: "accepted" as const,
	};
}
function fixture() {
	locks();
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	const calls: { method: Method; params: unknown }[] = [];
	const commands = new Map<string, Conversation>();
	const grants = new Map<string, AgentContext>();
	const receipts = new Map<string, Submit>();
	const providerTurns: { input: Submit; contexts: AgentContext[] }[] = [];
	const state: { folder: ProjectFolder; model: ConversationModel; projectReads: number } = {
		folder: {
			workspaceId: "project",
			status: "available",
			bindingId: "binding",
			revision: 1,
			displayName: "Project",
			root: { workspaceId: "project", rootId: "root", writable: false, displayName: "Project" },
		},
		model: { model, credentialState: "configured", executionState: "ready" },
		projectReads: 0,
	};
	let override: ((method: Method, params: unknown) => Promise<unknown> | undefined) | undefined;
	const respond = (method: Method, params: unknown): unknown => {
		const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
		switch (request.method) {
			case "getWorkspace":
				return { workspaceId: "project", name: "Project" };
			case "createConversation": {
				const result: Conversation = {
					workspaceId: request.params.workspaceId,
					conversationId: "conversation",
					title: request.params.title,
					revision: 1,
					createdAt: 10,
					archivedAt: null,
				};
				commands.set(request.params.requestId, result);
				return result;
			}
			case "getConversationCommandResult": {
				const result = commands.get(request.params.requestId);
				return result ? { method: "createConversation", result } : null;
			}
			case "getConversation":
				return [...commands.values()][0];
			case "getConversationModel":
				return state.model;
			case "authorizeAgentContext": {
				assert.equal(providerTurns.length, 0);
				assert.equal(local.pending("project.conversation"), null, "No ordinary retry owner before consent");
				const saved = readCatalogRecovery(new LocalState("store", storage).read("command.catalog"));
				assert.deepEqual(saved.initialSend?.context?.authorization, request.params);
				const grant: AgentContext = {
					...request.params,
					grantId: "grant",
					revision: 1,
					status: "active",
					purpose: "live-files",
				};
				grants.set(request.params.requestId, grant);
				return grant;
			}
			case "getAgentCommandResult": {
				const result = grants.get(request.params.requestId);
				return result ? { method: "authorizeAgentContext", result } : null;
			}
			case "listActiveAgentContexts":
				return [...grants.values()].filter((grant) => grant.status === "active");
			case "submit": {
				const saved = readCatalogRecovery(new LocalState("store", storage).read("command.catalog"));
				if (saved.initialSend?.context) {
					assert.equal(saved.initialSend.context.submitAttempted, true);
					assert.equal(local.pending("project.conversation"), null);
				}
				if (!receipts.has(request.params.requestId))
					providerTurns.push({
						input: structuredClone(request.params),
						contexts: structuredClone([...grants.values()].filter((grant) => grant.status === "active")),
					});
				receipts.set(request.params.requestId, request.params);
				return accepted(request.params);
			}
			case "getReceipt": {
				const result = receipts.get(request.params.requestId);
				return result ? accepted(result) : null;
			}
			default:
				throw new Error(`Unexpected ${method}`);
		}
	};
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>) => {
			calls.push({ method, params: structuredClone(params) });
			return parseResult(method, await (override?.(method, params) ?? respond(method, params)));
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const authority = {
		getProject: async () => {
			state.projectReads++;
			return state.folder;
		},
	};
	const session = new CatalogSession(client, local, authority);
	local.write("task-draft.project", prompt);
	return {
		storage,
		local,
		client,
		authority,
		state,
		calls,
		commands,
		grants,
		receipts,
		providerTurns,
		respond,
		session,
		override(next: typeof override) {
			override = next;
		},
	};
}
function mutations(f: ReturnType<typeof fixture>) {
	return f.calls.filter((call) => ["createConversation", "authorizeAgentContext", "submit"].includes(call.method));
}
afterEach(() => vi.unstubAllGlobals());

test("first captured Send authorizes exact root/prefix metadata before exactly one meaningful provider turn", async () => {
	const f = fixture();
	const request = input();
	await f.session.check();
	assert.deepEqual(mutations(f), []);
	const run = f.session.sendInitial(request);
	request.context?.pathPrefixes.push("private");
	await Promise.all([run, f.session.sendInitial(input())]);
	assert.equal(
		f.session.getSnapshot().failed,
		false,
		JSON.stringify({ state: f.session.getSnapshot(), calls: f.calls }),
	);
	assert.deepEqual(
		mutations(f).map((call) => call.method),
		["createConversation", "authorizeAgentContext", "submit"],
	);
	assert.equal(f.providerTurns.length, 1);
	assert.equal(f.providerTurns[0]?.input.text, prompt);
	assert.equal(f.providerTurns[0]?.contexts.length, 1);
	assert.deepEqual(f.providerTurns[0]?.contexts[0]?.pathPrefixes, ["src", "docs"]);
	assert.equal(f.providerTurns[0]?.contexts[0]?.rootId, "root");
	assert.deepEqual(f.providerTurns[0]?.contexts[0]?.model, model);
	assert.ok(f.state.projectReads >= 3);
	assert.equal(f.session.getSnapshot().initialSend, null);
	assert.equal(f.session.getSnapshot().receipt?.state, "accepted");
	assert.equal(f.local.read("task-draft.project"), "");
});

test("ordinary no-consent first Send never reads a project or authorizes a grant", async () => {
	const f = fixture();
	const { context: _context, ...request } = input();
	await f.session.sendInitial(request);
	assert.deepEqual(
		mutations(f).map((call) => call.method),
		["createConversation", "submit"],
	);
	assert.equal(f.state.projectReads, 0);
	assert.deepEqual(f.providerTurns[0]?.contexts, []);
});

test("unknown create, authorization and submit preserve immutable IDs and permit only explicit live retry", async () => {
	for (const stage of ["createConversation", "authorizeAgentContext", "submit"] as const) {
		const f = fixture();
		f.override((method) => (method === stage ? Promise.reject(new Error("lost")) : undefined));
		await f.session.sendInitial(input());
		assert.equal(f.session.getSnapshot().notFound, true, stage);
		assert.equal(f.local.pending("project.conversation"), null, stage);
		const first = mutations(f).find((call) => call.method === stage);
		assert.ok(first);
		const saved = f.session.getSnapshot().initialSend;
		assert.ok(saved);
		await f.session.check();
		assert.equal(mutations(f).filter((call) => call.method === stage).length, 1);
		f.local.write("task-draft.project", "later user edit");
		f.override(undefined);
		await f.session.retry();
		const repeated = mutations(f).filter((call) => call.method === stage);
		assert.equal(repeated.length, 2, stage);
		assert.deepEqual(repeated[1]?.params, first.params, stage);
		assert.equal(f.providerTurns.length, 1, stage);
		assert.equal(f.providerTurns[0]?.input.text, saved.text);
		assert.equal(f.local.read("task-draft.project"), "later user edit");
	}
});

test("reload only checks exact outcomes and never creates grants, pending submits or dispatches", async () => {
	for (const stage of ["createConversation", "authorizeAgentContext", "submit"] as const) {
		const f = fixture();
		f.override((method) => (method === stage ? Promise.reject(new Error("lost")) : undefined));
		await f.session.sendInitial(input());
		f.session.dispose();
		const local = new LocalState("store", f.storage);
		const reopened = new CatalogSession(f.client, local, f.authority);
		const count = mutations(f).length;
		f.override(undefined);
		await reopened.check();
		await reopened.retry();
		await reopened.recoverInitialDraft();
		assert.equal(mutations(f).length, count, stage);
		assert.equal(local.pending("project.conversation"), null, stage);
		assert.equal(reopened.getSnapshot().initialConsentInvalidated, true, stage);
		assert.equal(local.read("task-draft.project"), prompt);
		assert.ok(reopened.getSnapshot().initialSend, stage);
	}
});

test.each(["createConversation", "authorizeAgentContext", "submit"] as const)(
	"protocol v8 %s recovery remains read-only after upgrading to v12",
	async (stage) => {
		const f = fixture();
		f.override((method) => (method === stage ? Promise.reject(new Error("lost")) : undefined));
		await f.session.sendInitial(input());
		f.session.dispose();
		const original = f.local.read("command.catalog");
		assert.ok(original);
		const record = JSON.parse(original);
		// Pin the historical wire version rather than letting the current fixture hide upgrade regressions.
		record.initialSend.conversationCommand.version = 8;
		if (record.request) record.request.version = 8;
		const legacy = JSON.stringify(record);
		f.local.write("command.catalog", legacy);
		const storageBefore = new Map(f.storage.values);
		const local = new LocalState("store", f.storage);
		const reopened = new CatalogSession(f.client, local, f.authority);
		const task = reopened.getSnapshot().initialSend;
		assert.equal(PROTOCOL_VERSION, 12);
		assert.equal(reopened.getSnapshot().incompatible, false, stage);
		assert.ok(task?.context);
		assert.equal(task.conversationCommand.version, 12);
		assert.equal(task.text, prompt);
		assert.equal(task.submissionId, record.initialSend.submissionId);
		assert.deepEqual(task.context, record.initialSend.context);
		assert.equal(task.context.createAttempted, true);
		assert.equal(task.context.submitAttempted, stage === "submit");
		assert.equal(task.context.authorization !== null, stage !== "createConversation");
		assert.equal(reopened.getSnapshot().initialConsentInvalidated, true);
		assert.equal(
			reopened.getSnapshot().initialConsentStage,
			stage === "createConversation" ? "create" : stage === "authorizeAgentContext" ? "authorize" : "submit",
		);

		const callsBefore = f.calls.length;
		const mutationsBefore = mutations(f);
		f.override(undefined);
		await reopened.check();
		assert.equal(reopened.getSnapshot().notFound, true, stage);
		assert.ok(
			f.calls.slice(callsBefore).some((call) => {
				const lookup =
					stage === "createConversation"
						? "getConversationCommandResult"
						: stage === "authorizeAgentContext"
							? "getAgentCommandResult"
							: "getReceipt";
				return call.method === lookup;
			}),
		);
		await reopened.retry();
		await reopened.recoverInitialDraft();
		await reopened.combineInitialDraft();
		for (const requestId of [task.submissionId, "bypass"]) {
			await assert.rejects(
				submitRequest(
					f.client,
					local,
					{
						workspaceId: "project",
						conversationId: task.conversationId ?? "discovered-conversation",
						requestId,
						text: prompt,
					},
					new AbortController().signal,
				),
				/PREREQUISITE_REQUIRED/,
			);
		}
		assert.deepEqual(mutations(f), mutationsBefore, stage);
		assert.equal(f.providerTurns.length, 0);
		assert.equal(local.pending("project.conversation"), null);
		assert.equal(local.pending("project.discovered-conversation"), null);
		assert.equal(reopened.getSnapshot().initialConsentInvalidated, true);
		assert.equal(reopened.getSnapshot().initialConsentCanRecoverDraft, false);
		assert.deepEqual(reopened.getSnapshot().initialSend, task);
		assert.equal(local.read("task-draft.project"), prompt);
		assert.equal(local.read("command.catalog"), legacy);
		assert.deepEqual(f.storage.values, storageBefore, "Unknown outcomes must not rewrite the v8 journal");
	},
);

test("lost committed responses reconcile to one exact turn and Check can finish accepted submit after reload", async () => {
	for (const stage of ["createConversation", "authorizeAgentContext", "submit"] as const) {
		const f = fixture();
		f.override((method, params) => {
			if (method !== stage) return undefined;
			f.respond(method, params);
			return Promise.reject(new Error("reply lost after commit"));
		});
		await f.session.sendInitial(input());
		assert.equal(f.session.getSnapshot().failed, false, stage);
		assert.equal(f.providerTurns.length, 1, stage);
		assert.equal(mutations(f).filter((call) => call.method === stage).length, 1);
		assert.equal(f.session.getSnapshot().initialSend, null);
	}
	const f = fixture();
	const wait = Promise.withResolvers<unknown>();
	f.override((method, params) => {
		if (method !== "submit") return undefined;
		f.respond(method, params);
		return wait.promise;
	});
	const run = f.session.sendInitial(input());
	await vi.waitFor(() => assert.equal(f.receipts.size, 1));
	f.session.dispose();
	await run;
	const reopened = new CatalogSession(f.client, new LocalState("store", f.storage), f.authority);
	await reopened.check();
	assert.equal(reopened.getSnapshot().initialSend, null);
	assert.equal(reopened.getSnapshot().receipt?.state, "accepted");
	assert.equal(f.providerTurns.length, 1);
	wait.resolve(accepted([...f.receipts.values()][0] as Submit));
});

test("storage failure at every prerequisite and handoff write prevents later effects and preserves recovery", async () => {
	for (const stage of [
		"intent",
		"create",
		"target",
		"authorization",
		"submit",
		"draft",
		"pending",
		"source",
		"clear",
	] as const) {
		const f = fixture();
		f.storage.fail = (key, raw) => {
			const entry = JSON.parse(raw);
			if (stage === "draft") return key.endsWith("value.draft.project.conversation");
			if (stage === "pending") return key.includes(".pending.");
			if (stage === "source") return key.endsWith("value.task-draft.project") && entry.value === "";
			if (!key.endsWith("value.command.catalog")) return false;
			const record = JSON.parse(entry.value);
			if (stage === "intent") return record.version === 4;
			if (stage === "create") return record.initialSend?.context?.createAttempted === true;
			if (stage === "target") return record.initialSend?.conversationId === "conversation";
			if (stage === "authorization") return !!record.initialSend?.context?.authorization;
			if (stage === "submit") return record.initialSend?.context?.submitAttempted === true;
			return record.version === 2;
		};
		await f.session.sendInitial(input());
		assert.equal(f.session.getSnapshot().failed, true, stage);
		const submitted = ["draft", "pending", "source", "clear"].includes(stage);
		assert.equal(f.providerTurns.length, submitted ? 1 : 0, stage);
		if (stage === "intent") assert.equal(mutations(f).length, 0);
		else assert.ok(f.session.getSnapshot().initialSend, stage);
		f.storage.fail = () => false;
		const reopened = new CatalogSession(f.client, new LocalState("store", f.storage), f.authority);
		const count = mutations(f).length;
		await reopened.check();
		assert.equal(mutations(f).length, count, stage);
		if (submitted) {
			assert.equal(reopened.getSnapshot().initialSend, null, stage);
			assert.equal(reopened.getSnapshot().receipt?.state, "accepted", stage);
		}
	}
});

test("stale binding, revision, root, expiry and model fail closed without an earlier provider turn", async () => {
	for (const stale of ["binding", "revision", "root", "expiry", "model", "revoked"] as const) {
		const f = fixture();
		const request = input();
		if (stale === "expiry" && request.context) request.context.expiresAt = Date.now() - 1;
		if (stale === "binding" && f.state.folder.status === "available") f.state.folder.bindingId = "replacement";
		if (stale === "revision" && f.state.folder.status === "available") f.state.folder.revision++;
		if (stale === "root" && f.state.folder.status === "available") f.state.folder.root.rootId = "restarted-root";
		if (stale === "model") f.state.model.model = { ...model, modelId: "replacement" };
		if (stale === "revoked" && f.state.folder.status === "available")
			f.state.folder = { ...f.state.folder, status: "revoked", root: null };
		await f.session.sendInitial(request);
		assert.equal(f.providerTurns.length, 0, stale);
		assert.equal(f.grants.size, 0, stale);
		assert.equal(f.session.getSnapshot().initialConsentInvalidated, true, stale);
		assert.equal(f.local.read("task-draft.project"), prompt);
		await f.session.retry();
		assert.equal(f.providerTurns.length, 0, stale);
	}
});

test("root revocation or model change after grant stops first submission", async () => {
	for (const stale of ["root", "model", "grant", "active-missing"] as const) {
		const f = fixture();
		f.override((method, params) => {
			if (method !== "authorizeAgentContext") return undefined;
			const result = f.respond(method, params);
			if (stale === "root" && f.state.folder.status === "available")
				f.state.folder = { ...f.state.folder, status: "revoked", root: null };
			if (stale === "model") f.state.model.model = { ...model, modelId: "changed" };
			if (stale === "grant") for (const grant of f.grants.values()) grant.status = "revoked";
			if (stale === "active-missing")
				f.override((next) => (next === "listActiveAgentContexts" ? Promise.resolve([]) : undefined));
			return Promise.resolve(result);
		});
		await f.session.sendInitial(input());
		assert.equal(f.providerTurns.length, 0, stale);
		assert.equal(f.local.pending("project.conversation"), null, stale);
		assert.equal(f.session.getSnapshot().initialConsentInvalidated, true, stale);
	}
});

test("ordinary pending retry cannot bypass a consent owner, including partial accepted handoff", async () => {
	for (const acceptedBeforeFailure of [false, true]) {
		const f = fixture();
		if (acceptedBeforeFailure)
			f.storage.fail = (key, raw) =>
				key.endsWith("value.command.catalog") && JSON.parse(JSON.parse(raw).value).version === 2;
		else f.override((method) => (method === "authorizeAgentContext" ? Promise.reject(new Error("lost")) : undefined));
		await f.session.sendInitial(input());
		const task = f.session.getSnapshot().initialSend;
		assert.ok(task?.conversationId);
		const attempted: Submit = {
			workspaceId: "project",
			conversationId: task.conversationId,
			requestId: task.submissionId,
			text: task.text,
		};
		await assert.rejects(
			submitRequest(f.client, f.local, attempted, new AbortController().signal),
			/PREREQUISITE_REQUIRED/,
		);
		await assert.rejects(
			submitRequest(f.client, f.local, { ...attempted, requestId: "other" }, new AbortController().signal),
			/PREREQUISITE_REQUIRED/,
		);
		assert.equal(f.providerTurns.length, acceptedBeforeFailure ? 1 : 0);
	}
});

test("explicit pre-submit draft recovery verifies grant outcome and retains existing grant without sending", async () => {
	const f = fixture();
	f.storage.fail = (key, raw) =>
		key.endsWith("value.command.catalog") &&
		JSON.parse(JSON.parse(raw).value).initialSend?.context?.submitAttempted === true;
	await f.session.sendInitial(input());
	assert.equal(f.providerTurns.length, 0);
	f.storage.fail = () => false;
	const local = new LocalState("store", f.storage);
	const reopened = new CatalogSession(f.client, local, f.authority);
	await reopened.check();
	assert.equal(reopened.getSnapshot().initialConsentCanRecoverDraft, true);
	assert.equal(reopened.getSnapshot().initialConsentGrantActive, true);
	await reopened.recoverInitialDraft();
	assert.equal(reopened.getSnapshot().initialSend, null);
	assert.equal(local.read("draft.project.conversation"), prompt);
	assert.equal(local.read("task-draft.project"), prompt);
	assert.equal(local.pending("project.conversation"), null);
	assert.equal([...f.grants.values()][0]?.status, "active");
	assert.equal(f.providerTurns.length, 0);
});

test("malformed consent recovery is incompatible and never drops the prerequisite fence", async () => {
	const f = fixture();
	f.override((method) => (method === "authorizeAgentContext" ? Promise.reject(new Error("lost")) : undefined));
	await f.session.sendInitial(input());
	const raw = f.local.read("command.catalog");
	assert.ok(raw);
	for (const patch of [
		{ rootId: "foreign" },
		{ bindingRevision: 0 },
		{ model: { provider: "other", modelId: "test" } },
		{ pathPrefixes: ["../private"] },
		{ absolutePath: "/private/project" },
	]) {
		const saved = JSON.parse(raw);
		Object.assign(saved.initialSend.context.staged, patch);
		const invalid = JSON.stringify(saved);
		f.local.write("command.catalog", invalid);
		const reopened = new CatalogSession(f.client, f.local, f.authority);
		assert.equal(reopened.getSnapshot().incompatible, true);
		const before = mutations(f).length;
		await reopened.check();
		await reopened.retry();
		assert.equal(mutations(f).length, before);
		await assert.rejects(
			submitRequest(
				f.client,
				f.local,
				{
					workspaceId: "project",
					conversationId: "conversation",
					requestId: "bypass",
					text: prompt,
				},
				new AbortController().signal,
			),
			/PREREQUISITE_REQUIRED/,
		);
		assert.equal(f.local.read("command.catalog"), invalid);
	}
});

test("cross-tab admission and displaced owner checks prevent a second first-turn chain", async () => {
	const f = fixture();
	const otherLocal = new LocalState("store", f.storage);
	const other = new CatalogSession(f.client, otherLocal, f.authority);
	await Promise.all([f.session.sendInitial(input()), other.sendInitial(input())]);
	assert.equal(f.providerTurns.length, 1);
	assert.equal(mutations(f).filter((call) => call.method === "createConversation").length, 1);

	for (const displacedAt of ["project", "grant"] as const) {
		const changed = fixture();
		const displace = () => {
			const raw = changed.local.read("command.catalog");
			assert.ok(raw);
			const record = JSON.parse(raw);
			record.initialSend.submissionId = "another-owner";
			record.initialSend.text = "another captured prompt";
			new LocalState("store", changed.storage).write("command.catalog", JSON.stringify(record));
		};
		if (displacedAt === "project") {
			changed.authority.getProject = async () => {
				displace();
				return changed.state.folder;
			};
		} else {
			changed.override((method, params) => {
				if (method !== "listActiveAgentContexts") return undefined;
				displace();
				return Promise.resolve(changed.respond(method, params));
			});
		}
		await changed.session.sendInitial(input());
		assert.equal(changed.providerTurns.length, 0, displacedAt);
		assert.equal(changed.session.getSnapshot().failed, true, displacedAt);
	}
});

test("an unknown created target fences ordinary same-project submissions until exact target recovery", async () => {
	const f = fixture();
	f.override((method) => (method === "createConversation" ? Promise.reject(new Error("lost")) : undefined));
	await f.session.sendInitial(input());
	const other = new LocalState("store", f.storage);
	await assert.rejects(
		submitRequest(
			f.client,
			other,
			{
				workspaceId: "project",
				conversationId: "discovered-conversation",
				requestId: "bypass",
				text: "bypass",
			},
			new AbortController().signal,
		),
		/PREREQUISITE_REQUIRED/,
	);
	assert.equal(other.pending("project.discovered-conversation"), null);
	assert.equal(f.providerTurns.length, 0);
});

test("late authorization after disposal never submits and reload can explicitly keep the verified draft", async () => {
	const f = fixture();
	const reply = Promise.withResolvers<unknown>();
	f.override((method, params) => {
		if (method !== "authorizeAgentContext") return undefined;
		f.respond(method, params);
		return reply.promise;
	});
	const run = f.session.sendInitial(input());
	await vi.waitFor(() => assert.equal(f.grants.size, 1));
	f.session.dispose();
	await run;
	const local = new LocalState("store", f.storage);
	const reopened = new CatalogSession(f.client, local, f.authority);
	await reopened.check();
	await reopened.retry();
	assert.equal(reopened.getSnapshot().initialConsentInvalidated, true);
	assert.equal(reopened.getSnapshot().initialConsentGrantActive, true);
	assert.equal(reopened.getSnapshot().initialConsentCanRecoverDraft, true);
	assert.equal(local.pending("project.conversation"), null);
	assert.equal(f.providerTurns.length, 0);
	reply.resolve([...f.grants.values()][0]);
	await Promise.resolve();
	await reopened.recoverInitialDraft();
	assert.equal(local.read("draft.project.conversation"), prompt);
	assert.equal(f.providerTurns.length, 0);
});

test("wrong grant or submit receipt scope never releases consent ownership or source text", async () => {
	for (const scope of ["grant", "receipt"] as const) {
		const f = fixture();
		f.override((method, params) => {
			if (scope === "grant" && method === "getAgentCommandResult") {
				const grant = [...f.grants.values()][0];
				return Promise.resolve(
					grant
						? {
								method: "authorizeAgentContext",
								result: { ...grant, conversationId: "foreign" },
							}
						: null,
				);
			}
			if (scope === "receipt" && method === "submit") {
				const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
				if (request.method !== "submit") throw new Error("wrong method");
				return Promise.resolve({ ...accepted(request.params), conversationId: "foreign" });
			}
			return undefined;
		});
		await f.session.sendInitial(input());
		assert.equal(f.session.getSnapshot().failed, true, scope);
		assert.ok(f.session.getSnapshot().initialSend, scope);
		assert.equal(f.local.pending("project.conversation"), null);
		assert.equal(f.local.read("task-draft.project"), prompt);
		assert.equal(f.providerTurns.length, 0);
	}
});

test("never-dispatched stale consent can recover its original source without creating a chat or overwriting edits", async () => {
	for (const edited of [false, true]) {
		const f = fixture();
		const request = input({ ...consent(), expiresAt: Date.now() - 1 });
		await f.session.sendInitial(request);
		assert.equal(f.session.getSnapshot().initialSend?.context?.createAttempted, false);
		assert.equal(f.session.getSnapshot().initialConsentCanRecoverDraft, true);
		assert.deepEqual(mutations(f), []);
		if (edited) f.local.write("task-draft.project", "newer project draft");
		const reopened = new CatalogSession(f.client, new LocalState("store", f.storage), f.authority);
		await reopened.recoverInitialDraft();
		assert.equal(reopened.getSnapshot().result, null);
		if (edited) {
			assert.equal(reopened.getSnapshot().handoffConflict, true);
			assert.ok(reopened.getSnapshot().initialSend);
		} else {
			assert.equal(reopened.getSnapshot().initialSend, null);
			assert.equal(reopened.getSnapshot().pending, null);
		}
		assert.equal(f.local.read("task-draft.project"), edited ? "newer project draft" : prompt);
		assert.deepEqual(mutations(f), []);
	}
});

test("missing or contradictory dispatch markers are rejected rather than inferred as safe draft recovery", async () => {
	const f = fixture();
	f.override((method) => (method === "authorizeAgentContext" ? Promise.reject(new Error("lost")) : undefined));
	await f.session.sendInitial(input());
	const original = f.local.read("command.catalog");
	assert.ok(original);
	for (const marker of [undefined, false, "false"]) {
		const record = JSON.parse(original);
		record.initialSend.context.createAttempted = marker;
		f.local.write("command.catalog", JSON.stringify(record));
		const reopened = new CatalogSession(f.client, f.local, f.authority);
		assert.equal(reopened.getSnapshot().incompatible, true);
		await reopened.recoverInitialDraft();
		assert.equal(f.local.read("draft.project.conversation"), null);
		assert.equal(f.providerTurns.length, 0);
	}
});

test("explicit combination preserves newer draft then exact original in source and verified chat without sending", async () => {
	for (const target of ["source", "conversation"] as const) {
		const f = fixture();
		if (target === "source") await f.session.sendInitial(input({ ...consent(), expiresAt: Date.now() - 1 }));
		else {
			f.storage.fail = (key, raw) =>
				key.endsWith("value.command.catalog") &&
				JSON.parse(JSON.parse(raw).value).initialSend?.context?.submitAttempted === true;
			await f.session.sendInitial(input());
			f.storage.fail = () => false;
		}
		const key = target === "source" ? "task-draft.project" : "draft.project.conversation";
		const newer = "  Newer exact draft\nDo not change whitespace.  ";
		f.local.write(key, newer);
		await f.session.recoverInitialDraft();
		assert.equal(f.session.getSnapshot().handoffConflict, true);
		const mutationsBefore = mutations(f).length;
		await f.session.combineInitialDraft();
		assert.equal(f.session.getSnapshot().initialSend, null, target);
		assert.equal(f.local.read(key), `${newer}\n\n---\n\n${prompt}`);
		assert.equal(new LocalState("store", f.storage).read(key), `${newer}\n\n---\n\n${prompt}`);
		assert.equal(f.local.pending("project.conversation"), null);
		assert.equal(f.providerTurns.length, 0);
		assert.equal(mutations(f).length, mutationsBefore);
	}
});

test("combination refuses oversized or stale local/cross-tab drafts while preserving both originals", async () => {
	for (const conflict of ["oversize", "local", "other-tab"] as const) {
		const f = fixture();
		f.storage.fail = (key, raw) =>
			key.endsWith("value.command.catalog") &&
			JSON.parse(JSON.parse(raw).value).initialSend?.context?.submitAttempted === true;
		await f.session.sendInitial(input());
		f.storage.fail = () => false;
		const key = "draft.project.conversation";
		const existing = conflict === "oversize" ? "x".repeat(LIMITS.text) : "newer draft";
		f.local.write(key, existing);
		if (conflict !== "oversize") {
			f.override((method, params) => {
				if (method !== "getConversationCommandResult") return undefined;
				const writer = conflict === "local" ? f.local : new LocalState("store", f.storage);
				writer.write(key, "edited while checking provenance");
				return Promise.resolve(f.respond(method, params));
			});
		}
		await f.session.combineInitialDraft();
		assert.equal(f.session.getSnapshot().handoffConflict, true, conflict);
		assert.equal(f.session.getSnapshot().initialSend?.text, prompt);
		assert.equal(
			new LocalState("store", f.storage).read(key),
			conflict === "oversize" ? existing : "edited while checking provenance",
		);
		assert.equal(f.providerTurns.length, 0);
		assert.equal(f.local.pending("project.conversation"), null);
	}
});

test("each interrupted combination write is recoverable without appending the original twice", async () => {
	for (const target of ["source", "conversation"] as const) {
		for (const stage of ["journal", "draft", "clear"] as const) {
			const f = fixture();
			if (target === "source") await f.session.sendInitial(input({ ...consent(), expiresAt: Date.now() - 1 }));
			else {
				f.storage.fail = (key, raw) =>
					key.endsWith("value.command.catalog") &&
					JSON.parse(JSON.parse(raw).value).initialSend?.context?.submitAttempted === true;
				await f.session.sendInitial(input());
				f.storage.fail = () => false;
			}
			const key = target === "source" ? "task-draft.project" : "draft.project.conversation";
			const newer = "newer draft";
			f.local.write(key, newer);
			f.storage.fail = (storageKey, raw) => {
				if (stage === "draft") return storageKey.endsWith(`value.${key}`);
				if (!storageKey.endsWith("value.command.catalog")) return false;
				const record = JSON.parse(JSON.parse(raw).value);
				return stage === "journal" ? !!record.initialSend?.context?.draftCombination : record.version === 2;
			};
			await f.session.combineInitialDraft();
			assert.equal(f.session.getSnapshot().failed, true, `${target}/${stage}`);
			assert.ok(f.session.getSnapshot().initialSend);
			f.storage.fail = () => false;
			const local = new LocalState("store", f.storage);
			const reopened = new CatalogSession(f.client, local, f.authority);
			await reopened.combineInitialDraft();
			assert.equal(reopened.getSnapshot().initialSend, null, `${target}/${stage}`);
			assert.equal(local.read(key), `${newer}\n\n---\n\n${prompt}`, `${target}/${stage}`);
			assert.equal(f.providerTurns.length, 0);
		}
	}
});

test("unknown creation, unknown grant and attempted Submit cannot be released through combination", async () => {
	for (const stage of ["createConversation", "authorizeAgentContext", "submit"] as const) {
		const f = fixture();
		f.override((method) => (method === stage ? Promise.reject(new Error("lost")) : undefined));
		await f.session.sendInitial(input());
		f.local.write("task-draft.project", "source edited");
		f.local.write("draft.project.conversation", "chat edited");
		const before = f.local.read("command.catalog");
		await f.session.combineInitialDraft();
		assert.equal(f.local.read("command.catalog"), before, stage);
		assert.equal(f.local.read("task-draft.project"), "source edited");
		assert.equal(f.local.read("draft.project.conversation"), "chat edited");
		assert.equal(f.providerTurns.length, 0);
		assert.equal(f.local.pending("project.conversation"), null);
	}
});

test("combination accepts the exact text bound and rejects malformed recovery journals", async () => {
	const f = fixture();
	await f.session.sendInitial(input({ ...consent(), expiresAt: Date.now() - 1 }));
	const raw = f.local.read("command.catalog");
	assert.ok(raw);
	for (const journal of [
		null,
		{},
		{ revision: "after" },
		{ beforeRevision: null, revision: "" },
		{ beforeRevision: "same", revision: "same" },
		{ beforeRevision: null, revision: "after", text: "unexpected payload" },
	]) {
		const record = JSON.parse(raw);
		record.initialSend.context.draftCombination = journal;
		assert.equal(readCatalogRecovery(JSON.stringify(record)).incompatible, true);
	}
	const newer = "x".repeat(LIMITS.text - prompt.length - "\n\n---\n\n".length);
	f.local.write("task-draft.project", newer);
	await f.session.combineInitialDraft();
	assert.equal(f.session.getSnapshot().initialSend, null);
	assert.equal(f.local.read("task-draft.project"), `${newer}\n\n---\n\n${prompt}`);
	assert.equal(f.local.read("task-draft.project")?.length, LIMITS.text);
	assert.deepEqual(mutations(f), []);
});
