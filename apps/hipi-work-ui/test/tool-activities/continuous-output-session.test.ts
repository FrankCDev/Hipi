import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	type Params,
	parseResult,
	type ToolActivity,
	type ToolActivityTextPage,
} from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import {
	ACTIVITY_OUTPUT_BYTES,
	ActivityOutputSession,
	type ActivityOutputSlot,
	OUTPUT_WINDOW_CHUNKS,
} from "../../src/features/tool-activities/output-session.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const item = (id: string): ToolActivity => ({
	activityId: id,
	callId: id,
	toolName: "read",
	source: "entry",
	inherited: false,
	phase: "terminal",
	toolResult: "success",
	abortRequested: false,
	receiptIds: [],
	textAvailable: true,
	outputTruncated: false,
});
function fixture(ids = ["1"]) {
	const calls: { id: string; index: number; signal?: AbortSignal }[] = [];
	let snapshots: ReadonlyMap<string, ActivityOutputSlot> = new Map();
	let fail = false;
	let defer = false;
	let huge = false;
	let next: (index: number) => string | null = (index) => (index < 79 ? String(index + 1) : null);
	const pending: { resolve: (page: ToolActivityTextPage) => void; page: ToolActivityTextPage }[] = [];
	const client: AppClient = {
		async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) {
			assert.equal(method, "getToolActivityText", "Scrolling cannot execute a tool or read the current file");
			const input = params as Params<"getToolActivityText">;
			const index = input.cursor === undefined ? 0 : Number(input.cursor);
			calls.push({ id: input.activityId, index, signal });
			if (fail) throw new Error("retention expired");
			const page: ToolActivityTextPage = {
				activityId: input.activityId,
				text: huge ? "\u0000".repeat(8192) : `part-${index}`,
				nextCursor: next(index),
				retainedOutputOnly: true,
				...(huge && index === 0
					? {
							presentation: {
								version: 1,
								target: { rootId: "r", path: "file.txt" },
								result: {
									kind: "read",
									revision: "a".repeat(64),
									text: "\u0000".repeat(8192),
									offset: 0,
									nextOffset: null,
									textLength: 8192,
								},
							},
						}
					: {}),
			};
			return parseResult(
				method,
				defer ? await new Promise<ToolActivityTextPage>((resolve) => pending.push({ resolve, page })) : page,
			);
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const session = new ActivityOutputSession(client, { workspaceId: "w", conversationId: "c" }, (slots) => {
		snapshots = slots;
		assert.ok(slots.size <= 16);
		let bytes = 0;
		for (const slot of slots.values()) {
			assert.ok((slot.chunks?.length ?? 0) <= OUTPUT_WINDOW_CHUNKS);
			for (const chunk of slot.chunks ?? []) bytes += new TextEncoder().encode(JSON.stringify(chunk.page)).byteLength;
			assert.ok(!slot.page || slot.chunks?.some((chunk) => chunk.page === slot.page));
		}
		assert.ok(bytes <= ACTIVITY_OUTPUT_BYTES, `wire payload ${bytes} exceeded shared budget`);
	});
	session.activate();
	session.validate(ids.map(item));
	return {
		session,
		calls,
		pending,
		snapshot: () => snapshots,
		fail: (value: boolean) => {
			fail = value;
		},
		defer: (value: boolean) => {
			defer = value;
		},
		huge: () => {
			huge = true;
		},
		next: (value: typeof next) => {
			next = value;
		},
	};
}
test("first expansion reads one chunk; forward scroll remains bounded and old cursors reconstruct only on demand", async () => {
	const f = fixture();
	const release = f.session.lease(Symbol(), ["1"]);
	await tick();
	assert.deepEqual(
		f.calls.map((call) => call.index),
		[0],
	);
	for (let index = 1; index <= 40; index++) {
		f.session.reveal("1", index);
		await tick();
	}
	assert.deepEqual(
		f
			.snapshot()
			.get("1")
			?.chunks?.map((chunk) => chunk.index),
		[38, 39, 40],
	);
	assert.equal(f.calls.length, 41);
	f.session.reveal("1", 5);
	await tick();
	assert.deepEqual(
		f.calls.slice(41).map((call) => call.index),
		[0, 1, 2, 3, 4, 5],
	);
	assert.ok(
		f
			.snapshot()
			.get("1")
			?.chunks?.some((chunk) => chunk.index === 5),
	);
	assert.equal(f.snapshot().get("1")?.end, undefined, "unread tail is not complete");
	release();
	f.session.dispose();
});
test("visible and selected chunks are pinned; resource pressure waits instead of replacing what is being read", async () => {
	const f = fixture();
	const owner = Symbol();
	const release = f.session.lease(owner, ["1"]);
	await tick();
	f.session.reveal("1", 1);
	await tick();
	f.session.reveal("1", 2);
	await tick();
	f.session.viewport(owner, { activityId: "1", indices: [0, 1, 2], visible: true, selected: false });
	f.session.reveal("1", 3);
	await tick();
	assert.equal(f.calls.length, 3);
	assert.deepEqual(
		f
			.snapshot()
			.get("1")
			?.chunks?.map((chunk) => chunk.index),
		[0, 1, 2],
	);
	f.session.viewport(owner, { activityId: "1", indices: [2], visible: true, selected: true });
	await tick();
	assert.equal(f.calls.length, 3);
	f.session.viewport(owner, { activityId: "1", indices: [2], visible: true, selected: false });
	await tick();
	assert.deepEqual(
		f
			.snapshot()
			.get("1")
			?.chunks?.map((chunk) => chunk.index),
		[1, 2, 3],
	);
	release();
	f.session.dispose();
});
test("hidden and selected readers abort in-flight reads; visibility release resumes exactly one demand", async () => {
	const f = fixture();
	const owner = Symbol();
	const release = f.session.lease(owner, ["1"]);
	await tick();
	f.defer(true);
	f.session.reveal("1", 1);
	await tick();
	f.session.viewport(owner, { activityId: "1", indices: [0], visible: false, selected: false });
	assert.equal(f.calls.at(-1)?.signal?.aborted, true);
	f.pending[0]?.resolve(f.pending[0].page);
	await tick();
	assert.deepEqual(
		f
			.snapshot()
			.get("1")
			?.chunks?.map((chunk) => chunk.index),
		[0],
	);
	assert.equal(f.calls.length, 2);
	f.session.viewport(owner, { activityId: "1", indices: [0], visible: true, selected: true });
	await tick();
	assert.equal(f.calls.length, 2);
	f.defer(false);
	f.session.viewport(owner, { activityId: "1", indices: [0], visible: true, selected: false });
	await tick();
	assert.equal(f.calls.length, 3);
	assert.deepEqual(
		f
			.snapshot()
			.get("1")
			?.chunks?.map((chunk) => chunk.index),
		[0, 1],
	);
	release();
	f.session.dispose();
});
test("16 consumers share the original wire byte ceiling even with huge escaped text and presentation", async () => {
	const ids = Array.from({ length: 16 }, (_, index) => String(index));
	const f = fixture(ids);
	f.huge();
	const release = f.session.lease(Symbol(), ids);
	await tick();
	for (let index = 1; index <= 4; index++)
		for (const id of ids) {
			f.session.reveal(id, index);
			await tick();
		}
	assert.equal(f.snapshot().size, 16);
	assert.ok([...f.snapshot().values()].every((slot) => !slot.failed));
	assert.equal(ACTIVITY_OUTPUT_BYTES, 2229584);
	release();
	f.session.dispose();
});
test("failed restoration keeps visible evidence and explicit retry; cursor cycles never claim the tail is complete", async () => {
	const f = fixture();
	const owner = Symbol();
	const release = f.session.lease(owner, ["1"]);
	await tick();
	f.session.viewport(owner, { activityId: "1", indices: [0], visible: true, selected: false });
	const first = f.snapshot().get("1")?.chunks?.[0];
	f.fail(true);
	f.session.reveal("1", 1);
	await tick();
	assert.equal(f.snapshot().get("1")?.chunks?.[0], first);
	assert.equal(f.snapshot().get("1")?.failed, true);
	f.session.reveal("1", 1);
	await tick();
	assert.equal(f.calls.length, 2);
	f.fail(false);
	f.session.retry("1");
	await tick();
	assert.equal(f.calls.at(-1)?.index, 1);
	f.next(() => "2");
	f.session.reveal("1", 2);
	await tick();
	assert.equal(f.snapshot().get("1")?.failed, true);
	assert.equal(f.snapshot().get("1")?.end, undefined);
	release();
	f.session.dispose();
});
test("metadata may contain 48 members while leases still allocate only 16 output slots", async () => {
	const ids = Array.from({ length: 48 }, (_, index) => String(index));
	const f = fixture(ids);
	const first = f.session.lease(Symbol(), ids.slice(0, 16));
	const second = f.session.lease(Symbol(), ids.slice(32));
	await tick();
	assert.equal(f.snapshot().size, 16);
	assert.equal(f.calls.length, 16);
	first();
	await tick();
	assert.equal(f.snapshot().size, 16);
	assert.ok(f.snapshot().has("47"));
	second();
	f.session.dispose();
});

test("a response received during selection waits without another request or premature publication", async () => {
	const f = fixture();
	const owner = Symbol();
	f.defer(true);
	const release = f.session.lease(owner, ["1"]);
	await tick();
	f.session.viewport(owner, { activityId: "1", indices: [], visible: true, selected: true });
	f.pending[0]?.resolve(f.pending[0].page);
	await tick();
	assert.equal(f.snapshot().get("1")?.page, undefined);
	assert.equal(f.calls.length, 1);
	f.session.viewport(owner, { activityId: "1", indices: [], visible: true, selected: false });
	await tick();
	assert.equal(f.snapshot().get("1")?.page?.text, "part-0");
	assert.equal(f.calls.length, 1);
	release();
	f.session.dispose();
});

test("a verified terminal cursor stops reads, and foreign or unvisited requests do not expand history", async () => {
	const f = fixture();
	f.next(() => null);
	const release = f.session.lease(Symbol(), ["1"]);
	await tick();
	assert.equal(f.snapshot().get("1")?.end, 0);
	f.session.reveal("1", 1);
	f.session.read("1", "foreign");
	f.session.reveal("other", 0);
	await tick();
	assert.equal(f.calls.length, 1);
	release();
	f.session.dispose();
});

test("a pin-blocked reader cannot starve another activity's first visible output", async () => {
	const f = fixture(["1", "2"]);
	const owner = Symbol();
	const release = f.session.lease(owner, ["1"]);
	await tick();
	f.session.reveal("1", 1);
	await tick();
	f.session.reveal("1", 2);
	await tick();
	f.session.viewport(owner, { activityId: "1", indices: [0, 1, 2], visible: true, selected: false });
	f.session.reveal("1", 3);
	const second = f.session.lease(Symbol(), ["2"]);
	await tick();
	assert.equal(f.snapshot().get("1")?.busy, true);
	assert.equal(f.snapshot().get("2")?.page?.text, "part-0");
	release();
	second();
	f.session.dispose();
});
