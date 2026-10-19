import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryPage, Message, Snapshot } from "@hipi/work-runtime/contracts";
import { ConversationHistoryController } from "../src/features/workbench/conversation-history-controller.ts";

const scope = { workspaceId: "w", conversationId: "c" };
function message(id: string): Message {
	return { id, role: "user", text: id, textLength: id.length, truncated: false };
}
function snapshot(ids: string[], cursor: string | null = null): Snapshot {
	return {
		...scope,
		messages: ids.map(message),
		historyCursor: cursor,
		partial: "",
		partialLength: 0,
		partialTruncated: false,
		running: false,
	};
}
function page(ids: string[], nextCursor: string | null = null): HistoryPage {
	return { ...scope, messages: ids.map(message), nextCursor };
}
function harness() {
	const calls: {
		cursor: string;
		signal: AbortSignal;
		resolve: (page: HistoryPage) => void;
		reject: (error: Error) => void;
	}[] = [];
	let publications = 0;
	const controller = new ConversationHistoryController(
		scope,
		(cursor, signal) => new Promise<HistoryPage>((resolve, reject) => calls.push({ cursor, signal, resolve, reject })),
		() => publications++,
	);
	return { controller, calls, publications: () => publications };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function ids(controller: ConversationHistoryController) {
	return controller.state.snapshot?.messages.map((entry) => entry.id);
}

test("retains older originals, pins older cursor, and consumes nonempty demand before reading again", async () => {
	const { controller, calls } = harness();
	const initial = snapshot(["3", "4"], "old");
	controller.update(initial);
	controller.setNearTop(true);
	controller.setNearTop(true);
	controller.update(snapshot(["4", "5"], "new-fence"));
	assert.equal(calls.length, 1);
	calls[0]?.resolve(page(["1", "2", "3"], "older"));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2", "3", "4", "5"]);
	assert.equal(controller.state.snapshot?.messages[2], initial.messages[0]);
	assert.equal(calls.length, 1);
	controller.setNearTop(true);
	assert.equal(calls[1]?.cursor, "older");
	controller.dispose();
});

test("empty continuation pages advance serially and stop when near-top demand leaves", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot([], "first"));
	controller.setNearTop(true);
	calls[0]?.resolve(page([], "second"));
	await tick();
	assert.equal(calls[1]?.cursor, "second");
	controller.setNearTop(false);
	calls[1]?.resolve(page([], "third"));
	await tick();
	assert.equal(calls.length, 2);
	assert.equal(controller.state.snapshot?.historyCursor, "third");
});

test("gap bridge joins atomically and coalesces newer observations without replacing its fence", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot(["1", "2"], "original"));
	controller.update(snapshot(["6", "7"], "bridge"));
	controller.update(snapshot(["7", "8"], "discarded"));
	controller.update(snapshot(["7", "8", "9"], "latest"));
	assert.equal(controller.state.reconciling, true);
	assert.deepEqual(ids(controller), ["1", "2"]);
	calls[0]?.resolve(page(["4", "5"], "bridge-2"));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2"]);
	assert.equal(calls[1]?.cursor, "bridge-2");
	calls[1]?.resolve(page(["2", "3"], "unused"));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
	assert.equal(controller.state.snapshot?.historyCursor, "original");
	assert.equal(controller.state.reconciling, false);
	assert.equal(calls.length, 2);
});

test("failure blocks scroll and observation retries until explicit retry", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot(["2"], "older"));
	controller.setNearTop(true);
	calls[0]?.reject(new Error("offline"));
	await tick();
	controller.setNearTop(true);
	controller.update(snapshot(["2", "3"], "different"));
	assert.equal(calls.length, 1);
	assert.equal(controller.state.failed, true);
	controller.retry();
	assert.equal(calls[1]?.cursor, "older");
	calls[1]?.resolve(page(["1"]));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2", "3"]);
	assert.equal(controller.state.failed, false);
});

test("bridge exhaustion without retained tail fails without exposing a silent gap", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot(["1", "2"]));
	controller.update(snapshot(["6"], "bridge"));
	calls[0]?.resolve(page(["3", "4", "5"]));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2"]);
	assert.equal(controller.state.failed, true);
	assert.equal(controller.state.reconciling, true);
	controller.retry();
	assert.equal(calls[1]?.cursor, "bridge");
	controller.dispose();
});

test("rejects repeated and cyclic cursors without committing offending pages", async () => {
	for (const repeated of [true, false]) {
		const { controller, calls } = harness();
		controller.update(snapshot(["3"], "a"));
		controller.setNearTop(true);
		calls[0]?.resolve(page([], repeated ? "a" : "b"));
		await tick();
		if (!repeated) {
			calls[1]?.resolve(page(["2"], "a"));
			await tick();
		}
		assert.equal(controller.state.failed, true);
		assert.deepEqual(ids(controller), ["3"]);
		controller.dispose();
	}
});

test("scope mismatch is rejected for live and paginated values", async () => {
	const { controller, calls } = harness();
	assert.throws(() => controller.update({ ...snapshot([]), conversationId: "foreign" }), { code: "INVALID_REQUEST" });
	controller.update(snapshot(["2"], "a"));
	controller.setNearTop(true);
	calls[0]?.resolve({ ...page(["1"]), workspaceId: "foreign" });
	await tick();
	assert.equal(controller.state.failed, true);
	assert.deepEqual(ids(controller), ["2"]);
});

test("dispose aborts and ignores late success or rejection without publication", async () => {
	for (const reject of [false, true]) {
		const { controller, calls, publications } = harness();
		controller.update(snapshot(["2"], "a"));
		controller.setNearTop(true);
		controller.dispose();
		const count = publications();
		assert.equal(calls[0]?.signal.aborted, true);
		if (reject) calls[0]?.reject(new Error("late"));
		else calls[0]?.resolve(page(["1"]));
		await tick();
		assert.equal(publications(), count);
		assert.equal(controller.state.snapshot, undefined);
	}
});

test("empty scan limit needs explicit continuation and preserves cursor-cycle detection", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot([], "c0"));
	controller.setNearTop(true);
	for (let index = 0; index < 16; index++) {
		calls[index]?.resolve(page([], `c${index + 1}`));
		await tick();
	}
	assert.equal(calls.length, 16);
	assert.equal(controller.state.blocked, "scan-limit");
	controller.setNearTop(true);
	assert.equal(calls.length, 16);
	controller.retry();
	assert.equal(calls[16]?.cursor, "c16");
	calls[16]?.resolve(page([], "c0"));
	await tick();
	assert.equal(controller.state.failed, true);
});

test("capacity stops retained growth and reset uses latest observation while guarding obsolete requests", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot(["last"], "c0"));
	for (let index = 0; index < 64; index++) {
		controller.setNearTop(true);
		calls[index]?.resolve(
			page(
				Array.from({ length: 32 }, (_, row) => `${index}-${row}`),
				`c${index + 1}`,
			),
		);
		await tick();
		if (controller.state.capacity) break;
	}
	assert.equal(controller.state.blocked, "capacity");
	assert.ok((controller.state.snapshot?.messages.length ?? 0) <= 2048);
	controller.update(snapshot(["fresh"], "fresh-cursor"));
	controller.resetToLatest();
	assert.deepEqual(ids(controller), ["fresh"]);
	assert.equal(controller.state.blocked, null);
	controller.setNearTop(true);
	const obsolete = calls.at(-1);
	controller.update(snapshot(["fresh", "newest"], "new-cursor"));
	controller.resetToLatest();
	assert.equal(obsolete?.signal.aborted, true);
	obsolete?.resolve(page(["obsolete"]));
	await tick();
	assert.deepEqual(ids(controller), ["fresh", "newest"]);
});

test("an older read and a live gap serialize while preserving both fences", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot(["3", "4"], "older"));
	controller.setNearTop(true);
	controller.update(snapshot(["7"], "bridge"));
	assert.equal(calls.length, 1);
	calls[0]?.resolve(page(["1", "2"], "oldest"));
	await tick();
	assert.equal(calls[1]?.cursor, "bridge");
	assert.deepEqual(ids(controller), ["1", "2", "3", "4"]);
	calls[1]?.resolve(page(["4", "5", "6"], "ignored"));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2", "3", "4", "5", "6", "7"]);
	assert.equal(controller.state.snapshot?.historyCursor, "oldest");
});

test("same empty head does not bridge; a newer fence scans to exhaustion only once", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot([], "empty-fence"));
	controller.update(snapshot([], "empty-fence"));
	assert.equal(calls.length, 0);
	controller.update(snapshot(["2"], "new-fence"));
	calls[0]?.resolve(page(["1"]));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2"]);
	assert.equal(controller.state.snapshot?.historyCursor, null);
	controller.setNearTop(true);
	assert.equal(calls.length, 1);
});

test("bridge staging reaches capacity without exposing or evicting the held history", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot(["held"], "older"));
	controller.update(snapshot(["live"], "bridge-0"));
	for (let index = 0; index < 64; index++) {
		if (controller.state.blocked === "scan-limit") controller.retry();
		calls[index]?.resolve(
			page(
				Array.from({ length: 32 }, (_, row) => `${index}-${row}`),
				`bridge-${index + 1}`,
			),
		);
		await tick();
		if (controller.state.capacity) break;
	}
	assert.equal(controller.state.capacity, true);
	assert.equal(controller.state.reconciling, true);
	assert.deepEqual(ids(controller), ["held"]);
	controller.resetToLatest();
	assert.deepEqual(ids(controller), ["live"]);
});

test("duplicate older page IDs cannot reorder or replace retained final messages", async () => {
	const { controller, calls } = harness();
	const original = snapshot(["2", "3", "4"], "older");
	controller.update(original);
	controller.setNearTop(true);
	calls[0]?.resolve(page(["1", "4", "3"]));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2", "3", "4"]);
	assert.equal(controller.state.snapshot?.messages[2], original.messages[1]);
});

test("an initially empty conversation adopts the first populated snapshot's older cursor", async () => {
	const { controller, calls } = harness();
	controller.update(snapshot([]));
	controller.update(snapshot(["3", "4"], "new-history"));
	assert.equal(controller.state.snapshot?.historyCursor, "new-history");
	controller.setNearTop(true);
	assert.equal(calls[0]?.cursor, "new-history");
	calls[0]?.resolve(page(["1", "2"]));
	await tick();
	assert.deepEqual(ids(controller), ["1", "2", "3", "4"]);
});
