import assert from "node:assert/strict";
import {
	type AppClient,
	AppError,
	type Conversation,
	LIMITS,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type Submit,
} from "@hipi/work-runtime/contracts";
import { afterEach, test, vi } from "vitest";
import type { InitialSendInput } from "../../../src/features/workbench/catalog/initial-send.ts";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import type { BrowserStorage } from "../../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { reconcileReceipt } from "../../../src/features/workbench/receipt-reconciliation.ts";
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
function locks(available: Promise<void> = Promise.resolve()) {
	const queues = new Map<string, Promise<unknown>>();
	vi.stubGlobal("navigator", {
		locks: {
			request: (name: string, work: () => unknown) => {
				const next = (queues.get(name) ?? available).then(work);
				queues.set(
					name,
					next.catch(() => {}),
				);
				return next;
			},
		},
	});
}
const prompt = "  第一条完整消息\nKeep this original text.  ";
const input: InitialSendInput = {
	workspaceId: "project",
	sourceKey: "task-draft.project",
	text: prompt,
	title: "First message",
	model: { provider: "fake", modelId: "test" },
};
const globalInput: InitialSendInput = { ...input, workspaceId: null, sourceKey: "chat-draft.global" };
function accepted(input: Submit) {
	return {
		workspaceId: input.workspaceId,
		conversationId: input.conversationId,
		requestId: input.requestId,
		receiptId: "receipt",
		state: "accepted" as const,
	};
}
function fixture(storage = new MemoryStorage(), storeId = "store", leaseActive = () => true) {
	const local = new LocalState(storeId, storage, leaseActive);
	const calls: { method: Method; params: unknown }[] = [];
	const workspaces = new Map([["project", { workspaceId: "project", name: "Project" }]]);
	const conversations = new Map<string, Conversation>();
	const commands = new Map<string, Conversation>();
	const receipts = new Map<string, Submit>();
	let override: ((method: Method, params: unknown) => Promise<unknown> | undefined) | undefined;
	const respond = (method: Method, raw: unknown): unknown => {
		const request = parseRequest({ version: PROTOCOL_VERSION, method, params: raw });
		switch (request.method) {
			case "createWorkspace": {
				const workspace = { ...request.params };
				workspaces.set(workspace.workspaceId, workspace);
				return workspace;
			}
			case "getWorkspace": {
				const workspace = workspaces.get(request.params.workspaceId);
				if (!workspace) throw new AppError("NOT_FOUND");
				return workspace;
			}
			case "createConversation": {
				const result: Conversation = {
					workspaceId: request.params.workspaceId,
					conversationId: `conversation-${commands.size}`,
					title: request.params.title,
					revision: 1,
					createdAt: 10,
					archivedAt: null,
				};
				commands.set(request.params.requestId, result);
				conversations.set(result.conversationId, result);
				return result;
			}
			case "getConversationCommandResult": {
				const result = commands.get(request.params.requestId);
				return result ? { method: "createConversation", result } : null;
			}
			case "getConversation": {
				const conversation = conversations.get(request.params.conversationId);
				if (!conversation) throw new AppError("NOT_FOUND");
				return conversation;
			}
			case "getConversationModel":
				return { model: input.model, credentialState: "configured", executionState: "ready" };
			case "submit":
				receipts.set(request.params.requestId, request.params);
				return accepted(request.params);
			case "getReceipt": {
				const receipt = receipts.get(request.params.requestId);
				return receipt ? accepted(receipt) : null;
			}
			default:
				throw new Error(`Unexpected ${method}`);
		}
	};
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>) => {
			parseRequest({ version: PROTOCOL_VERSION, method, params });
			calls.push({ method, params });
			return parseResult(method, await (override?.(method, params) ?? respond(method, params)));
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	return {
		local,
		storage,
		client,
		calls,
		workspaces,
		conversations,
		commands,
		receipts,
		respond,
		session: new CatalogSession(client, local),
		handle(next: typeof override) {
			override = next;
		},
	};
}
function mutations(f: ReturnType<typeof fixture>) {
	return f.calls.filter((call) => ["createWorkspace", "createConversation", "submit"].includes(call.method));
}
afterEach(() => vi.unstubAllGlobals());

test("one project Send creates and submits original input once despite duplicate activation and caller edits", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	const captured = structuredClone(input);
	const run = f.session.sendInitial(captured);
	const duplicate = f.session.sendInitial({ ...input, text: "duplicate" });
	captured.text = "edited caller";
	captured.workspaceId = "elsewhere";
	await Promise.all([run, duplicate]);
	assert.deepEqual(
		mutations(f).map((call) => call.method),
		["createConversation", "submit"],
	);
	const submitted = parseRequest({ version: PROTOCOL_VERSION, method: "submit", params: mutations(f)[1]?.params });
	assert.equal(submitted.method, "submit");
	if (submitted.method !== "submit") throw new Error("wrong request");
	assert.equal(submitted.params.text, prompt);
	assert.equal(submitted.params.workspaceId, "project");
	const key = `project.${submitted.params.conversationId}`;
	assert.deepEqual(f.local.pending(key), submitted.params);
	assert.equal(f.local.isConfirmed(submitted.params.requestId), true);
	assert.equal(f.local.read(`draft.${key}`), "");
	assert.equal(f.local.read(input.sourceKey), "");
	assert.equal(f.session.getSnapshot().initialSend, null);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.session.getSnapshot().receipt?.state, "accepted");
});

test("global opening creates nothing; first Send records an exact default identity and never adopts a name match", async () => {
	locks();
	const f = fixture();
	f.workspaces.set("unrelated", { workspaceId: "unrelated", name: "Chats" });
	f.session.activate();
	await f.session.check();
	assert.deepEqual(mutations(f), []);
	assert.equal(f.session.defaultWorkspaceId(), null);
	f.local.write(globalInput.sourceKey, prompt);
	await f.session.sendInitial(globalInput);
	assert.deepEqual(
		mutations(f).map((call) => call.method),
		["createWorkspace", "createConversation", "submit"],
	);
	const workspaceId = f.session.defaultWorkspaceId();
	assert.ok(workspaceId);
	assert.notEqual(workspaceId, "unrelated");
	assert.equal(f.session.getSnapshot().submission?.workspaceId, workspaceId);
	const reopened = new CatalogSession(f.client, new LocalState("store", f.storage));
	assert.equal(reopened.defaultWorkspaceId(), workspaceId);
	await reopened.sendInitial({ ...globalInput, text: "next", title: "Next" });
	assert.equal(mutations(f).filter((call) => call.method === "createWorkspace").length, 1);
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 2);
	assert.equal(new CatalogSession(f.client, new LocalState("other", f.storage)).defaultWorkspaceId(), null);
});

test("unknown workspace result survives reload and advances only with explicit immutable retry", async () => {
	locks();
	const f = fixture();
	f.local.write(globalInput.sourceKey, prompt);
	f.handle((method) => (method === "createWorkspace" ? Promise.reject(new Error("offline")) : undefined));
	await f.session.sendInitial(globalInput);
	assert.equal(f.session.getSnapshot().notFound, true);
	const saved = f.local.read("command.catalog");
	assert.ok(saved);
	const reopened = new CatalogSession(f.client, new LocalState("store", f.storage));
	await reopened.check();
	assert.deepEqual(
		mutations(f).map((call) => call.method),
		["createWorkspace"],
	);
	f.handle(undefined);
	await reopened.retry();
	const creates = mutations(f).filter((call) => call.method === "createWorkspace");
	assert.equal(creates.length, 2);
	assert.deepEqual(creates[0]?.params, creates[1]?.params);
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
	assert.equal(reopened.getSnapshot().submission?.text, prompt);
});

test("reload with a committed workspace checks exact identity but never automatically creates the conversation", async () => {
	locks();
	const f = fixture();
	f.local.write(globalInput.sourceKey, prompt);
	const pending = Promise.withResolvers<unknown>();
	f.handle((method, params) => {
		if (method !== "createWorkspace") return undefined;
		f.respond(method, params);
		return pending.promise;
	});
	const run = f.session.sendInitial(globalInput);
	await vi.waitFor(() => assert.equal(mutations(f).length, 1));
	f.session.dispose();
	f.local.deactivate();
	await run;
	const local = new LocalState("store", f.storage);
	const reopened = new CatalogSession(f.client, local);
	await reopened.check();
	assert.equal(reopened.getSnapshot().pending?.method, "createConversation");
	assert.equal(reopened.getSnapshot().notFound, true);
	assert.deepEqual(
		mutations(f).map((call) => call.method),
		["createWorkspace"],
	);
	assert.ok(reopened.defaultWorkspaceId());
	f.handle(undefined);
	await reopened.retry();
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
	pending.resolve({ workspaceId: "late", name: "Chats" });
	await Promise.resolve();
	assert.equal(local.read("command.catalog"), JSON.stringify({ version: 2, request: null }));
});

test("unknown conversation is recovered to the existing pending Submit owner without sending on reload", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	const pending = Promise.withResolvers<unknown>();
	f.handle((method, params) => {
		if (method !== "createConversation") return undefined;
		f.respond(method, params);
		return pending.promise;
	});
	const run = f.session.sendInitial(input);
	await vi.waitFor(() => assert.equal(f.commands.size, 1));
	f.session.dispose();
	f.local.deactivate();
	await run;
	const local = new LocalState("store", f.storage);
	const reopened = new CatalogSession(f.client, local);
	await reopened.check();
	assert.deepEqual(
		mutations(f).map((call) => call.method),
		["createConversation"],
	);
	const submitted = reopened.getSnapshot().submission;
	assert.ok(submitted);
	assert.deepEqual(local.pending(`${submitted.workspaceId}.${submitted.conversationId}`), submitted);
	assert.equal(reopened.getSnapshot().initialSend, null);
	await reopened.check();
	await reopened.retry();
	assert.equal(mutations(f).length, 1);
	const receipt = await submitRequest(f.client, local, submitted, new AbortController().signal);
	assert.equal(receipt.requestId, submitted.requestId);
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
});

test("unknown submit is owned only by per-conversation pending recovery and is never replayed by catalog reload", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	f.handle((method) => (method === "submit" ? Promise.reject(new Error("lost")) : undefined));
	await f.session.sendInitial(input);
	const submitted = f.session.getSnapshot().submission;
	assert.ok(submitted);
	assert.equal(f.session.getSnapshot().initialSend, null);
	assert.equal(f.session.getSnapshot().failed, true);
	const local = new LocalState("store", f.storage);
	assert.deepEqual(local.pending(`project.${submitted.conversationId}`), submitted);
	const reopened = new CatalogSession(f.client, local);
	await reopened.check();
	await reopened.retry();
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
	assert.equal(local.read(`draft.project.${submitted.conversationId}`), prompt);
});

test("each partial ownership write blocks later dispatch and recovery never automatically sends", async () => {
	for (const stage of [
		"intent",
		"workspace-map",
		"workspace-transition",
		"target",
		"draft",
		"pending",
		"source",
		"clear",
	] as const) {
		locks();
		const f = fixture();
		f.local.write(globalInput.sourceKey, prompt);
		f.storage.fail = (key, raw) => {
			const entry = JSON.parse(raw);
			if (stage === "workspace-map") return key.endsWith("value.default-chat-workspace");
			if (stage === "draft") return key.includes(".value.draft.");
			if (stage === "pending") return key.includes(".pending.");
			if (stage === "source") return key.endsWith("value.chat-draft.global") && entry.value === "";
			if (!key.endsWith("value.command.catalog")) return false;
			const record = JSON.parse(entry.value);
			if (stage === "intent") return true;
			if (stage === "workspace-transition") return record.request?.method === "createConversation";
			if (stage === "target") return record.version === 3 && record.request === null;
			return stage === "clear" && record.version === 2;
		};
		await f.session.sendInitial(globalInput);
		assert.equal(f.session.getSnapshot().failed, true, stage);
		assert.equal(
			mutations(f).some((call) => call.method === "submit"),
			false,
			stage,
		);
		assert.equal(
			mutations(f).filter((call) => call.method === "createWorkspace").length,
			stage === "intent" ? 0 : 1,
			stage,
		);
		f.storage.fail = () => false;
		const local = new LocalState("store", f.storage);
		const reopened = new CatalogSession(f.client, local);
		await reopened.check();
		assert.equal(
			mutations(f).some((call) => call.method === "submit"),
			false,
			stage,
		);
		if (stage !== "intent") assert.ok(local.read("command.catalog"));
	}
});

test("model, credential, archived and store errors preserve original pending input without submitting", async () => {
	for (const failure of ["model", "credentials", "archived", "store"] as const) {
		locks();
		const f = fixture();
		f.local.write(input.sourceKey, prompt);
		f.handle((method, params) => {
			if (method === "getConversationModel")
				return failure === "store"
					? Promise.reject(new AppError("STORE_MISMATCH"))
					: Promise.resolve({
							model: failure === "model" ? { provider: "other", modelId: "test" } : input.model,
							credentialState: failure === "credentials" ? "missing" : "configured",
							executionState: "ready",
						});
			if (method === "getConversation" && failure === "archived") {
				const result = f.respond(method, params);
				return Promise.resolve({ ...(result as Conversation), archivedAt: 20 });
			}
			return undefined;
		});
		await f.session.sendInitial(input);
		assert.equal(f.session.getSnapshot().failed, true, failure);
		assert.ok(f.session.getSnapshot().submission, failure);
		assert.equal(
			mutations(f).some((call) => call.method === "submit"),
			false,
			failure,
		);
		assert.equal(f.session.getSnapshot().initialSend, null, failure);
		assert.equal(new LocalState("store", f.storage).read("draft.project.conversation-0"), prompt, failure);
	}
});

test("source and destination edits, including away-and-back, survive delayed initial receipt reconciliation", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	const receipt = Promise.withResolvers<unknown>();
	f.handle((method) => (method === "submit" ? receipt.promise : undefined));
	const run = f.session.sendInitial(input);
	await vi.waitFor(() => assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1));
	f.local.write(input.sourceKey, "new source");
	f.local.write(input.sourceKey, prompt);
	f.local.write("draft.project.conversation-0", "new destination");
	f.local.write("draft.project.conversation-0", prompt);
	const submitted = f.local.pending("project.conversation-0");
	assert.ok(submitted);
	receipt.resolve(accepted(submitted));
	await run;
	assert.equal(f.local.read(input.sourceKey), prompt);
	assert.equal(f.local.read("draft.project.conversation-0"), prompt);
	assert.equal(new LocalState("store", f.storage).read("draft.project.conversation-0"), prompt);
	assert.equal(f.local.isConfirmed(submitted.requestId), true);
});

test("queued initial Send never adopts source edits made before admission, including identical new drafts", async () => {
	for (const source of [input, globalInput]) {
		for (const existing of [true, false]) {
			const admission = Promise.withResolvers<void>();
			locks(admission.promise);
			const f = fixture();
			if (existing) f.local.write(source.sourceKey, prompt);
			const originalRevision = f.local.valueSnapshot(source.sourceKey)?.revision ?? null;
			const captured = structuredClone(source);
			const run = f.session.sendInitial(captured);
			assert.deepEqual(f.calls, []);
			f.local.write(source.sourceKey, "later edit");
			f.local.write(source.sourceKey, prompt);
			const laterDraft = f.local.valueSnapshot(source.sourceKey);
			assert.notEqual(laterDraft?.revision, originalRevision);
			captured.text = "caller mutation";
			captured.title = "caller title";
			if (captured.model) captured.model.modelId = "caller model";
			f.handle((method) => {
				if (method === "createConversation") {
					const task = f.session.getSnapshot().initialSend;
					assert.equal(task?.sourceRevision, originalRevision);
					assert.equal(task?.text, prompt);
					assert.equal(task?.conversationCommand.params.title, source.title);
					assert.deepEqual(task?.conversationCommand.params.model, source.model);
				}
				return undefined;
			});
			admission.resolve();
			await run;
			assert.equal(f.session.getSnapshot().failed, false);
			assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
			assert.deepEqual(f.local.valueSnapshot(source.sourceKey), laterDraft);
			assert.deepEqual(new LocalState("store", f.storage).valueSnapshot(source.sourceKey), laterDraft);
			const submitted = f.session.getSnapshot().submission;
			assert.ok(submitted);
			assert.equal(f.local.read(`draft.${submitted.workspaceId}.${submitted.conversationId}`), "");
		}
	}
});

test("an independently authored destination with identical text is neither replaced nor cleared", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	f.local.write("draft.project.conversation-0", prompt);
	const before = f.local.valueSnapshot("draft.project.conversation-0");
	await f.session.sendInitial(input);
	assert.deepEqual(f.local.valueSnapshot("draft.project.conversation-0"), before);
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
});

test("old draft-only prepared records recover as drafts and never acquire Send authorization", async () => {
	locks();
	const f = fixture();
	const command = {
		version: PROTOCOL_VERSION,
		method: "createConversation",
		params: { workspaceId: "project", requestId: "legacy", title: input.title, model: input.model },
	};
	f.respond("createConversation", command.params);
	f.local.write(
		"command.catalog",
		JSON.stringify({
			version: 2,
			request: command,
			preparedTask: {
				workspaceId: "project",
				requestId: "legacy",
				text: prompt,
				sourceRevision: null,
				conversationId: null,
			},
		}),
	);
	const reopened = new CatalogSession(f.client, new LocalState("store", f.storage));
	await reopened.check();
	assert.equal(mutations(f).length, 0);
	assert.equal(reopened.getSnapshot().submission, null);
	assert.equal(new LocalState("store", f.storage).read("draft.project.conversation-0"), prompt);
});

test("foreign scope, modified recovery, denied persistence, missing admission and released leases never send", async () => {
	for (const failure of ["scope", "owner", "store", "locks", "lease"] as const) {
		locks();
		let active = true;
		const f = fixture(new MemoryStorage(), "store", () => active);
		f.local.write(input.sourceKey, prompt);
		if (failure === "locks") vi.stubGlobal("navigator", {});
		if (failure === "lease") active = false;
		f.handle((method, params) => {
			if (method === "getWorkspace") {
				if (failure === "store") return Promise.reject(new AppError("STORE_MISMATCH"));
				if (failure === "scope") return Promise.resolve({ workspaceId: "foreign", name: "Project" });
				if (failure === "owner") {
					const raw = f.local.read("command.catalog");
					assert.ok(raw);
					const record = JSON.parse(raw);
					record.initialSend.text = "displaced";
					f.local.write("command.catalog", JSON.stringify(record));
				}
			}
			return Promise.resolve(f.respond(method, params));
		});
		await f.session.sendInitial(input);
		assert.equal(f.session.getSnapshot().failed, true, failure);
		assert.equal(mutations(f).length, 0, failure);
		assert.equal(new LocalState("store", f.storage).read(input.sourceKey), prompt, failure);
	}
});

test("two catalog owners cannot admit two first Sends in the same durable store", async () => {
	locks();
	const f = fixture();
	const second = new CatalogSession(f.client, new LocalState("store", f.storage));
	await Promise.all([f.session.sendInitial(input), second.sendInitial({ ...input, text: "competitor" })]);
	assert.equal(mutations(f).filter((call) => call.method === "createConversation").length, 1);
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
});

test("normal shared submission protects a later identical draft and keeps the exact explicit retry identity", async () => {
	locks();
	const f = fixture();
	const submitted: Submit = {
		workspaceId: "project",
		conversationId: "conversation",
		requestId: "normal",
		text: prompt,
	};
	const key = "project.conversation";
	f.local.write(`draft.${key}`, prompt);
	await submitRequest(f.client, f.local, submitted, new AbortController().signal);
	f.local.write(`draft.${key}`, "edit");
	f.local.write(`draft.${key}`, prompt);
	const receipt = { ...submitted, receiptId: "receipt", state: "accepted" as const };
	assert.equal(reconcileReceipt(f.local, key, prompt, submitted, receipt), prompt);
	assert.equal(f.local.read(`draft.${key}`), prompt);
	await submitRequest(f.client, f.local, submitted, new AbortController().signal);
	assert.deepEqual(
		mutations(f).map((call) => call.params),
		[submitted, submitted],
	);
	assert.equal(new LocalState("store", f.storage).read(`draft.${key}`), prompt);
});

test("queued normal Send preserves its original payload and draft revision through admission and explicit retry", async () => {
	for (const existing of [true, false]) {
		const admission = Promise.withResolvers<void>();
		locks(admission.promise);
		const f = fixture();
		const submitted: Submit = {
			workspaceId: "project",
			conversationId: "conversation",
			requestId: "normal",
			text: prompt,
		};
		const key = "project.conversation";
		if (existing) f.local.write(`draft.${key}`, prompt);
		const originalRevision = f.local.valueSnapshot(`draft.${key}`)?.revision ?? null;
		const captured = { ...submitted };
		const run = submitRequest(f.client, f.local, captured, new AbortController().signal);
		assert.deepEqual(f.calls, []);
		f.local.write(`draft.${key}`, "later edit");
		f.local.write(`draft.${key}`, prompt);
		const laterDraft = f.local.valueSnapshot(`draft.${key}`);
		assert.notEqual(laterDraft?.revision, originalRevision);
		captured.text = "caller mutation";
		captured.requestId = "caller request";
		admission.resolve();
		const receipt = await run;
		assert.deepEqual(f.local.pending(key), submitted);
		assert.equal(f.local.storedPending(key)?.draftRevision, originalRevision);
		assert.equal(reconcileReceipt(f.local, key, prompt, submitted, receipt), prompt);
		assert.deepEqual(f.local.valueSnapshot(`draft.${key}`), laterDraft);

		const reopened = new LocalState("store", f.storage);
		const retryAdmission = Promise.withResolvers<void>();
		locks(retryAdmission.promise);
		const retry = submitRequest(f.client, reopened, submitted, new AbortController().signal);
		reopened.write(`draft.${key}`, "retry-time edit");
		reopened.write(`draft.${key}`, prompt);
		const retryDraft = reopened.valueSnapshot(`draft.${key}`);
		retryAdmission.resolve();
		const retryReceipt = await retry;
		assert.equal(reopened.storedPending(key)?.draftRevision, originalRevision);
		assert.equal(reconcileReceipt(reopened, key, prompt, submitted, retryReceipt), prompt);
		assert.deepEqual(new LocalState("store", f.storage).valueSnapshot(`draft.${key}`), retryDraft);
		assert.deepEqual(
			mutations(f).map((call) => call.params),
			[submitted, submitted],
		);
	}
});

test("a missing conversation result retries only the captured create and source edits never rewrite its Send", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	f.handle((method) => (method === "createConversation" ? Promise.reject(new Error("offline")) : undefined));
	await f.session.sendInitial(input);
	const first = mutations(f)[0];
	assert.ok(first);
	assert.equal(f.session.getSnapshot().notFound, true);
	f.local.write(input.sourceKey, "later project draft");
	const local = new LocalState("store", f.storage);
	const reopened = new CatalogSession(f.client, local);
	await reopened.check();
	assert.equal(mutations(f).length, 1);
	f.handle(undefined);
	await reopened.retry();
	assert.deepEqual(mutations(f)[1], first);
	assert.equal(reopened.getSnapshot().submission?.text, prompt);
	assert.equal(local.read(input.sourceKey), "later project draft");
});

test("a lost accepted submit reply reconciles the exact receipt without another send", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	f.handle((method, params) => {
		if (method !== "submit") return undefined;
		f.respond(method, params);
		return Promise.reject(new Error("lost accepted reply"));
	});
	await f.session.sendInitial(input);
	assert.equal(f.session.getSnapshot().failed, false);
	assert.equal(f.session.getSnapshot().receipt?.state, "accepted");
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
	assert.equal(f.local.read("draft.project.conversation-0"), "");
});

test("wrong creation/current/receipt scope never confirms or clears the original input", async () => {
	for (const mismatch of ["created", "current", "receipt"] as const) {
		locks();
		const f = fixture();
		f.local.write(input.sourceKey, prompt);
		f.handle((method, params) => {
			if (method === "createConversation" && mismatch === "created")
				return Promise.resolve({ ...(f.respond(method, params) as Conversation), workspaceId: "foreign" });
			if (method === "getConversation" && mismatch === "current")
				return Promise.resolve({ ...(f.respond(method, params) as Conversation), conversationId: "foreign" });
			if (method === "submit" && mismatch === "receipt") {
				const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
				if (request.method !== "submit") throw new Error("wrong request");
				return Promise.resolve({ ...accepted(request.params), workspaceId: "foreign" });
			}
			return undefined;
		});
		await f.session.sendInitial(input);
		assert.equal(f.session.getSnapshot().failed, true, mismatch);
		if (mismatch === "receipt") {
			const pending = f.local.pending("project.conversation-0");
			assert.ok(pending);
			assert.equal(f.local.isConfirmed(pending.requestId), false);
			assert.equal(f.local.read("draft.project.conversation-0"), prompt);
		} else {
			assert.equal(
				mutations(f).some((call) => call.method === "submit"),
				false,
			);
			assert.equal(f.local.read(input.sourceKey), prompt);
		}
	}
});

test("cleanup after a durable pending handoff cannot dispatch again, even through explicit catalog retry", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	f.storage.fail = (key, raw) =>
		key.endsWith("value.command.catalog") && JSON.parse(JSON.parse(raw).value).version === 2;
	await f.session.sendInitial(input);
	const captured = f.session.getSnapshot().submission;
	assert.ok(captured);
	assert.ok(f.session.getSnapshot().initialSend);
	assert.equal(
		mutations(f).some((call) => call.method === "submit"),
		false,
	);
	f.storage.fail = () => false;
	await f.session.retry();
	assert.equal(
		mutations(f).some((call) => call.method === "submit"),
		false,
	);
	assert.equal(f.session.getSnapshot().initialSend, null);
	await submitRequest(f.client, f.local, captured, new AbortController().signal);
	assert.equal(mutations(f).filter((call) => call.method === "submit").length, 1);
});

test("wrong-store recovery and a foreign source key are rejected without writes or dispatch", async () => {
	locks();
	const f = fixture();
	f.handle((method) => (method === "createConversation" ? Promise.reject(new Error("offline")) : undefined));
	await f.session.sendInitial(input);
	const raw = f.storage.getItem("hipi.work.local.v1.store.value.command.catalog");
	assert.ok(raw);
	f.storage.setItem("hipi.work.local.v1.other.value.command.catalog", raw);
	const foreign = new CatalogSession(f.client, new LocalState("other", f.storage));
	const before = f.calls.length;
	await foreign.sendInitial(input);
	assert.equal(f.calls.length, before);
	assert.equal(foreign.getSnapshot().failed, true);
	const empty = fixture();
	await empty.session.sendInitial({ ...input, sourceKey: "task-draft.foreign" });
	assert.equal(empty.session.getSnapshot().failed, true);
	assert.equal(empty.local.read("command.catalog"), null);
	assert.deepEqual(empty.calls, []);
});

test("maximum escaped input fits durable initial ownership without truncation", async () => {
	locks();
	const f = fixture();
	const text = "\u0000".repeat(LIMITS.text);
	f.local.write(globalInput.sourceKey, text);
	await f.session.sendInitial({ ...globalInput, text });
	assert.equal(f.session.getSnapshot().failed, false);
	assert.equal(f.session.getSnapshot().submission?.text, text);
	assert.equal(f.session.getSnapshot().receipt?.state, "accepted");
});

test("a saved target must still match its exact creation receipt before recovery can admit a submission", async () => {
	locks();
	const f = fixture();
	f.local.write(input.sourceKey, prompt);
	f.storage.fail = (key) => key.includes(".pending.");
	await f.session.sendInitial(input);
	const raw = f.local.read("command.catalog");
	assert.ok(raw);
	const record = JSON.parse(raw);
	assert.equal(record.initialSend.conversationId, "conversation-0");
	record.initialSend.conversationId = "foreign-conversation";
	f.storage.fail = () => false;
	f.local.write("command.catalog", JSON.stringify(record));
	f.conversations.set("foreign-conversation", {
		workspaceId: "project",
		conversationId: "foreign-conversation",
		title: input.title,
		revision: 1,
		createdAt: 10,
		archivedAt: null,
	});
	const local = new LocalState("store", f.storage);
	const reopened = new CatalogSession(f.client, local);
	await reopened.check();
	await reopened.retry();
	assert.equal(reopened.getSnapshot().failed, true);
	assert.equal(reopened.getSnapshot().submission, null);
	assert.equal(local.pending("project.foreign-conversation"), null);
	assert.equal(
		mutations(f).some((call) => call.method === "submit"),
		false,
	);
	assert.equal(local.read(input.sourceKey), prompt);
});
