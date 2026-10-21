import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
	Conversation,
	ConversationId,
	EntryId,
	EntryRecord,
	LiveState,
	SubmissionId,
	TaskId,
} from "@earendil-works/pi-durable";
import { parseHistoryPage } from "../src/contracts.ts";
import { projectExecution } from "../src/execution/projection.ts";
import { readHistory } from "../src/history.ts";
import { parseRunInputRefs, parseRunResult } from "../src/runs/contracts.ts";

const scope = { workspaceId: "work", conversationId: "chat" };
function user(id: number, overrides: Partial<EntryRecord> = {}): EntryRecord {
	return {
		id: id as EntryId,
		conversationId: 1 as ConversationId,
		kind: "host.input",
		model: [{ role: "user", content: "input", timestamp: 0 }],
		...overrides,
	};
}
function answer(id: number): EntryRecord {
	return {
		id: id as EntryId,
		conversationId: 1 as ConversationId,
		kind: "pi.assistant",
		runId: 5 as TaskId,
		model: [fauxAssistantMessage("answer")],
	};
}
function terminal(id: number, answerId: number, ids: number[], total = ids.length): EntryRecord {
	return {
		id: id as EntryId,
		conversationId: 1 as ConversationId,
		kind: "pi.run-result",
		runId: 5 as TaskId,
		data: {
			runId: 5,
			admittedAt: 0,
			settledAt: 100,
			terminalCause: "response",
			settlement: { status: "done", answer: answerId },
			inputRefs: { entryIds: ids, total, omitted: ids.length < total },
		},
	};
}
function source(entries: EntryRecord[]) {
	const exact: number[] = [];
	const conversation: Pick<Conversation, "entries"> = {
		async entries(query, limit) {
			if (query?.minEntryId !== undefined) exact.push(query.minEntryId);
			const found = entries
				.filter((e) => e.id >= (query?.minEntryId ?? 0) && e.id <= (query?.maxEntryId ?? Infinity))
				.sort((a, b) => b.id - a.id);
			return { items: found.slice(0, limit), next: found.length > (limit ?? Infinity) ? { next: true } : undefined };
		},
	};
	return { conversation, exact };
}

test("history verifies exact input references including custom kinds without assigning initial user runId", async () => {
	const page = await readHistory(source([user(1), answer(10), terminal(11, 10, [1])]).conversation, scope);
	assert.deepEqual(page.runResults?.items[0]?.inputRefs, { entryIds: ["1"], total: 1, omitted: false });
	assert.equal(page.messages[0]?.runId, undefined);
	assert.deepEqual(parseHistoryPage(page), page);
});

test("missing foreign head and multimodel inputs only degrade association, not timing or final", async () => {
	for (const bad of [
		undefined,
		user(1, { conversationId: 2 as ConversationId }),
		user(1, { head: 1 as EntryId }),
		user(1, { model: [...user(1).model!, ...user(1).model!] }),
		answer(1),
	]) {
		const page = await readHistory(
			source([...(bad ? [bad] : []), answer(10), terminal(11, 10, [1])]).conversation,
			scope,
		);
		const result = page.runResults!.items[0]!;
		assert.deepEqual(result.inputRefs, { entryIds: [], total: 1, omitted: true });
		assert.equal(result.responseMessageId, "10_0");
		assert.equal(result.settledAtMs, 100);
		assert.equal(page.runResults!.omitted, false);
	}
});

test("all terminal answers precede input reads in one deduplicated 32-target budget", async () => {
	const markers = Array.from({ length: 64 }, (_, i) => terminal(1000 + i, 100 + i, [1, 2]));
	const { conversation, exact } = source([
		user(1),
		user(2),
		...Array.from({ length: 64 }, (_, i) => answer(100 + i)),
		...markers,
	]);
	const page = await readHistory(conversation, scope);
	assert.equal(exact.length, 32);
	assert.ok(exact.every((id) => id >= 100 && id < 164));
	assert.equal(new Set(exact).size, 32);
	assert.equal(page.runResults?.items.filter((r) => r.responseMessageId).length, 32);
	assert.ok(page.runResults?.items.every((r) => r.inputRefs?.omitted));
	assert.ok(page.nextCursor);
});

test("shared targets reuse the page cache and exact lookup failures across all markers", async () => {
	const { conversation, exact } = source([
		user(1),
		answer(2),
		...Array.from({ length: 64 }, (_, i) => terminal(100 + i, 2, [1, 3])),
	]);
	const page = await readHistory(conversation, scope);
	assert.deepEqual(exact, [2, 1, 3]);
	assert.deepEqual(page.runResults?.items[0]?.inputRefs, { entryIds: ["1"], total: 2, omitted: true });
});

test("same committed live view validates admission refs; old or missing evidence stays unknown", () => {
	const live: LiveState = {
		run: {
			taskId: 20 as TaskId,
			inputs: [3 as SubmissionId],
			group: { id: 5 as TaskId, admittedAt: 0, inputRefs: { entryIds: [1 as EntryId], total: 1, omitted: false } },
		},
	};
	const view = {
		conversation: { id: 1 as ConversationId, ownership: { kind: "ownerless" as const } },
		entries: [user(1)],
	};
	assert.deepEqual(projectExecution(live, view)?.run?.inputRefs, { entryIds: ["1"], total: 1, omitted: false });
	assert.deepEqual(projectExecution(live, { ...view, entries: [] })?.run?.inputRefs, {
		entryIds: [],
		total: 1,
		omitted: true,
	});
	assert.equal(projectExecution(live)?.run?.inputRefs, undefined);
	assert.equal(projectExecution({ ...live, run: { ...live.run!, inputs: [] } }, view)?.run?.inputRefs, undefined);
	assert.equal(
		projectExecution({ run: { ...live.run!, group: { id: 5 as TaskId, admittedAt: 0 } } }, view)?.run?.inputRefs,
		undefined,
	);
});

test("wire references reject malformed identities, coverage, order and terminal fence", () => {
	for (const value of [
		{ entryIds: ["1"], total: 0, omitted: false },
		{ entryIds: ["1"], total: 2, omitted: false },
		{ entryIds: ["2", "1"], total: 2, omitted: false },
		{ entryIds: ["1", "1"], total: 2, omitted: false },
		{ entryIds: [1], total: 1, omitted: false },
		{ entryIds: ["01"], total: 1, omitted: false },
		{ entryIds: Array.from({ length: 33 }, (_, i) => String(i + 1)), total: 33, omitted: false },
		{ entryIds: ["1"], total: 1, omitted: false, secret: true },
	])
		assert.throws(() => parseRunInputRefs(value));
	assert.throws(() =>
		parseRunResult({
			id: "5",
			terminalEntryId: "10",
			admittedAtMs: 0,
			settledAtMs: 1,
			terminalCause: "unanswered",
			settlement: { status: "unanswered" },
			inputRefs: { entryIds: ["10"], total: 1, omitted: false },
		}),
	);
});
