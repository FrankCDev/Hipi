import assert from "node:assert/strict";
import {
	type AppClient,
	type Conversation,
	LIMITS,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { afterEach, test, vi } from "vitest";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import type { CatalogCommand } from "../src/features/workbench/command-recovery.ts";
import type { BrowserStorage } from "../src/features/workbench/local-persistence.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

const sourceKey = "task-draft.workspace";
const targetKey = "draft.workspace.conversation";
const prompt = "整理项目背景，先准备执行计划。";
const created: Conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "Prepared task",
	revision: 1,
	createdAt: 100,
	archivedAt: null,
};
const create: CatalogCommand = {
	version: PROTOCOL_VERSION,
	method: "createConversation",
	params: {
		workspaceId: "workspace",
		requestId: "request",
		title: created.title,
		model: { provider: "fake", modelId: "test" },
	},
};
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
	let queue = Promise.resolve();
	vi.stubGlobal("navigator", {
		locks: {
			request: (_name: string, work: () => void) => {
				const next = queue.then(work);
				queue = next.then(
					() => undefined,
					() => undefined,
				);
				return next;
			},
		},
	});
}
function fixture(storage = new MemoryStorage(), storeId = "store", leaseActive = () => true) {
	const local = new LocalState(storeId, storage, leaseActive);
	const calls: { method: Method; params: unknown; signal?: AbortSignal }[] = [];
	let handle: (method: Method, params: unknown) => Promise<unknown> = async (method) => {
		if (method === "getConversationCommandResult") return { method: "createConversation", result: created };
		if (method === "getConversation" || method === "createConversation") return created;
		throw new Error(`Unexpected runtime action: ${method}`);
	};
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) => {
			parseRequest({ version: PROTOCOL_VERSION, method, params });
			calls.push({ method, params, signal });
			assert.notEqual(method, "submit", "Preparing and recovering never submits a task");
			return parseResult(method, await handle(method, params));
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	return {
		local,
		storage,
		client,
		calls,
		session: new CatalogSession(client, local),
		handle(next: typeof handle) {
			handle = next;
		},
	};
}
afterEach(() => vi.unstubAllGlobals());

test("bounded project drafts survive cancel/reopen/reload and are isolated by store and project", async () => {
	locks();
	const f = fixture();
	assert.equal(f.local.hasUnsavedWork(), false);
	assert.equal(f.local.write(sourceKey, prompt), true);
	f.local.write("task-draft.other", "another project");
	assert.equal(f.local.hasUnsavedWork(), true);
	assert.equal(f.local.write(sourceKey, "x".repeat(LIMITS.text + 1)), false);
	assert.equal(f.local.write("task-draft.bad.scope", "invalid"), false);
	f.session.dispose();
	const reopened = fixture(f.storage);
	assert.equal(reopened.local.read(sourceKey), prompt);
	assert.equal(reopened.local.read("task-draft.other"), "another project");
	assert.equal(reopened.session.getSnapshot().pending, null);
	await reopened.session.check();
	assert.deepEqual([...f.calls, ...reopened.calls], []);
	assert.equal(fixture(f.storage, "other-store").local.read(sourceKey), null);
});

test("explicit create persists immutable command and prompt before dispatch and preserves later source edits", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	const started = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<Conversation>();
	f.handle(async (method) => {
		if (method === "createConversation") {
			const saved = JSON.parse(new LocalState("store", f.storage).read("command.catalog") ?? "null");
			assert.deepEqual(saved.request, create);
			assert.equal(saved.preparedTask.text, prompt);
			started.resolve();
			return reply.promise;
		}
		return created;
	});
	const command = structuredClone(create);
	const options = { preparedDraft: prompt };
	const run = f.session.execute(command, options);
	command.params.title = "changed by caller";
	options.preparedDraft = "changed by caller";
	await started.promise;
	f.local.write(sourceKey, "new draft");
	f.local.write(sourceKey, prompt); // An edit away and back is still a new draft.
	reply.resolve(created);
	await run;
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["createConversation", "getConversation"],
	);
	assert.equal(f.local.read(targetKey), prompt);
	assert.equal(f.local.read(sourceKey), prompt);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.session.getSnapshot().preparedTask, null);
	const restored = new LocalState("store", f.storage);
	assert.equal(restored.read(targetKey), prompt);
	assert.equal(restored.read(sourceKey), prompt);
});

test("reload before reply restores exact ownership; an old late reply cannot transfer or clear again", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	const started = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<Conversation>();
	f.handle(async () => {
		started.resolve();
		return reply.promise;
	});
	const run = f.session.execute(create, { preparedDraft: prompt });
	await started.promise;
	f.session.dispose();
	f.local.deactivate();
	await run;
	const recovered = fixture(f.storage);
	assert.equal(recovered.session.getSnapshot().preparedTask?.text, prompt);
	await recovered.session.check();
	assert.deepEqual(
		recovered.calls.map((call) => call.method),
		["getConversationCommandResult", "getConversation"],
	);
	assert.deepEqual(recovered.calls[0]?.params, { workspaceId: "workspace", requestId: "request" });
	assert.equal(recovered.local.read(sourceKey), "");
	assert.equal(recovered.local.read(targetKey), prompt);
	recovered.local.write(targetKey, "edited after recovery");
	reply.resolve(created);
	await Promise.resolve();
	await Promise.resolve();
	await recovered.session.check();
	assert.equal(new LocalState("store", f.storage).read(targetKey), "edited after recovery");
	assert.equal(recovered.calls.length, 2);
});

test("unknown create is checked by exact receipt after reload without replaying or losing prepared input", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	f.handle(async (method) => {
		if (method === "createConversation") throw new Error("lost reply");
		return null;
	});
	await f.session.execute(create, { preparedDraft: prompt });
	assert.equal(f.session.getSnapshot().notFound, true);
	assert.equal(f.local.read(targetKey), null);
	const recovered = fixture(f.storage);
	await recovered.session.discardPreparedTask(); // Unknown creation cannot be silently discarded.
	assert.deepEqual(recovered.calls, []);
	await recovered.session.check();
	assert.equal(recovered.local.read(targetKey), prompt);
	assert.equal(recovered.local.read(sourceKey), "");
	assert.deepEqual(
		recovered.calls.map((call) => call.method),
		["getConversationCommandResult", "getConversation"],
	);
});

test("storage denial or missing browser admission never dispatches create", async () => {
	for (const failure of ["write", "locks"] as const) {
		locks();
		const f = fixture();
		f.local.write(sourceKey, prompt);
		if (failure === "write") f.storage.fail = (key) => key.endsWith("value.command.catalog");
		else vi.stubGlobal("navigator", {});
		await f.session.execute(create, { preparedDraft: prompt });
		assert.deepEqual(f.calls, []);
		assert.equal(f.session.getSnapshot().failed, true);
		assert.equal(f.local.read(sourceKey), prompt);
		assert.equal(f.local.read("command.catalog"), null);
		assert.equal(new LocalState("store", f.storage).read(sourceKey), prompt);
	}
});

test("occupied destination keeps captured prompt and target recoverable until an explicit safe reconciliation", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	f.local.write(targetKey, prompt); // Identical existing text is still independently authored.
	await f.session.execute(create, { preparedDraft: prompt });
	assert.equal(f.session.getSnapshot().handoffConflict, true);
	assert.equal(f.session.getSnapshot().preparedTask?.conversationId, created.conversationId);
	assert.equal(f.local.read(sourceKey), prompt);
	const recovered = fixture(f.storage);
	await recovered.session.check();
	assert.equal(recovered.session.getSnapshot().handoffConflict, true);
	assert.equal(recovered.local.read(targetKey), prompt);
	recovered.local.write(targetKey, "");
	await recovered.session.check();
	assert.equal(recovered.session.getSnapshot().pending, null);
	assert.equal(recovered.local.read(targetKey), prompt);
	assert.equal(recovered.local.read(sourceKey), "");
	assert.equal(
		recovered.calls.some((call) => call.method === "createConversation"),
		false,
	);
});

test("explicit keep-existing choice verifies the original target and preserves both drafts", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	f.local.write(targetKey, "destination edit");
	await f.session.execute(create, { preparedDraft: prompt });
	f.local.write(sourceKey, "source edit");
	f.handle(async () => {
		throw new Error("offline");
	});
	await f.session.discardPreparedTask();
	assert.ok(f.session.getSnapshot().pending);
	assert.equal(f.session.getSnapshot().preparedTask?.text, prompt);
	const recovered = fixture(f.storage);
	await recovered.session.discardPreparedTask();
	assert.equal(recovered.session.getSnapshot().pending, null);
	assert.equal(recovered.session.getSnapshot().preparedTask, null);
	assert.deepEqual(recovered.session.getSnapshot().result, created);
	assert.equal(recovered.local.read(sourceKey), "source edit");
	assert.equal(recovered.local.read(targetKey), "destination edit");
	assert.deepEqual(
		recovered.calls.map((call) => call.method),
		["getConversationCommandResult", "getConversation"],
	);
});

test("each interrupted handoff write retains recovery; later destination edits survive retry and restart", async () => {
	for (const stage of ["target", "destination", "source", "clear"] as const) {
		locks();
		const f = fixture();
		f.local.write(sourceKey, prompt);
		f.storage.fail = (key, raw) => {
			const entry = JSON.parse(raw);
			if (stage === "destination") return key.endsWith(`value.${targetKey}`);
			if (stage === "source") return key.endsWith(`value.${sourceKey}`) && entry.value === "";
			if (!key.endsWith("value.command.catalog")) return false;
			const record = JSON.parse(entry.value);
			return stage === "target" ? record.preparedTask?.conversationId !== null : record.request === null;
		};
		await f.session.execute(create, { preparedDraft: prompt });
		assert.equal(f.session.getSnapshot().failed, true, stage);
		assert.ok(f.session.getSnapshot().pending, stage);
		assert.equal(f.session.getSnapshot().preparedTask?.text, prompt, stage);
		f.storage.fail = () => false;
		const recovered = fixture(f.storage);
		if (stage === "source" || stage === "clear") recovered.local.write(targetKey, "later destination edit");
		await recovered.session.check();
		assert.equal(recovered.session.getSnapshot().pending, null, stage);
		assert.equal(recovered.local.read(sourceKey), "", stage);
		assert.equal(
			recovered.local.read(targetKey),
			stage === "source" || stage === "clear" ? "later destination edit" : prompt,
			stage,
		);
		await recovered.session.check();
		assert.equal(recovered.calls.length, 2, stage);
	}
});

test("wrong receipt scope, method, current target and changed saved request never transfer prepared input", async () => {
	for (const mismatch of ["scope", "method", "current", "request"] as const) {
		locks();
		const f = fixture();
		f.local.write(sourceKey, prompt);
		f.handle(async (method) => {
			if (method === "createConversation") throw new Error("lost");
			if (method === "getConversationCommandResult") {
				if (mismatch === "request") {
					const raw = f.local.read("command.catalog");
					assert.ok(raw);
					const record = JSON.parse(raw);
					record.request.params.requestId = "foreign-request";
					f.local.write("command.catalog", JSON.stringify(record));
				}
				return {
					method: mismatch === "method" ? "archiveConversation" : "createConversation",
					result: { ...created, workspaceId: mismatch === "scope" ? "foreign" : "workspace" },
				};
			}
			return { ...created, conversationId: mismatch === "current" ? "foreign" : "conversation" };
		});
		await f.session.execute(create, { preparedDraft: prompt });
		assert.equal(f.session.getSnapshot().failed, true, mismatch);
		assert.equal(f.local.read(targetKey), null, mismatch);
		assert.equal(f.local.read(sourceKey), prompt, mismatch);
		assert.ok(f.local.read("command.catalog"), mismatch);
	}
});

test("malformed prepared recovery is incompatible and stays untouched rather than replaying without its prompt", async () => {
	locks();
	const preparedTask = {
		workspaceId: "workspace",
		requestId: "request",
		text: prompt,
		sourceRevision: null,
		conversationId: null,
	};
	for (const invalid of [
		null,
		{},
		{ ...preparedTask, requestId: "wrong" },
		{ ...preparedTask, workspaceId: "wrong" },
		{ ...preparedTask, text: "x".repeat(LIMITS.text + 1) },
		{ ...preparedTask, text: undefined },
		{ ...preparedTask, sourceRevision: undefined },
		{ ...preparedTask, conversationId: undefined },
	]) {
		const storage = new MemoryStorage();
		const local = new LocalState("store", storage);
		const raw = JSON.stringify({ version: 2, request: create, preparedTask: invalid });
		assert.equal(local.write("command.catalog", raw), true);
		const f = fixture(storage);
		await f.session.check();
		await f.session.retry();
		await f.session.discardPreparedTask();
		await f.session.execute(create, { preparedDraft: prompt });
		assert.equal(f.session.getSnapshot().incompatible, true);
		assert.deepEqual(f.calls, []);
		assert.equal(f.local.read("command.catalog"), raw);
	}
});

test("simultaneous catalog admissions preserve one immutable owner and never dispatch a competing create", async () => {
	locks();
	const storage = new MemoryStorage();
	const first = fixture(storage);
	const second = fixture(storage);
	first.local.write(sourceKey, prompt);
	first.handle(async () => {
		throw new Error("offline");
	});
	await Promise.all([
		first.session.execute(create, { preparedDraft: prompt }),
		second.session.execute({ ...create, params: { ...create.params, requestId: "other" } }, { preparedDraft: "other" }),
	]);
	assert.equal(first.calls.filter((call) => call.method === "createConversation").length, 1);
	assert.deepEqual(second.calls, []);
	assert.equal(fixture(storage).session.getSnapshot().preparedTask?.text, prompt);
});

test("released writer lease or cancelled queued admission cannot persist ownership or dispatch create", async () => {
	for (const cancel of ["lease", "session"] as const) {
		locks();
		let active = true;
		const f = fixture(new MemoryStorage(), "store", () => active);
		f.local.write(sourceKey, prompt);
		const run = f.session.execute(create, { preparedDraft: prompt });
		if (cancel === "lease") active = false;
		else f.session.dispose();
		await run;
		assert.deepEqual(f.calls, []);
		assert.equal(new LocalState("store", f.storage).read(sourceKey), prompt);
		assert.equal(new LocalState("store", f.storage).read("command.catalog"), null);
	}
});

test("a full escaped prompt is recoverable and never truncated by nested JSON persistence", async () => {
	locks();
	const f = fixture();
	const text = "\u0000".repeat(LIMITS.text);
	assert.equal(f.local.write(sourceKey, text), true);
	await f.session.execute(create, { preparedDraft: text });
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(new LocalState("store", f.storage).read(targetKey), text);
});

test("a later emptied destination is not repopulated after transfer when recovery cleanup failed", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	f.storage.fail = (key, raw) =>
		key.endsWith("value.command.catalog") && JSON.parse(JSON.parse(raw).value).request === null;
	await f.session.execute(create, { preparedDraft: prompt });
	assert.equal(f.local.read(targetKey), prompt);
	assert.ok(f.session.getSnapshot().pending);
	f.storage.fail = () => false;
	f.local.write(targetKey, "");
	f.local.write(sourceKey, prompt); // A new task with identical text also belongs to the user.
	const recovered = fixture(f.storage);
	await recovered.session.check();
	assert.equal(recovered.session.getSnapshot().pending, null);
	assert.equal(recovered.local.read(targetKey), "");
	assert.equal(recovered.local.read(sourceKey), prompt);
});

test("wrong-store recovery envelopes cannot be admitted or used to hand off into the current store", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	f.handle(async () => {
		throw new Error("offline");
	});
	await f.session.execute(create, { preparedDraft: prompt });
	const saved = f.storage.getItem("hipi.work.local.v1.store.value.command.catalog");
	assert.ok(saved);
	f.storage.setItem("hipi.work.local.v1.other-store.value.command.catalog", saved);
	const foreign = fixture(f.storage, "other-store");
	assert.equal(foreign.session.getSnapshot().pending, null);
	await foreign.session.execute(create, { preparedDraft: "foreign" });
	assert.equal(foreign.session.getSnapshot().failed, true);
	assert.deepEqual(foreign.calls, []);
	assert.equal(foreign.local.read(targetKey), null);
	assert.equal(new LocalState("store", f.storage).read(sourceKey), prompt);
});

test("a stale session cannot retry a command displaced in durable recovery", async () => {
	locks();
	const f = fixture();
	f.local.write(sourceKey, prompt);
	f.handle(async (method) => {
		if (method === "createConversation") throw new Error("offline");
		return null;
	});
	await f.session.execute(create, { preparedDraft: prompt });
	assert.equal(f.session.getSnapshot().notFound, true);
	const raw = f.local.read("command.catalog");
	assert.ok(raw);
	const record = JSON.parse(raw);
	record.request.params.requestId = "other-request";
	record.preparedTask.requestId = "other-request";
	new LocalState("store", f.storage).write("command.catalog", JSON.stringify(record));
	await f.session.retry();
	assert.equal(f.calls.filter((call) => call.method === "createConversation").length, 1);
	assert.equal(f.session.getSnapshot().failed, true);
	assert.equal(new LocalState("store", f.storage).read("command.catalog"), JSON.stringify(record));
});
