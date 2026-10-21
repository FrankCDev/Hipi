import assert from "node:assert/strict";
import {
	type AppClient,
	AppError,
	type ConversationPresentation,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { afterEach, test, vi } from "vitest";
import type { BrowserStorage } from "../../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import {
	type PinLifecycle,
	PresentationSession,
} from "../../../src/features/workbench/sidebar/presentation-session.ts";

const input: Params<"setConversationPinned"> = {
	workspaceId: "workspace",
	conversationId: "conversation",
	requestId: "pin-request",
	expectedPresentationRevision: 0,
	pinned: true,
};
const result: ConversationPresentation = {
	workspaceId: input.workspaceId,
	conversationId: input.conversationId,
	revision: 1,
	pinned: true,
};
class MemoryStorage implements BrowserStorage {
	values = new Map<string, string>();
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
		this.values.set(key, value);
	}
}
function fixture(local = new LocalState()) {
	const calls: { method: Method; params: unknown; signal?: AbortSignal }[] = [];
	let handler: (method: Method, params: unknown) => Promise<unknown> = async (method) => {
		if (method === "getPresentationCommandResult") return null;
		if (method === "getConversationPresentation") return result;
		throw new Error("Lost reply");
	};
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) => {
			parseRequest({ version: PROTOCOL_VERSION, method, params });
			calls.push({ method, params, signal });
			return parseResult(method, await handler(method, params));
		},
		observe: async () => {
			throw new Error("Pinning never observes execution");
		},
	};
	const session = new PresentationSession(client, local);
	const events: PinLifecycle[] = [];
	session.subscribePinLifecycle((event) => events.push(event));
	return {
		calls,
		client,
		events,
		local,
		session,
		handle: (next: typeof handler) => {
			handler = next;
		},
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("pin receipt recovery reads current truth without replay, selection, draft, or execution writes", async () => {
	const f = fixture();
	f.local.write("draft.workspace.conversation", "Keep draft");
	f.local.write("workspace", "other");
	f.handle(async (method) => {
		if (method === "setConversationPinned") throw new Error("Lost response");
		if (method === "getPresentationCommandResult") return { method: "setConversationPinned", params: input, result };
		return { ...result, revision: 4, pinned: false };
	});
	await f.session.execute(input);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["setConversationPinned", "getPresentationCommandResult", "getConversationPresentation"],
	);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.deepEqual(f.session.getSnapshot().result, { ...result, revision: 4, pinned: false });
	assert.equal(f.local.read("draft.workspace.conversation"), "Keep draft");
	assert.equal(f.local.read("workspace"), "other");
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
		{ phase: "confirmed", input, result: { ...result, revision: 4, pinned: false } },
	]);
	f.session.dispose();
});

test("unknown pin persists across a fresh LocalState, and explicit retry uses the immutable request only", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const f = fixture(new LocalState("store", storage));
	const mutable = { ...input };
	await f.session.execute(mutable);
	mutable.pinned = false;
	assert.equal(f.session.getSnapshot().notFound, true);
	f.session.dispose();
	const restored = new PresentationSession(f.client, new LocalState("store", storage));
	const recoveredEvents: PinLifecycle[] = [];
	restored.subscribePinLifecycle((event) => recoveredEvents.push(event));
	assert.equal(f.calls.length, 2, "reloading alone never dispatches");
	await restored.check();
	assert.equal(f.calls.filter((call) => call.method === "setConversationPinned").length, 1);
	await restored.retry();
	assert.deepEqual(
		f.calls.filter((call) => call.method === "setConversationPinned").map((call) => call.params),
		[input, input],
	);
	assert.equal(new LocalState("store", storage).hasUnsavedWork(), true);
	assert.equal(new PresentationSession(f.client, new LocalState("foreign", storage)).getSnapshot().pending, null);
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
	]);
	assert.deepEqual(recoveredEvents, [], "checking and retrying unknown recovery never initiate a new local action");
	restored.dispose();
});

test("successful pin then unpin survives local restart without changing canonical conversation identity", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const f = fixture(new LocalState("store", storage));
	let current = { ...result, revision: 0, pinned: false };
	f.handle(async (method, params) => {
		if (method === "setConversationPinned") {
			assert.ok(params && typeof params === "object" && "pinned" in params);
			current = { ...current, pinned: Boolean(params.pinned), revision: current.revision + 1 };
		}
		return current;
	});
	await f.session.execute(input);
	assert.equal(f.session.getSnapshot().result?.pinned, true);
	f.session.dispose();
	const restored = new PresentationSession(f.client, new LocalState("store", storage));
	assert.equal(restored.getSnapshot().pending, null);
	await restored.execute({ ...input, requestId: "unpin", expectedPresentationRevision: 1, pinned: false });
	assert.deepEqual(restored.getSnapshot().result, { ...result, revision: 2, pinned: false });
	assert.equal(new LocalState("store", storage).hasUnsavedWork(), false);
	restored.dispose();
});

test.each(["params", "scope", "revision"] as const)(
	"mismatched %s receipt cannot clear the exact pending record",
	async (mismatch) => {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "setConversationPinned") throw new Error("Lost reply");
			if (method === "getPresentationCommandResult")
				return {
					method: "setConversationPinned",
					params: mismatch === "params" ? { ...input, pinned: false } : input,
					result:
						mismatch === "scope"
							? { ...result, workspaceId: "other" }
							: mismatch === "revision"
								? { ...result, revision: 99 }
								: result,
				};
			return result;
		});
		await f.session.execute(input);
		assert.ok(f.session.getSnapshot().pending);
		assert.equal(f.session.getSnapshot().failed, true);
		assert.deepEqual(
			f.events.map(({ phase }) => phase),
			["initiated", "admitted"],
		);
		f.session.dispose();
	},
);

test.each(["IDEMPOTENCY_CONFLICT", "NOT_FOUND", "CONVERSATION_ARCHIVED"] as const)(
	"definitive %s rejection releases admission only after exact receipt absence",
	async (code) => {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "setConversationPinned") throw new AppError(code);
			assert.equal(method, "getPresentationCommandResult");
			return null;
		});
		await f.session.execute(input);
		assert.equal(f.session.getSnapshot().pending, null);
		assert.equal(f.session.getSnapshot().rejected, true);
		assert.deepEqual(f.events, [
			{ phase: "initiated", input },
			{ phase: "admitted", input },
			{ phase: "retired", input },
		]);
		f.session.dispose();
	},
);

test("incompatible recovery remains untouched and never dispatches a mutation", async () => {
	const local = new LocalState();
	const raw = JSON.stringify({ version: 1, request: input });
	local.write("command.presentation", raw);
	const f = fixture(local);
	await f.session.execute(input);
	await f.session.retry();
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.events, []);
	assert.equal(local.read("command.presentation"), raw);
	f.session.dispose();
});

test("failed durable pin admission cannot dispatch or replace a draft", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	local.write("draft.workspace.conversation", "Still editable");
	storage.setItem = () => {
		throw new Error("Storage unavailable");
	};
	const f = fixture(local);
	await f.session.execute(input);
	assert.deepEqual(f.calls, []);
	assert.equal(f.session.getSnapshot().failed, true);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(local.read("draft.workspace.conversation"), "Still editable");
	assert.equal(new LocalState("store", storage).read("command.presentation"), null);
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "retired", input },
	]);
	f.session.dispose();
});

test("disposed or timed-out operations retain recovery and ignore late success", async () => {
	vi.useFakeTimers();
	for (const dispose of [true, false]) {
		const f = fixture();
		const reactivated: PinLifecycle[] = [];
		const delayed = Promise.withResolvers<unknown>();
		f.handle(() => delayed.promise);
		const running = f.session.execute(input);
		await Promise.resolve();
		await Promise.resolve();
		if (dispose) {
			f.session.dispose();
			f.session.activate();
			f.session.subscribePinLifecycle((event) => reactivated.push(event));
		} else await vi.advanceTimersByTimeAsync(15000);
		await running;
		delayed.resolve(result);
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(f.session.getSnapshot().pending);
		assert.equal(f.session.getSnapshot().result, null);
		assert.equal(f.session.getSnapshot().busy, false);
		assert.equal(f.calls[0]?.signal?.aborted, true);
		assert.deepEqual(reactivated, []);
		assert.deepEqual(
			f.events.map(({ phase }) => phase),
			["initiated", "admitted"],
		);
		f.session.dispose();
	}
});

test("two owners share the durable admission slot and a queued action snapshots its original input", async () => {
	const local = new LocalState();
	const f = fixture(local);
	const gate = Promise.withResolvers<void>();
	const admission = local.withAdmission.bind(local);
	local.withAdmission = async (key, action) => {
		await gate.promise;
		return admission(key, action);
	};
	const second = new PresentationSession(f.client, local);
	const mutable = { ...input };
	const first = f.session.execute(mutable);
	assert.deepEqual(f.events, [{ phase: "initiated", input }], "initiation is synchronous before lock admission");
	assert.equal(f.local.read("command.presentation"), null);
	assert.equal(f.calls.length, 0);
	mutable.pinned = false;
	const other = second.execute({ ...input, requestId: "other" });
	gate.resolve();
	await Promise.all([first, other]);
	assert.deepEqual(
		f.calls.filter((call) => call.method === "setConversationPinned").map((call) => call.params),
		[input],
	);
	assert.equal(second.getSnapshot().pending?.params.requestId, input.requestId);
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
	]);
	f.session.dispose();
	second.dispose();
});

const orderInput: Params<"reorderPinnedConversation"> = {
	requestId: "order-request",
	moved: { workspaceId: "workspace", conversationId: "conversation" },
	before: { workspaceId: "other", conversationId: "anchor" },
	expectedOrderGeneration: 7,
};
const orderPage = { items: [], previousCursor: null, nextCursor: null, orderGeneration: 12, nextPinnedScope: null };

test.each([false, true])("order recovery reconciles current list after historical receipt (lost=%s)", async (lost) => {
	const f = fixture();
	f.local.write("workspace", "unchanged");
	f.local.write("draft.workspace.conversation", "Unsent");
	f.handle(async (method) => {
		if (method === "reorderPinnedConversation") {
			if (lost) throw new Error("Lost response");
			return { orderGeneration: 8 };
		}
		if (method === "getPresentationCommandResult")
			return { method: "reorderPinnedConversation", params: orderInput, result: { orderGeneration: 8 } };
		assert.equal(method, "listPinnedConversations");
		return orderPage;
	});
	await f.session.reorder(orderInput);
	assert.deepEqual(
		f.calls.map(({ method }) => method),
		lost
			? ["reorderPinnedConversation", "getPresentationCommandResult", "listPinnedConversations"]
			: ["reorderPinnedConversation", "listPinnedConversations"],
	);
	assert.deepEqual(f.session.getSnapshot().orderResult, orderPage);
	assert.equal(f.session.getSnapshot().result, null);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.local.read("workspace"), "unchanged");
	assert.equal(f.local.read("draft.workspace.conversation"), "Unsent");
	assert.deepEqual(f.events, [], "ordering cannot acquire pin selection ownership");
	f.session.dispose();
});

test("unknown order restores immutable scopes and generation, and retry never rebases", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const f = fixture(new LocalState("store", storage));
	const mutable = structuredClone(orderInput);
	await f.session.reorder(mutable);
	mutable.moved.workspaceId = "changed";
	mutable.before = null;
	mutable.expectedOrderGeneration = 99;
	f.session.dispose();
	const restored = new PresentationSession(f.client, new LocalState("store", storage));
	assert.equal(restored.getSnapshot().order, true);
	assert.equal(f.calls.length, 2, "restoration does not dispatch");
	await restored.check();
	await restored.retry();
	assert.deepEqual(
		f.calls.filter(({ method }) => method === "reorderPinnedConversation").map(({ params }) => params),
		[orderInput, orderInput],
	);
	assert.equal(restored.getSnapshot().pending?.method, "reorderPinnedConversation");
	assert.equal(restored.getSnapshot().notFound, true);
	restored.dispose();
});

test("a known order receipt with failed current-list read retains ownership until a later read succeeds", async () => {
	const f = fixture();
	let available = false;
	f.handle(async (method) => {
		if (method === "reorderPinnedConversation") return { orderGeneration: 8 };
		if (method === "getPresentationCommandResult")
			return { method: "reorderPinnedConversation", params: orderInput, result: { orderGeneration: 8 } };
		if (!available) throw new Error("Read unavailable");
		return orderPage;
	});
	await f.session.reorder(orderInput);
	assert.ok(f.session.getSnapshot().pending);
	assert.equal(f.session.getSnapshot().orderResult, null);
	available = true;
	await f.session.check();
	assert.equal(f.session.getSnapshot().pending, null);
	assert.deepEqual(f.session.getSnapshot().orderResult, orderPage);
	assert.equal(f.calls.filter(({ method }) => method === "reorderPinnedConversation").length, 1);
	f.session.dispose();
});

test.each(["anchor", "generation", "method"] as const)(
	"mismatched order %s cannot release the saved request",
	async (mismatch) => {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "reorderPinnedConversation") throw new Error("Unknown");
			if (method === "getPresentationCommandResult")
				return mismatch === "method"
					? { method: "setConversationPinned", params: { ...input, requestId: orderInput.requestId }, result }
					: {
							method: "reorderPinnedConversation",
							params: mismatch === "anchor" ? { ...orderInput, before: null } : orderInput,
							result: { orderGeneration: mismatch === "generation" ? 99 : 8 },
						};
			return orderPage;
		});
		await f.session.reorder(orderInput);
		assert.ok(f.session.getSnapshot().pending);
		assert.equal(f.session.getSnapshot().failed, true);
		assert.equal(f.session.getSnapshot().orderResult, null);
		f.session.dispose();
	},
);

test.each(["IDEMPOTENCY_CONFLICT", "CONVERSATION_ARCHIVED", "INVALID_REQUEST"] as const)(
	"definitive order %s releases only after absent receipt and never silently retries",
	async (code) => {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "reorderPinnedConversation") throw new AppError(code);
			assert.equal(method, "getPresentationCommandResult");
			return null;
		});
		await f.session.reorder(orderInput);
		assert.equal(f.session.getSnapshot().pending, null);
		assert.equal(f.session.getSnapshot().rejected, true);
		await f.session.retry();
		assert.equal(f.calls.filter(({ method }) => method === "reorderPinnedConversation").length, 1);
		f.session.dispose();
	},
);

test.each(["pin", "order"] as const)(
	"an unresolved %s blocks the other presentation mutation, not unrelated local work",
	async (first) => {
		const f = fixture();
		if (first === "pin") {
			await f.session.execute(input);
			await f.session.reorder(orderInput);
		} else {
			await f.session.reorder(orderInput);
			await f.session.execute(input);
		}
		assert.deepEqual(
			f.calls.map(({ method }) => method),
			[first === "pin" ? "setConversationPinned" : "reorderPinnedConversation", "getPresentationCommandResult"],
		);
		assert.equal(f.local.write("draft.other.chat", "Still editable"), true);
		assert.equal(f.local.write("workspace", "other"), true);
		f.session.dispose();
	},
);

test("no-op order receipt keeps its generation but still refreshes current placement", async () => {
	const f = fixture();
	f.handle(async (method) => (method === "reorderPinnedConversation" ? { orderGeneration: 7 } : orderPage));
	await f.session.reorder(orderInput);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.deepEqual(f.session.getSnapshot().orderResult, orderPage);
	f.session.dispose();
});

test("a second window retains authoritative unknown recovery when its startup cache is stale and lookup fails", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const first = fixture(new LocalState("store", storage));
	const second = fixture(new LocalState("store", storage));
	await first.session.reorder(orderInput);
	assert.equal(second.local.read("command.presentation"), null);
	second.handle(async () => {
		throw new Error("Receipt service unavailable");
	});
	await second.session.check();
	assert.equal(second.session.getSnapshot().pending?.params.requestId, orderInput.requestId);
	assert.equal(second.session.getSnapshot().failed, true);
	assert.equal(second.session.getSnapshot().busy, false);
	first.session.dispose();
	second.session.dispose();
});

test("pin admission and confirmation events follow durability and the current presentation read", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const f = fixture(new LocalState("store", storage));
	const readStarted = Promise.withResolvers<void>();
	const current = Promise.withResolvers<ConversationPresentation>();
	const durableAtAdmission: string[] = [];
	f.session.subscribePinLifecycle((event) => {
		if (event.phase === "admitted")
			durableAtAdmission.push(new LocalState("store", storage).read("command.presentation") ?? "");
	});
	f.handle(async (method) => {
		if (method === "setConversationPinned") return result;
		assert.equal(method, "getConversationPresentation");
		readStarted.resolve();
		return current.promise;
	});
	const running = f.session.execute(input);
	await readStarted.promise;
	assert.deepEqual(durableAtAdmission, [
		JSON.stringify({
			version: 2,
			request: { version: PROTOCOL_VERSION, method: "setConversationPinned", params: input },
		}),
	]);
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
	]);
	assert.ok(f.session.getSnapshot().pending);
	assert.equal(f.session.getSnapshot().result, null);
	const reconciled = { ...result, revision: 5, pinned: false };
	current.resolve(reconciled);
	await running;
	assert.deepEqual(f.events.at(-1), { phase: "confirmed", input, result: reconciled });
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(new LocalState("store", storage).hasUnsavedWork(), false);
	f.session.dispose();
});

test("lifecycle envelopes and their input and current result cannot be changed by a subscriber", async () => {
	const f = fixture();
	const mutable = { ...input };
	const reconciled = { ...result, revision: 3 };
	const writes: boolean[] = [];
	const observed: PinLifecycle[] = [];
	f.session.subscribePinLifecycle((event) => {
		writes.push(Reflect.set(event.input, "requestId", "subscriber-request"));
		if (event.phase === "confirmed") writes.push(Reflect.set(event.result, "pinned", false));
		writes.push(Reflect.set(event, "phase", "retired"));
		writes.push(Reflect.set(event, "input", { ...input, conversationId: "subscriber-conversation" }));
	});
	f.session.subscribePinLifecycle((event) => observed.push(event));
	f.handle(async (method) => (method === "setConversationPinned" ? result : reconciled));
	const running = f.session.execute(mutable);
	mutable.requestId = "changed-after-execute";
	mutable.pinned = false;
	await running;
	reconciled.revision = 99;
	assert.ok(
		writes.every((written) => !written),
		"every lifecycle payload is immutable between observers",
	);
	assert.deepEqual(observed, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
		{ phase: "confirmed", input, result: { ...result, revision: 3 } },
	]);
	assert.ok(observed.every((event) => Object.isFrozen(event) && Object.isFrozen(event.input)));
	assert.deepEqual(
		f.calls.filter(({ method }) => method === "setConversationPinned").map(({ params }) => params),
		[input],
	);
	f.session.dispose();
});

test.each(["unavailable", "scope", "revision"] as const)(
	"a %s current presentation read cannot confirm a pin receipt",
	async (failure) => {
		const f = fixture();
		let available = false;
		f.handle(async (method) => {
			if (method === "setConversationPinned") return result;
			if (method === "getPresentationCommandResult") return { method: "setConversationPinned", params: input, result };
			assert.equal(method, "getConversationPresentation");
			if (available) return { ...result, revision: 4, pinned: false };
			if (failure === "unavailable") throw new Error("Current presentation unavailable");
			return failure === "scope" ? { ...result, conversationId: "other" } : { ...result, revision: 0 };
		});
		await f.session.execute(input);
		assert.ok(f.session.getSnapshot().pending);
		assert.equal(f.session.getSnapshot().result, null);
		assert.equal(f.session.getSnapshot().failed, true);
		assert.deepEqual(f.events, [
			{ phase: "initiated", input },
			{ phase: "admitted", input },
		]);
		available = true;
		await f.session.check();
		assert.deepEqual(f.events, [
			{ phase: "initiated", input },
			{ phase: "admitted", input },
			{ phase: "confirmed", input, result: { ...result, revision: 4, pinned: false } },
		]);
		assert.equal(f.calls.filter(({ method }) => method === "setConversationPinned").length, 1);
		f.session.dispose();
	},
);

test("current truth cannot confirm a pin until its exact recovery record is durably released", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const write = storage.setItem.bind(storage);
	const f = fixture(new LocalState("store", storage));
	f.handle(async (method) => {
		if (method === "setConversationPinned") {
			storage.setItem = () => {
				throw new Error("Recovery cleanup unavailable");
			};
			return result;
		}
		if (method === "getPresentationCommandResult") return { method: "setConversationPinned", params: input, result };
		return { ...result, revision: 4, pinned: false };
	});
	await f.session.execute(input);
	assert.equal(f.session.getSnapshot().failed, true);
	assert.ok(f.session.getSnapshot().pending);
	assert.equal(f.session.getSnapshot().result, null);
	assert.equal(new LocalState("store", storage).hasUnsavedWork(), true);
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
	]);
	storage.setItem = write;
	await f.session.check();
	assert.deepEqual(f.events.at(-1), { phase: "confirmed", input, result: { ...result, revision: 4, pinned: false } });
	assert.equal(new LocalState("store", storage).hasUnsavedWork(), false);
	assert.equal(f.calls.filter(({ method }) => method === "setConversationPinned").length, 1);
	f.session.dispose();
});

test("a rejection with an unavailable receipt stays admitted until explicit recovery confirms current truth", async () => {
	const f = fixture();
	let receiptAvailable = false;
	f.handle(async (method) => {
		if (method === "setConversationPinned") throw new AppError("IDEMPOTENCY_CONFLICT");
		if (method === "getPresentationCommandResult") {
			if (!receiptAvailable) throw new Error("Receipt lookup unavailable");
			return { method: "setConversationPinned", params: input, result };
		}
		return { ...result, revision: 3, pinned: false };
	});
	await f.session.execute(input);
	assert.ok(f.session.getSnapshot().pending);
	assert.equal(f.session.getSnapshot().rejected, false);
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
	]);
	receiptAvailable = true;
	await f.session.check();
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
		{ phase: "confirmed", input, result: { ...result, revision: 3, pinned: false } },
	]);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.calls.filter(({ method }) => method === "setConversationPinned").length, 1);
	f.session.dispose();
});

test("failed admission retires only its own input when another window's unknown pin is discovered", async () => {
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
	const storage = new MemoryStorage();
	const first = fixture(new LocalState("store", storage));
	const second = fixture(new LocalState("store", storage));
	await first.session.execute(input);
	const original = first.local.read("command.presentation");
	assert.equal(second.local.read("command.presentation"), null, "each window has an independent startup cache");
	const attempted = { ...input, requestId: "other-request", conversationId: "other-conversation" };
	await second.session.execute(attempted);
	assert.deepEqual(second.calls, []);
	assert.equal(second.session.getSnapshot().pending?.params.requestId, input.requestId);
	assert.equal(second.session.getSnapshot().failed, true);
	assert.equal(new LocalState("store", storage).read("command.presentation"), original);
	assert.deepEqual(second.events, [
		{ phase: "initiated", input: attempted },
		{ phase: "retired", input: attempted },
	]);
	second.handle(async (method) =>
		method === "getPresentationCommandResult"
			? { method: "setConversationPinned", params: input, result }
			: { ...result, revision: 4, pinned: false },
	);
	await second.session.check();
	assert.deepEqual(second.events, [
		{ phase: "initiated", input: attempted },
		{ phase: "retired", input: attempted },
		{ phase: "confirmed", input, result: { ...result, revision: 4, pinned: false } },
	]);
	assert.deepEqual(
		second.calls.map(({ method }) => method),
		["getPresentationCommandResult", "getConversationPresentation"],
	);
	first.session.dispose();
	second.session.dispose();
});

test.each(["check", "retry"] as const)(
	"explicit %s confirms restored pin ownership without new initiation",
	async (action) => {
		vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
		const storage = new MemoryStorage();
		const first = fixture(new LocalState("store", storage));
		await first.session.execute(input);
		first.session.dispose();
		const restored = fixture(new LocalState("store", storage));
		let receiptKnown = false;
		restored.handle(async (method) => {
			if (method === "getPresentationCommandResult")
				return receiptKnown || action === "check" ? { method: "setConversationPinned", params: input, result } : null;
			if (method === "setConversationPinned") {
				receiptKnown = true;
				return result;
			}
			return { ...result, revision: 6, pinned: false };
		});
		assert.deepEqual(restored.events, []);
		await restored.session[action]();
		assert.deepEqual(restored.events, [
			{ phase: "confirmed", input, result: { ...result, revision: 6, pinned: false } },
		]);
		assert.equal(restored.session.getSnapshot().pending, null);
		assert.deepEqual(
			restored.calls.filter(({ method }) => method === "setConversationPinned").map(({ params }) => params),
			action === "retry" ? [input] : [],
		);
		const calls = restored.calls.length;
		await restored.session.check();
		await restored.session.retry();
		assert.equal(restored.calls.length, calls, "a released record never repeats a confirmation or dispatch");
		assert.equal(restored.events.length, 1);
		restored.session.dispose();
	},
);

test("unsubscription removes only its listener and disposal does not restore listeners on activation", async () => {
	const f = fixture();
	const removed: PinLifecycle[] = [];
	const retained: PinLifecycle[] = [];
	const unsubscribe = f.session.subscribePinLifecycle((event) => removed.push(event));
	f.session.subscribePinLifecycle((event) => retained.push(event));
	unsubscribe();
	unsubscribe();
	await f.session.execute(input);
	assert.deepEqual(removed, []);
	assert.deepEqual(retained, [
		{ phase: "initiated", input },
		{ phase: "admitted", input },
	]);
	f.session.dispose();
	await f.session.execute({ ...input, requestId: "disposed" });
	assert.equal(f.calls.length, 2, "a disposed session does not dispatch or notify");
	f.session.activate();
	const fresh: PinLifecycle[] = [];
	f.session.subscribePinLifecycle((event) => fresh.push(event));
	f.handle(async (method) =>
		method === "getPresentationCommandResult" ? { method: "setConversationPinned", params: input, result } : result,
	);
	await f.session.check();
	assert.deepEqual(fresh, [{ phase: "confirmed", input, result }]);
	assert.equal(retained.length, 2, "activation must not revive disposed subscribers");
	assert.deepEqual(removed, []);
	f.session.dispose();
});

test("dispose during queued admission cannot retire an old action into reactivated listeners", async () => {
	const f = fixture();
	const gate = Promise.withResolvers<void>();
	const admission = f.local.withAdmission.bind(f.local);
	f.local.withAdmission = async (key, action) => {
		await gate.promise;
		return admission(key, action);
	};
	const running = f.session.execute(input);
	assert.deepEqual(f.events, [{ phase: "initiated", input }]);
	f.session.dispose();
	f.session.activate();
	const fresh: PinLifecycle[] = [];
	f.session.subscribePinLifecycle((event) => fresh.push(event));
	await running;
	assert.deepEqual(fresh, [], "the aborted action belongs to the disposed subscription lifetime");
	gate.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(fresh, []);
	assert.deepEqual(f.calls, []);
	assert.equal(f.local.read("command.presentation"), null);
	assert.equal(f.session.getSnapshot().busy, false);
	f.session.dispose();
});

test("timeout before admission retires the exact action once and ignores the released lock", async () => {
	vi.useFakeTimers();
	const f = fixture();
	const gate = Promise.withResolvers<void>();
	const admission = f.local.withAdmission.bind(f.local);
	f.local.withAdmission = async (key, action) => {
		await gate.promise;
		return admission(key, action);
	};
	const mutable = { ...input };
	const running = f.session.execute(mutable);
	mutable.requestId = "changed-after-queue";
	await vi.advanceTimersByTimeAsync(15000);
	await running;
	assert.deepEqual(f.events, [
		{ phase: "initiated", input },
		{ phase: "retired", input },
	]);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.session.getSnapshot().failed, true);
	assert.equal(f.session.getSnapshot().busy, false);
	gate.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(f.events.length, 2);
	assert.deepEqual(f.calls, []);
	assert.equal(f.local.read("command.presentation"), null);
	f.session.dispose();
});

test.each(["setConversationPinned", "reorderPinnedConversation"] as const)(
	"stored v8 %s preserves original bytes on load/check and retries only its exact payload",
	async (method) => {
		vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
		const storage = new MemoryStorage();
		const local = new LocalState("store", storage);
		const params = method === "setConversationPinned" ? input : orderInput;
		const raw = JSON.stringify({ version: 2, request: { version: 8, method, params } });
		assert.equal(local.write("command.presentation", raw), true);
		const before = [...storage.values];
		const f = fixture(new LocalState("store", storage));
		assert.equal(f.session.getSnapshot().incompatible, false);
		assert.deepEqual(f.session.getSnapshot().pending?.params, params);
		assert.equal(f.session.getSnapshot().pending?.version, PROTOCOL_VERSION);
		assert.deepEqual([...storage.values], before, "decoding alone must not migrate or overwrite the journal");
		assert.equal(f.calls.length, 0);
		assert.deepEqual(f.events, []);
		f.handle(async (called) => {
			if (called === "getPresentationCommandResult") return null;
			if (called === "reorderPinnedConversation") return { orderGeneration: 8 };
			return method === "setConversationPinned" ? result : orderPage;
		});
		await f.session.check();
		assert.deepEqual([...storage.values], before, "an absent receipt cannot rewrite the original journal");
		assert.equal(f.session.getSnapshot().notFound, true);
		assert.deepEqual(
			f.calls.map(({ method: called }) => called),
			["getPresentationCommandResult"],
		);
		assert.deepEqual(f.calls[0]?.params, { requestId: params.requestId });
		assert.deepEqual(f.events, []);
		await f.session.retry();
		assert.equal(f.session.getSnapshot().pending, null);
		assert.deepEqual(
			f.calls.map(({ method: called }) => called),
			[
				"getPresentationCommandResult",
				"getPresentationCommandResult",
				method,
				method === "setConversationPinned" ? "getConversationPresentation" : "listPinnedConversations",
			],
		);
		assert.deepEqual(f.calls[2]?.params, params);
		assert.deepEqual(f.events, method === "setConversationPinned" ? [{ phase: "confirmed", input, result }] : []);
		f.session.dispose();
	},
);

test.each(["outer", "request", "version", "store"] as const)(
	"unsupported stored %s metadata remains incompatible and untouched",
	async (field) => {
		const local = new LocalState();
		const request = {
			version: field === "version" ? 7 : 8,
			method: "setConversationPinned",
			params: input,
			...(field === "request" ? { unsafe: true } : {}),
			...(field === "store" ? { expectedStoreId: "other-store" } : {}),
		};
		const raw = JSON.stringify({ version: 2, request, ...(field === "outer" ? { unsafe: true } : {}) });
		local.write("command.presentation", raw);
		const f = fixture(local);
		await f.session.execute(input);
		await f.session.check();
		await f.session.retry();
		assert.equal(f.session.getSnapshot().incompatible, true);
		assert.equal(local.read("command.presentation"), raw);
		assert.deepEqual(f.calls, []);
		assert.deepEqual(f.events, []);
		f.session.dispose();
	},
);
