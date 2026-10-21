import assert from "node:assert/strict";
import { LIMITS, type MessageTextChunk } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { MessageDocumentPool } from "../../../../src/features/workbench/conversation/document/owner.ts";

const chunk = (source: string, offset: number, size = LIMITS.textChunk): MessageTextChunk => ({
	workspaceId: "w",
	conversationId: "c",
	messageId: "m",
	offset,
	text: source.slice(offset, offset + size),
	textLength: source.length,
	nextOffset: offset + size < source.length ? offset + size : null,
});
const settle = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
test("one canonical source joins transport boundaries without interpretation", async () => {
	const source = `${"x".repeat(LIMITS.textChunk - 3)}\n\n\`\`\`ts\nconst x=1;\n\`\`\`\n[ref][id]\n\n[id]: /file`;
	const reads: number[] = [];
	const pool = new MessageDocumentPool();
	const lease = pool.acquire("m", source.length, async (offset) => {
		reads.push(offset);
		return chunk(source, offset);
	});
	lease.setActive(true);
	await settle();
	assert.equal(lease.getSnapshot().source, source);
	assert.equal(lease.getSnapshot().complete, true);
	assert.deepEqual(reads, [0, LIMITS.textChunk]);
	lease.release();
});
test("active sources and pending reservations obey total budget and resume after release", async () => {
	const source = "a".repeat(64);
	const pool = new MessageDocumentPool(256, 2);
	const first = pool.acquire("first", 64, async (offset) => chunk(source, offset));
	first.setActive(true);
	await settle();
	const second = pool.acquire("second", 64, async (offset) => chunk(source, offset));
	second.setActive(true);
	await settle();
	assert.equal(first.getSnapshot().source, source);
	assert.equal(second.getSnapshot().complete, false);
	assert.equal(second.getSnapshot().pressure, true);
	assert.equal(pool.retainedBytes, 256);
	first.release();
	await settle();
	assert.equal(second.getSnapshot().source, source);
	assert.equal(second.getSnapshot().complete, true);
	assert.equal(pool.retainedBytes, 256);
	second.release();
});
test("single document pressure retains prefix and cannot claim completion", async () => {
	const source = "x".repeat(LIMITS.textChunk + 20);
	const pool = new MessageDocumentPool(LIMITS.textChunk * 4, 2);
	const lease = pool.acquire("m", source.length, async (offset) => chunk(source, offset));
	lease.setActive(true);
	await settle();
	assert.equal(lease.getSnapshot().source, source.slice(0, LIMITS.textChunk));
	assert.equal(lease.getSnapshot().complete, false);
	assert.equal(lease.getSnapshot().pressure, true);
	assert.equal(pool.retainedBytes, LIMITS.textChunk * 4);
	lease.release();
});
test("selection pause accepts reserved flight but schedules no subsequent chunk", async () => {
	const source = "x".repeat(LIMITS.textChunk + 20);
	const pool = new MessageDocumentPool();
	let resolve: ((value: MessageTextChunk) => void) | undefined;
	let calls = 0;
	const lease = pool.acquire("m", source.length, (offset) => {
		calls++;
		return calls === 1
			? new Promise((r) => {
					resolve = r;
				})
			: Promise.resolve(chunk(source, offset));
	});
	lease.setActive(true);
	lease.setActive(false, false);
	resolve?.(chunk(source, 0));
	await settle();
	assert.equal(calls, 1);
	assert.equal(lease.getSnapshot().loadedUnits, LIMITS.textChunk);
	lease.setActive(true);
	await settle();
	assert.equal(calls, 2);
	assert.equal(lease.getSnapshot().complete, true);
	lease.release();
});
test("background abort fences late completions and frees reservations", async () => {
	const pool = new MessageDocumentPool();
	let resolve: ((value: MessageTextChunk) => void) | undefined;
	let signal: AbortSignal | undefined;
	const lease = pool.acquire("m", 10, (_offset, s) => {
		signal = s;
		return new Promise((r) => {
			resolve = r;
		});
	});
	lease.setActive(true);
	assert.equal(pool.retainedBytes, 40);
	lease.setActive(false);
	assert.equal(signal?.aborted, true);
	assert.equal(pool.retainedBytes, 0);
	resolve?.(chunk("x".repeat(10), 0));
	await settle();
	assert.equal(lease.getSnapshot().source, "");
	assert.equal(lease.getSnapshot().complete, false);
	lease.release();
});
test("global concurrency is two and each owner is single flight", async () => {
	const pool = new MessageDocumentPool();
	const pending: (() => void)[] = [];
	let flights = 0;
	let maximum = 0;
	const leases = Array.from({ length: 4 }, (_, i) =>
		pool.acquire(
			String(i),
			4,
			() =>
				new Promise((resolve) => {
					flights++;
					maximum = Math.max(maximum, flights);
					pending.push(() => {
						flights--;
						resolve(chunk("xxxx", 0));
					});
				}),
		),
	);
	for (const lease of leases) lease.setActive(true);
	assert.equal(flights, 2);
	while (pending.length) {
		pending.shift()?.();
		await settle();
	}
	assert.equal(maximum, 2);
	assert.ok(leases.every((l) => l.getSnapshot().complete));
	for (const lease of leases) lease.release();
});
test("verified canonical replaces provisional live source without duplicating it", async () => {
	const source = `${"a".repeat(LIMITS.textChunk)}correct`;
	const pool = new MessageDocumentPool();
	const lease = pool.acquire("m", source.length, async (offset) => chunk(source, offset), "x".repeat(source.length));
	lease.setActive(true);
	await settle();
	assert.equal(lease.getSnapshot().source, source);
	assert.equal(lease.getSnapshot().complete, true);
	lease.release();
});

test("one selected lease pauses its shared owner even if another lease is visible", async () => {
	const source = "x".repeat(LIMITS.textChunk + 20);
	const pool = new MessageDocumentPool();
	let resolve: ((page: MessageTextChunk) => void) | undefined;
	let reads = 0;
	const read = (offset: number) => {
		reads++;
		return reads === 1
			? new Promise<MessageTextChunk>((r) => {
					resolve = r;
				})
			: Promise.resolve(chunk(source, offset));
	};
	const first = pool.acquire("m", source.length, read);
	const second = pool.acquire("m", source.length, read);
	first.setActive(true);
	second.setActive(true);
	first.setActive(false, false);
	resolve?.(chunk(source, 0));
	await settle();
	assert.equal(reads, 1);
	assert.equal(second.getSnapshot().complete, false);
	first.setActive(true);
	await settle();
	assert.equal(reads, 2);
	assert.equal(second.getSnapshot().source, source);
	first.release();
	second.release();
});
test("surrogate overlap is verified and appended exactly once", async () => {
	const source = "a😀b";
	const pool = new MessageDocumentPool();
	const lease = pool.acquire("m", source.length, async (offset) =>
		offset === 0 ? { ...chunk(source, 0), text: "a\ud83d", nextOffset: 2 } : { ...chunk(source, 1), offset: 1 },
	);
	lease.setActive(true);
	await settle();
	assert.equal(lease.getSnapshot().source, source);
	assert.equal(lease.getSnapshot().complete, true);
	lease.release();
});
test("non-surrogate and mismatching overlapping responses fail without corrupting prefix", async () => {
	const pool = new MessageDocumentPool();
	const lease = pool.acquire("m", 4, async (offset) =>
		offset === 0 ? { ...chunk("abcd", 0), text: "ab", nextOffset: 2 } : { ...chunk("abcd", 1), offset: 1 },
	);
	lease.setActive(true);
	await settle();
	assert.equal(lease.getSnapshot().source, "ab");
	assert.equal(lease.getSnapshot().failed, true);
	assert.equal(lease.getSnapshot().complete, false);
	lease.release();
});
test("oversized initial admission cannot escape the active source budget", async () => {
	const pool = new MessageDocumentPool(64);
	const lease = pool.acquire("m", 100, async (offset) => chunk("x".repeat(100), offset), "x".repeat(100));
	lease.setActive(true);
	await settle();
	assert.equal(lease.getSnapshot().pressure, true);
	assert.equal(lease.getSnapshot().complete, false);
	assert.ok(pool.retainedBytes <= 64);
	lease.release();
});
