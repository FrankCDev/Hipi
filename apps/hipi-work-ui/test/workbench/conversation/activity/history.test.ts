import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryPage, RunResultObservation, Snapshot } from "@hipi/work-runtime/contracts";
import { ConversationHistoryController } from "../../../../src/features/workbench/conversation/history-controller.ts";

const scope = { workspaceId: "w", conversationId: "c" };
const terminal: RunResultObservation = {
	id: "1",
	terminalEntryId: "10",
	admittedAtMs: 1,
	settledAtMs: 10,
	terminalCause: "response",
	responseMessageId: "9_0",
	settlement: { status: "done" },
};
const snapshot = (ids: string[], cursor: string | null = null): Snapshot => ({
	...scope,
	messages: ids.map((id) => ({ id, role: "assistant", text: id, textLength: id.length, truncated: false, runId: "1" })),
	running: false,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: cursor,
});
const results = (owner: ConversationHistoryController) => owner.state.snapshot?.runResults;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
	const calls: { resolve: (page: HistoryPage) => void; signal: AbortSignal }[] = [];
	const owner = new ConversationHistoryController(
		scope,
		(_cursor, signal) => new Promise((resolve) => calls.push({ resolve, signal })),
		() => {},
	);
	return { owner, calls };
}

test("empty terminal pages retain sideband through newer observations and reset keeps only latest scope view", async () => {
	const { owner, calls } = harness();
	owner.update(snapshot(["9_0"], "older"));
	owner.setNearTop(true);
	calls[0]?.resolve({ ...scope, messages: [], nextCursor: null, runResults: { items: [terminal], omitted: false } });
	await tick();
	assert.deepEqual(results(owner)?.items, [terminal]);
	owner.update(snapshot(["9_0", "11_0"]));
	assert.deepEqual(results(owner)?.items, [terminal]);
	owner.resetToLatest();
	assert.equal(results(owner), undefined);
	owner.dispose();
});

test("bridge sideband is staged atomically even on empty intermediate pages", async () => {
	const { owner, calls } = harness();
	owner.update(snapshot(["2_0"], "old"));
	owner.update(snapshot(["9_0"], "bridge"));
	calls[0]?.resolve({ ...scope, messages: [], nextCursor: "more", runResults: { items: [terminal], omitted: false } });
	await tick();
	assert.equal(results(owner), undefined);
	calls[1]?.resolve({ ...scope, messages: snapshot(["2_0", "8_0"]).messages, nextCursor: null });
	await tick();
	assert.deepEqual(results(owner)?.items, [terminal]);
	assert.deepEqual(
		owner.state.snapshot?.messages.map((m) => m.id),
		["2_0", "8_0", "9_0"],
	);
	owner.dispose();
});

test("foreign scope and late disposed pages cannot publish terminal metadata", async () => {
	for (const disposed of [false, true]) {
		const { owner, calls } = harness();
		owner.update(snapshot(["9_0"], "old"));
		owner.setNearTop(true);
		if (disposed) owner.dispose();
		calls[0]?.resolve({
			...scope,
			conversationId: disposed ? "c" : "foreign",
			messages: [],
			nextCursor: null,
			runResults: { items: [terminal], omitted: false },
		});
		await tick();
		assert.equal(results(owner), undefined);
		if (!disposed) assert.equal(owner.state.failed, true);
		owner.dispose();
	}
});

test("search projection never imports live run facts, including background completion", () => {
	const { owner } = harness();
	const live = { ...snapshot(["9_0"]), runResults: { items: [terminal], omitted: false } };
	owner.update(live);
	owner.openAnchor({
		locator: "opaque",
		window: {
			...scope,
			messages: live.messages,
			olderCursor: null,
			newerCursor: null,
			matchStart: 0,
			matchEnd: 1,
			target: { ...scope, messageId: "9_0", text: "9_0", offset: 0, nextOffset: null, textLength: 3 },
		},
	});
	owner.update(live);
	assert.equal(results(owner), undefined);
	owner.resetToLatest();
	assert.deepEqual(results(owner)?.items, [terminal]);
	owner.dispose();
});
