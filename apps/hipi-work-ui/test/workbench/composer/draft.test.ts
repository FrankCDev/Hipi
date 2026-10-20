import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import {
	type DraftState,
	openHomeDraft as open,
	readDraftInventory,
	recoverHomeDraft as recover,
} from "../../../src/features/workbench/composer/draft.ts";
import {
	ACTIVE_DRAFT_KEY,
	parseActiveDraft,
	validHomeDraft,
} from "../../../src/features/workbench/composer/draft-record.ts";
import { newChatDestination } from "../../../src/features/workbench/composer/new-chat-context.ts";
import type { SavedValue } from "../../../src/features/workbench/local-persistence.ts";

const openHomeDraft = (local: DraftState, input: Parameters<typeof open>[1]) =>
	open(local, input, new AbortController().signal);
const recoverHomeDraft = (local: DraftState, expected: Parameters<typeof recover>[1], candidate: SavedValue) =>
	recover(local, expected, candidate, new AbortController().signal);

function fixture() {
	const stored = new Map<string, SavedValue>();
	const unsaved = new Map<string, SavedValue>();
	let queue: Promise<unknown> = Promise.resolve();
	let fail = false;
	const local: DraftState = {
		storedValue: (key) => structuredClone(stored.get(key) ?? null),
		valueSnapshot: (key) => structuredClone(unsaved.get(key) ?? stored.get(key) ?? null),
		persistValue: (entry) => {
			if (fail) throw new Error("RECOVERY_STORAGE_UNAVAILABLE");
			stored.set(entry.key, structuredClone(entry));
		},
		storedDraftValues: () =>
			[...stored.values()].filter((entry) => validHomeDraft(entry.key, entry.value)).map((entry) => ({ ...entry })),
		unsavedDraftValues: () => [...unsaved.values()].map((entry) => ({ ...entry })),
		withAdmission: (key, work) => {
			assert.equal(key, "command.catalog");
			const next = queue.then(work);
			queue = next.catch(() => {});
			return next;
		},
	};
	return {
		local,
		stored,
		unsaved,
		write(key: string, value: string, revision = crypto.randomUUID()) {
			const entry: SavedValue = { kind: "value", key, value, revision };
			stored.set(key, entry);
			return entry;
		},
		block(value: Promise<void>) {
			queue = value;
		},
		fail(value: boolean) {
			fail = value;
		},
	};
}

test("new chat destination uses explicit target, canonical conversation, then selected project, never a name", () => {
	const selection = {
		selectedConversation: { workspaceId: "conversation-project", conversationId: "thread" },
		selectedWorkspaceId: "selected-project",
		defaultWorkspaceId: "default",
	};
	assert.equal(newChatDestination(selection), "conversation-project");
	assert.equal(newChatDestination({ ...selection, explicitWorkspaceId: "explicit" }), "explicit");
	assert.equal(newChatDestination({ ...selection, explicitWorkspaceId: null }), null);
	assert.equal(newChatDestination({ ...selection, selectedConversation: null }), "selected-project");
	assert.equal(newChatDestination({ ...selection, explicitWorkspaceId: "default" }), null);
	assert.equal(newChatDestination({ ...selection, explicitWorkspaceId: "Chats" }), "Chats");
	assert.equal(newChatDestination({ ...selection, selectedConversation: null, selectedWorkspaceId: null }), null);
	assert.throws(() => newChatDestination({ ...selection, explicitWorkspaceId: "../foreign" }));
});

test("initial adoption prefers destination then global then a sole retained draft without moving text", async () => {
	for (const keys of [
		["task-draft.project", "chat-draft.global", "task-draft.other"],
		["chat-draft.global", "task-draft.other"],
		["task-draft.other"],
	]) {
		const f = fixture();
		for (const key of keys) f.write(key, `text for ${key}`);
		const before = [...f.stored.values()].map((entry) => ({ ...entry }));
		const result = await openHomeDraft(f.local, { destination: "project", expected: null });
		assert.equal(result.active?.sourceKey, keys[0]);
		for (const entry of before) assert.deepEqual(f.stored.get(entry.key), entry);
		assert.equal(result.retainedSources.length, keys.length - 1);
	}
});

test("multiple unmatched legacy drafts remain recoverable without arbitrary adoption", async () => {
	const f = fixture();
	f.write("task-draft.a", "A");
	f.write("task-draft.b", "B");
	const result = await openHomeDraft(f.local, { destination: "missing", expected: null });
	assert.match(result.active?.sourceKey ?? "", /^new-chat-draft\./);
	assert.deepEqual(
		result.retainedSources.map((entry) => entry.value),
		["A", "B"],
	);
	assert.equal(f.stored.get(result.active?.sourceKey ?? ""), undefined, "blank source requires no text-copy write");
});

test("ordinary New chat and project changes preserve identity and text; explicit fresh is separate", async () => {
	const f = fixture();
	f.write("task-draft.a", "A");
	const first = await openHomeDraft(f.local, { destination: "a", expected: null });
	const second = await openHomeDraft(f.local, { destination: "b", expected: first.active });
	assert.deepEqual(second.active, first.active);
	const fresh = await openHomeDraft(f.local, { destination: "b", expected: first.active, fresh: true });
	assert.notDeepEqual(fresh.active, first.active);
	assert.equal(fresh.retainedSources[0]?.value, "A");
});

test("explicit retained recovery preserves the former active text and refuses a changed candidate", async () => {
	const f = fixture();
	f.write("task-draft.a", "A");
	const b = f.write("task-draft.b", "B");
	const first = await openHomeDraft(f.local, { destination: "a", expected: null });
	assert.ok(first.active);
	const next = await recoverHomeDraft(f.local, first.active, b);
	assert.equal(next.active?.sourceKey, b.key);
	assert.equal(next.retainedSources[0]?.value, "A");
	assert.ok(next.active);
	const a = next.retainedSources[0];
	assert.ok(a);
	f.write(a.key, "new A");
	await assert.rejects(recoverHomeDraft(f.local, next.active, a), /HOME_DRAFT_CHANGED/);
});

test("claimed legacy sources stay visible but cannot be adopted or edited through recovery", async () => {
	const f = fixture();
	const source = f.write("task-draft.a", "later A");
	const command = {
		version: PROTOCOL_VERSION,
		method: "createConversation",
		params: { workspaceId: "a", requestId: "request", title: "A" },
	};
	const raw = JSON.stringify({
		version: 2,
		request: command,
		preparedTask: {
			workspaceId: "a",
			requestId: "request",
			text: "captured A",
			sourceRevision: null,
			conversationId: null,
		},
	});
	f.write("command.catalog", raw);
	const result = await openHomeDraft(f.local, { destination: "a", expected: null });
	assert.notEqual(result.active?.sourceKey, source.key);
	assert.equal(result.claimedSource, source.key);
	assert.equal(result.retainedSources[0]?.value, "later A");
	assert.deepEqual(result.recoverable, []);
	assert.ok(result.active);
	await assert.rejects(recoverHomeDraft(f.local, result.active, source), /HOME_DRAFT_CLAIMED/);
	assert.equal(f.stored.get("command.catalog")?.value, raw);
});

test("descriptor persistence failure leaves every legacy record intact and retry adopts deterministically", async () => {
	const f = fixture();
	const source = f.write("task-draft.a", "A");
	f.fail(true);
	await assert.rejects(openHomeDraft(f.local, { destination: "a", expected: null }), /RECOVERY_STORAGE_UNAVAILABLE/);
	assert.deepEqual([...f.stored.values()], [source]);
	f.fail(false);
	const result = await openHomeDraft(f.local, { destination: "a", expected: null });
	assert.equal(result.active?.sourceKey, source.key);
	assert.deepEqual((await readDraftInventory(f.local)).active, result.active);
});

test("two windows cannot replace an active descriptor from the same stale generation", async () => {
	const f = fixture();
	const results = await Promise.allSettled([
		openHomeDraft(f.local, { destination: "a", expected: null }),
		openHomeDraft(f.local, { destination: "b", expected: null }),
	]);
	assert.equal(results[0]?.status, "fulfilled");
	assert.equal(results[1]?.status, "rejected");
});

test("queued recovery rejects changed source and preserves unsaved local text", async () => {
	const f = fixture();
	f.write("task-draft.a", "A");
	const b = f.write("task-draft.b", "B");
	const first = await openHomeDraft(f.local, { destination: "a", expected: null });
	assert.ok(first.active);
	const gate = Promise.withResolvers<void>();
	f.block(gate.promise);
	const recovery = recoverHomeDraft(f.local, first.active, b);
	f.write(b.key, "changed B");
	gate.resolve();
	await assert.rejects(recovery, /HOME_DRAFT_CHANGED/);
	f.unsaved.set("task-draft.a", { kind: "value", key: "task-draft.a", value: "unsaved A", revision: "new" });
	await assert.rejects(
		openHomeDraft(f.local, { destination: "b", expected: first.active }),
		/HOME_DRAFT_STORAGE_CONFLICT/,
	);
	assert.equal(f.unsaved.get("task-draft.a")?.value, "unsaved A");
});

test("incompatible command and corrupt active descriptor fail closed without overwriting either record", async () => {
	const f = fixture();
	const raw = JSON.stringify({ version: 99 });
	f.write("command.catalog", raw);
	await assert.rejects(openHomeDraft(f.local, { destination: null, expected: null }), /CATALOG_RECOVERY_INCOMPATIBLE/);
	assert.equal(f.stored.get("command.catalog")?.value, raw);
	f.stored.delete("command.catalog");
	f.write(ACTIVE_DRAFT_KEY, raw);
	await assert.rejects(readDraftInventory(f.local), /INVALID_ACTIVE_DRAFT/);
	for (const key of ["command.catalog", "draft.a.b", "new-chat-draft../foreign"])
		assert.throws(() => parseActiveDraft(JSON.stringify({ version: 1, generation: "valid", sourceKey: key })));
});

test("cancelled navigation and recovery waiting for admission never change the persisted descriptor", async () => {
	const f = fixture();
	f.write("task-draft.a", "A");
	const b = f.write("task-draft.b", "B");
	const gate = Promise.withResolvers<void>();
	f.block(gate.promise);
	const navigation = new AbortController();
	const pending = open(f.local, { destination: "a", expected: null }, navigation.signal);
	navigation.abort();
	gate.resolve();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(f.stored.has(ACTIVE_DRAFT_KEY), false);
	const first = await openHomeDraft(f.local, { destination: "a", expected: null });
	assert.ok(first.active);
	const recoveryGate = Promise.withResolvers<void>();
	f.block(recoveryGate.promise);
	const recovery = new AbortController();
	const restoring = recover(f.local, first.active, b, recovery.signal);
	recovery.abort();
	recoveryGate.resolve();
	await assert.rejects(restoring, { name: "AbortError" });
	assert.deepEqual((await readDraftInventory(f.local)).active, first.active);
});
