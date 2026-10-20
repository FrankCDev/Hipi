import assert from "node:assert/strict";
import {
	type AppClient,
	AppError,
	type ConversationSearchHit,
	type Method,
	parseResult,
	type SearchIndexStatus,
} from "@hipi/work-runtime/contracts";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ConversationSearchController } from "../../../src/features/workbench/search/controller.ts";

const ready: SearchIndexStatus = { generation: "g", state: "ready", completedAt: 1, nextCursor: null };
const hit: ConversationSearchHit = {
	workspaceId: "closed-project",
	conversationId: "unloaded",
	title: "A different title",
	workspaceName: "Closed project",
	kind: "message",
	messageId: "1_0",
	locator: "opaque-locator",
	snippet: "old needle text",
	snippetOffset: 5000,
	matchStart: 5004,
	matchEnd: 5010,
};
type Call = {
	method: Method;
	params: unknown;
	signal?: AbortSignal;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};
const owners: ConversationSearchController[] = [];
function harness() {
	const calls: Call[] = [];
	const client: AppClient = {
		call(method, params, signal) {
			return new Promise((resolve, reject) =>
				calls.push({
					method,
					params,
					signal,
					resolve: (value) => resolve(parseResult(method, value)),
					reject,
				}),
			);
		},
		async observe() {
			throw new Error("Search must never observe or open execution");
		},
	};
	const owner = new ConversationSearchController(client);
	owners.push(owner);
	return { owner, calls, queries: () => calls.filter((call) => call.method === "searchConversations") };
}
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};
const page = (items: ConversationSearchHit[] = [], nextCursor: string | null = null, index = ready) => ({
	items,
	nextCursor,
	index,
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const owner of owners.splice(0)) owner.dispose();
	assert.equal(vi.getTimerCount(), 0);
	vi.useRealTimers();
});

test("opening refreshes independently; query finds unloaded message content and paginates empty scans", async () => {
	const { owner, calls, queries } = harness();
	owner.activate();
	assert.deepEqual(
		calls.map((call) => call.method),
		["refreshConversationSearch"],
	);
	owner.setQuery(" needle ");
	await vi.advanceTimersByTimeAsync(180);
	assert.deepEqual(queries()[0]?.params, { query: "needle" });
	queries()[0]?.resolve(page([], "next", { ...ready, state: "refreshing", nextCursor: "index-next" }));
	await flush();
	assert.deepEqual(queries()[1]?.params, { query: "needle", cursor: "next" });
	queries()[1]?.resolve(page([hit]));
	await flush();
	assert.deepEqual(owner.getSnapshot().items, [hit]);
	assert.equal(owner.getSnapshot().refreshing, true, "A ready projection read cannot finish the owned refresh");
	calls[0]?.resolve(ready);
	await flush();
	assert.equal(queries().length, 3, "Refresh completion rechecks the first query page");
	assert.equal(owner.getSnapshot().refreshing, false);
	queries()[2]?.resolve(page([hit]));
	await flush();
	assert.equal(owner.getSnapshot().queryGeneration, "g");
});

test("replacement cancels stale success and stale-error retries without touching a new query", async () => {
	for (const lateError of [false, true]) {
		const { owner, calls, queries } = harness();
		owner.activate();
		calls[0]?.resolve(ready);
		await flush();
		owner.setQuery("old");
		await vi.advanceTimersByTimeAsync(180);
		const old = queries()[0];
		owner.setQuery("new");
		assert.equal(old?.signal?.aborted, true);
		await vi.advanceTimersByTimeAsync(180);
		if (lateError) old?.reject(new AppError("CURSOR_STALE"));
		else old?.resolve(page([hit], "old-cursor"));
		await flush();
		assert.equal(queries().length, 2);
		assert.deepEqual(owner.getSnapshot().items, []);
		queries()[1]?.resolve(page([{ ...hit, conversationId: "new-result" }]));
		await flush();
		assert.equal(owner.getSnapshot().items[0]?.conversationId, "new-result");
		owner.dispose();
	}
});

test("IME composition blocks checkpoint and final-refresh query restarts", async () => {
	const { owner, calls, queries } = harness();
	owner.activate();
	owner.setQuery("拼", true);
	calls[0]?.resolve(ready);
	await vi.advanceTimersByTimeAsync(1000);
	assert.equal(queries().length, 0);
	assert.equal(owner.getSnapshot().loading, false);
	owner.setQuery("拼音", false);
	await vi.advanceTimersByTimeAsync(180);
	assert.deepEqual(queries()[0]?.params, { query: "拼音" });
});

test("stale pagination restarts first page, never appends another index generation", async () => {
	const { owner, calls, queries } = harness();
	owner.activate();
	calls[0]?.resolve(ready);
	await flush();
	owner.setQuery("needle");
	await vi.advanceTimersByTimeAsync(180);
	queries()[0]?.resolve(page([hit], "next"));
	await flush();
	owner.loadMore();
	queries()[1]?.reject(new AppError("CURSOR_STALE"));
	await flush();
	assert.deepEqual(queries()[2]?.params, { query: "needle" });
	assert.deepEqual(owner.getSnapshot().items, []);
	queries()[2]?.resolve(page([{ ...hit, conversationId: "fresh" }], null, { ...ready, generation: "new" }));
	await flush();
	assert.equal(owner.getSnapshot().items.length, 1);
	assert.equal(owner.getSnapshot().queryGeneration, "new");
});

test("empty scans stop at the bounded budget and explicit continuation preserves cycle detection", async () => {
	const { owner, calls, queries } = harness();
	owner.activate();
	calls[0]?.resolve(ready);
	await flush();
	owner.setQuery("needle");
	await vi.advanceTimersByTimeAsync(180);
	for (let index = 0; index < 16; index++) {
		queries()[index]?.resolve(page([], `cursor-${index}`));
		await flush();
	}
	assert.equal(queries().length, 16);
	assert.equal(owner.getSnapshot().scanLimited, true);
	owner.loadMore();
	queries()[16]?.resolve(page([], "cursor-0"));
	await flush();
	assert.equal(owner.getSnapshot().failed, true);
	assert.equal(queries().length, 17);
});

test("index refresh resumes bounded cursors and disposing cancels its yield and late publications", async () => {
	const { owner, calls } = harness();
	owner.activate();
	calls[0]?.resolve({ ...ready, state: "refreshing", nextCursor: "step" });
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual(calls[1]?.params, { cursor: "step" });
	calls[1]?.reject(new AppError("CURSOR_STALE"));
	await flush();
	assert.deepEqual(calls[2]?.params, {});
	calls[2]?.resolve({ ...ready, state: "refreshing", nextCursor: "resumed" });
	await flush();
	let publications = 0;
	owner.subscribe(() => publications++);
	owner.dispose();
	await flush();
	assert.equal(publications, 0);
	assert.equal(calls[2]?.signal?.aborted, true);
	assert.equal(vi.getTimerCount(), 0);
});

test("a stale cursor at the scan budget boundary starts a fresh bounded first-page read, never a false empty", async () => {
	const { owner, calls, queries } = harness();
	owner.activate();
	calls[0]?.resolve(ready);
	await flush();
	owner.setQuery("needle");
	await vi.advanceTimersByTimeAsync(180);
	for (let index = 0; index < 15; index++) {
		queries()[index]?.resolve(page([], `cursor-${index}`));
		await flush();
	}
	queries()[15]?.reject(new AppError("CURSOR_STALE"));
	await flush();
	assert.equal(queries().length, 17);
	assert.deepEqual(queries()[16]?.params, { query: "needle" });
	assert.equal(owner.getSnapshot().queryGeneration, undefined);
	assert.equal(owner.getSnapshot().loading, true);
	queries()[16]?.resolve(page([hit]));
	await flush();
	assert.deepEqual(owner.getSnapshot().items, [hit]);
	assert.equal(owner.getSnapshot().scanLimited, false);
});
