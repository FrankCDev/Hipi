import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryPage, Message, SearchHistoryWindow, Snapshot } from "@hipi/work-runtime/contracts";
import { ConversationHistoryController } from "../src/features/workbench/conversation-history-controller.ts";

const scope = { workspaceId: "w", conversationId: "c" };
const message = (id: string): Message => ({ id, role: "user", text: id, textLength: id.length, truncated: false });
const window = (ids = ["old", "match", "later"]): SearchHistoryWindow => ({
	...scope,
	messages: ids.map(message),
	target: { ...scope, messageId: "match", text: "match", offset: 0, textLength: 5, nextOffset: null },
	matchStart: 0,
	matchEnd: 5,
	olderCursor: "older",
	newerCursor: "newer",
});
const live = (id: string): Snapshot => ({
	...scope,
	messages: [message(id)],
	partial: "live output",
	partialLength: 11,
	partialTruncated: false,
	running: true,
	historyCursor: "remote-tail",
});
function harness() {
	const reads: {
		locator: string;
		cursor: string;
		signal: AbortSignal;
		resolve: (value: SearchHistoryWindow) => void;
		reject: (error: Error) => void;
	}[] = [];
	const normal: string[] = [];
	const owner = new ConversationHistoryController(
		scope,
		(cursor) => {
			normal.push(cursor);
			return Promise.resolve<HistoryPage>({ ...scope, messages: [], nextCursor: null });
		},
		() => {},
		(locator, cursor, signal) =>
			new Promise((resolve, reject) => reads.push({ locator, cursor, signal, resolve, reject })),
	);
	return { owner, reads, normal };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ids = (owner: ConversationHistoryController) => owner.state.snapshot?.messages.map((item) => item.id);

test("an old search anchor retains its bounded window and never bridges live output to the tail", () => {
	const { owner, normal } = harness();
	owner.openAnchor({ locator: "opaque", window: window() });
	owner.setNearTop(true);
	owner.update(live("far-newer"));
	owner.update(live("newest"));
	assert.deepEqual(ids(owner), ["old", "match", "later"]);
	assert.equal(owner.state.snapshot?.partial, "");
	assert.equal(owner.state.snapshot?.running, false);
	assert.equal(owner.state.reconciling, false);
	assert.deepEqual(normal, []);
	owner.resetToLatest();
	assert.equal(owner.state.anchor, undefined);
	assert.deepEqual(ids(owner), ["newest"]);
	assert.equal(owner.state.snapshot?.partial, "live output");
});

test("older and newer buttons load one bounded page and retain the opposite opaque cursor", async () => {
	const { owner, reads, normal } = harness();
	owner.openAnchor({ locator: "opaque", window: window() });
	owner.loadAnchored("older");
	owner.loadAnchored("newer");
	assert.equal(reads.length, 1);
	assert.equal(reads[0]?.locator, "opaque");
	reads[0]?.resolve({ ...window(["earlier"]), olderCursor: "older-2", newerCursor: null });
	await tick();
	assert.deepEqual(ids(owner), ["earlier", "old", "match", "later"]);
	assert.equal(owner.state.anchor?.window.newerCursor, "newer");
	assert.equal(reads.length, 1, "No automatic page draining");
	owner.loadAnchored("newer");
	reads[1]?.resolve({ ...window(["after"]), olderCursor: null, newerCursor: "newer-2" });
	await tick();
	assert.deepEqual(ids(owner), ["earlier", "old", "match", "later", "after"]);
	assert.equal(owner.state.anchor?.window.olderCursor, "older-2");
	assert.deepEqual(normal, []);
});

test("empty directional pages require explicit continuation and reject cursor cycles", async () => {
	const { owner, reads } = harness();
	owner.openAnchor({ locator: "opaque", window: window() });
	owner.loadAnchored("older");
	reads[0]?.resolve({ ...window([]), olderCursor: "step-2" });
	await tick();
	assert.equal(reads.length, 1);
	owner.loadAnchored("older");
	reads[1]?.resolve({ ...window(["bad"]), olderCursor: "older" });
	await tick();
	assert.equal(owner.state.failed, true);
	assert.deepEqual(ids(owner), ["old", "match", "later"]);
});

test("replacement and Jump to latest abort and ignore stale directional reads", async () => {
	for (const reset of [false, true]) {
		const { owner, reads } = harness();
		owner.openAnchor({ locator: "opaque", window: window() });
		owner.update(live("latest"));
		owner.loadAnchored("newer");
		if (reset) owner.resetToLatest();
		else owner.openAnchor({ locator: "replacement", window: window(["match"]) });
		assert.equal(reads[0]?.signal.aborted, true);
		reads[0]?.resolve(window(["obsolete"]));
		await tick();
		assert.deepEqual(ids(owner), reset ? ["latest"] : ["match"]);
	}
});

test("foreign scope, changed target and invalid initial matching offsets cannot replace retained history", async () => {
	const { owner, reads } = harness();
	assert.throws(() => owner.openAnchor({ locator: "bad", window: { ...window(), matchEnd: 500 } }));
	owner.openAnchor({ locator: "opaque", window: window() });
	owner.loadAnchored("older");
	reads[0]?.resolve({ ...window(["bad"]), workspaceId: "foreign" });
	await tick();
	assert.equal(owner.state.failed, true);
	owner.retry();
	reads[1]?.resolve({ ...window(["bad"]), target: { ...window().target, messageId: "changed" } });
	await tick();
	assert.deepEqual(ids(owner), ["old", "match", "later"]);
	assert.equal(owner.state.failed, true);
	owner.dispose();
});
