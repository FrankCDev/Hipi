import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundedRead, type ReadState } from "../src/features/workbench/bounded-read.ts";

function fixture() {
	const requests: { input: string; signal: AbortSignal; resolve: (value: string) => void; reject: () => void }[] = [];
	const states: ReadState<string>[] = [];
	const reader = new BoundedRead<string, string>(
		(input, signal) =>
			new Promise((resolve, reject) => {
				requests.push({ input, signal, resolve, reject: () => reject(new Error("read failed")) });
			}),
		(state) => states.push(state),
	);
	return { reader, requests, states };
}

test("paging replaces one result and ignores a slow prior page even when transport ignores abort", async () => {
	const f = fixture();
	const first = f.reader.load("older-a");
	const second = f.reader.load("older-b");
	assert.equal(f.requests[0]?.signal.aborted, true);
	f.requests[1]?.resolve("page-b");
	await second;
	f.requests[0]?.resolve("page-a");
	await first;
	assert.deepEqual(f.states.at(-1), { value: "page-b", loading: false, failed: false });
	const third = f.reader.load("older-c");
	assert.equal(f.states.at(-1)?.value, "page-b");
	f.requests[2]?.resolve("page-c");
	await third;
	assert.equal(f.states.at(-1)?.value, "page-c");
});

test("Latest resets held data and aborted history cannot restore it", async () => {
	const f = fixture();
	const pending = f.reader.load("older");
	f.reader.reset();
	f.requests[0]?.resolve("late old history");
	await pending;
	assert.deepEqual(f.states.at(-1), { loading: false, failed: false });
	f.reader.retry();
	assert.equal(f.requests.length, 1);
});

test("explicit cancel preserves current page, terminates loading and suppresses late text", async () => {
	const f = fixture();
	const first = f.reader.load("offset-0");
	f.requests[0]?.resolve("first text page");
	await first;
	const pending = f.reader.load("offset-32768");
	f.reader.cancel();
	f.requests[1]?.resolve("late next text page");
	await pending;
	assert.deepEqual(f.states.at(-1), { value: "first text page", loading: false, failed: false });
});

test("scope disposal blocks old success and failure from publishing into a new store or conversation", async () => {
	for (const reject of [false, true]) {
		const old = fixture();
		const next = fixture();
		const pending = old.reader.load("store-a/conversation-a");
		old.reader.dispose();
		const count = old.states.length;
		const current = next.reader.load("store-b/conversation-b");
		if (reject) old.requests[0]?.reject();
		else old.requests[0]?.resolve("foreign");
		next.requests[0]?.resolve("current");
		await Promise.all([pending, current]);
		assert.equal(old.states.length, count);
		assert.equal(next.states.at(-1)?.value, "current");
		assert.equal(old.requests[0]?.signal.aborted, true);
	}
});

test("failed pages do not retry automatically; explicit retry keeps the exact cursor", async () => {
	const f = fixture();
	const first = f.reader.load("opaque-cursor");
	f.requests[0]?.reject();
	await first;
	assert.equal(f.states.at(-1)?.failed, true);
	assert.equal(f.requests.length, 1);
	f.reader.retry();
	assert.equal(f.requests[1]?.input, "opaque-cursor");
	f.requests[1]?.resolve("retried page");
	await Promise.resolve();
	assert.equal(f.states.at(-1)?.value, "retried page");
	f.reader.dispose();
});

test("late clipboard feedback for an unmounted original page cannot label the replacement page copied", async () => {
	const writes: string[] = [];
	const feedback: boolean[] = [];
	let finish: () => void = () => {};
	const oldPage = new BoundedRead<true, boolean>(
		async () => {
			writes.push("exact first page\n😀");
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return true;
		},
		(state) => {
			if (state.value) feedback.push(state.value);
		},
	);
	const pending = oldPage.load(true);
	oldPage.dispose();
	finish();
	await pending;
	assert.deepEqual(writes, ["exact first page\n😀"]);
	assert.deepEqual(feedback, []);
});
