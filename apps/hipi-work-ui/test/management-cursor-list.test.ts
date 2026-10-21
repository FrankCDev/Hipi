import assert from "node:assert/strict";
import { AppError } from "@hipi/work-runtime/contracts";
import { test, vi } from "vitest";
import { ManagementCursorList } from "../src/components/management-list/cursor-list.ts";

function fixture() {
	const calls: (string | undefined)[] = [];
	const list = new ManagementCursorList<number>(async (cursor) => {
		calls.push(cursor);
		const index = cursor ? Number(cursor) : 0;
		return { items: [index * 2, index * 2 + 1], nextCursor: index < 11 ? String(index + 1) : null };
	});
	list.setActive(true);
	return { list, calls };
}
test("all forward/backward records stay reachable with three pages and no growing cursor index", async () => {
	const { list } = fixture();
	const seen = new Set<number>();
	for (let index = 0; index < 12; index++) {
		await list.load();
		const state = list.getSnapshot();
		assert.ok(state.pages.length <= 3);
		for (const item of state.pages.flatMap((page) => page.items)) seen.add(item);
	}
	assert.equal(seen.size, 24);
	assert.equal(list.getSnapshot().before, 9);
	for (let index = 0; index < 9; index++) await list.load("previous");
	assert.equal(list.getSnapshot().before, 0);
	assert.deepEqual(
		list.getSnapshot().pages.flatMap((page) => page.items),
		[0, 1, 2, 3, 4, 5],
	);
	await list.load();
	assert.deepEqual(
		list.getSnapshot().pages.flatMap((page) => page.items),
		[2, 3, 4, 5, 6, 7],
	);
});
test("empty slices retain continuation and repeated cursor fails instead of spinning", async () => {
	const list = new ManagementCursorList<number>(async (cursor) => ({ items: [], nextCursor: cursor ?? "scan" }));
	list.setActive(true);
	await list.load();
	assert.equal(list.getSnapshot().pages[0]?.nextCursor, "scan");
	await list.load();
	assert.equal(list.getSnapshot().failed, true);
	assert.equal(list.getSnapshot().pages.length, 1);
});
test("disconnect cancels read and late replies cannot publish into reopened generation", async () => {
	const pending = Promise.withResolvers<{ items: number[]; nextCursor: null }>();
	let blocked = true;
	let signal: AbortSignal | undefined;
	const list = new ManagementCursorList<number>(async (_cursor, current) => {
		signal = current;
		return blocked ? pending.promise : { items: [2], nextCursor: null };
	});
	list.setActive(true);
	const first = list.load();
	list.setActive(false);
	assert.ok(signal?.aborted);
	blocked = false;
	list.setActive(true);
	await list.load();
	pending.resolve({ items: [1], nextCursor: null });
	await first;
	assert.deepEqual(list.getSnapshot().pages[0]?.items, [2]);
	assert.equal(list.getSnapshot().failed, false);
});
test("failure keeps displayed records and retry repeats only the failed read; single-flight is independent", async () => {
	let failing = false;
	const pending = Promise.withResolvers<void>();
	const calls: (string | undefined)[] = [];
	const list = new ManagementCursorList<number>(async (cursor) => {
		calls.push(cursor);
		if (cursor) {
			await pending.promise;
			if (failing) throw new Error("offline");
		}
		return { items: [cursor ? 1 : 0], nextCursor: cursor ? null : "next" };
	});
	list.setActive(true);
	await list.load();
	failing = true;
	const reading = list.load();
	await list.load();
	assert.deepEqual(calls, [undefined, "next"]);
	pending.resolve();
	await reading;
	assert.deepEqual(list.getSnapshot().pages[0]?.items, [0]);
	failing = false;
	await list.retry();
	assert.deepEqual(calls, [undefined, "next", "next"]);
	assert.equal(list.getSnapshot().failed, false);
});
test("stale cursor restarts once atomically and never joins new head to old tail", async () => {
	let stale = false;
	const list = new ManagementCursorList<number>(async (cursor) => {
		if (stale && cursor) throw new AppError("CURSOR_STALE");
		return { items: [stale ? 100 : cursor ? 1 : 0], nextCursor: cursor ? "later" : "next" };
	});
	list.setActive(true);
	await list.load();
	await list.load();
	stale = true;
	await list.load();
	assert.deepEqual(
		list.getSnapshot().pages.flatMap((page) => page.items),
		[100],
	);
	assert.equal(list.getSnapshot().before, 0);
});
test("non-cooperating read times out without accepting a later body", async () => {
	vi.useFakeTimers();
	try {
		const pending = Promise.withResolvers<{ items: number[]; nextCursor: null }>();
		const list = new ManagementCursorList<number>(() => pending.promise);
		list.setActive(true);
		const read = list.load();
		await vi.advanceTimersByTimeAsync(15000);
		await read;
		assert.equal(list.getSnapshot().failed, true);
		pending.resolve({ items: [1], nextCursor: null });
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(list.getSnapshot().loaded, false);
	} finally {
		vi.useRealTimers();
	}
});

test("a cycle longer than the retained window is detected with constant cursor memory", async () => {
	const list = new ManagementCursorList<number>(async (cursor) => {
		const index = cursor ? Number(cursor) : 0;
		return { items: [index], nextCursor: String((index + 1) % 5) };
	});
	list.setActive(true);
	for (let index = 0; index < 20 && !list.getSnapshot().failed; index++) await list.load();
	assert.equal(list.getSnapshot().failed, true);
	assert.ok(list.getSnapshot().pages.length <= 3);
});

test("an interaction acquired during a pending read can defer eviction without discarding the window", async () => {
	const wait = Promise.withResolvers<void>();
	const list = new ManagementCursorList<number>(async (cursor) => {
		const index = Number(cursor ?? 0);
		if (index === 3) await wait.promise;
		return { items: [index], nextCursor: String(index + 1) };
	});
	list.setActive(true);
	await list.load();
	await list.load();
	await list.load();
	let protectedNow = false;
	const pending = list.load("next", () => !protectedNow);
	protectedNow = true;
	wait.resolve();
	await pending;
	assert.equal(list.getSnapshot().before, 0);
	assert.equal(list.getSnapshot().failed, false);
	protectedNow = false;
	await list.load("next", () => !protectedNow);
	assert.equal(list.getSnapshot().before, 1);
});

test("reverse traversal yields long scans while retaining only one replay checkpoint", async () => {
	let calls = 0;
	const list = new ManagementCursorList<number>(async (cursor) => {
		calls++;
		const index = Number(cursor ?? 0);
		return { items: [index], nextCursor: String(index + 1) };
	});
	list.setActive(true);
	for (let index = 0; index < 80; index++) await list.load();
	const before = list.getSnapshot().before;
	for (let attempt = 0; attempt < 6 && list.getSnapshot().before === before; attempt++) {
		const reads = calls;
		await list.load("previous");
		assert.ok(calls - reads <= 16);
		assert.ok(list.getSnapshot().pages.length <= 3);
	}
	assert.equal(list.getSnapshot().before, before - 1);
});
