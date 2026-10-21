import assert from "node:assert/strict";
import {
	type AppClient,
	type FilePresentation,
	type Method,
	type Params,
	parseResult,
	type ToolActivity,
	type ToolActivityTextPage,
} from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { ActivitySession } from "../../src/features/tool-activities/activity-session.ts";
import { ACTIVITY_OUTPUT_BYTES } from "../../src/features/tool-activities/output-session.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function item(id: string): ToolActivity {
	return {
		activityId: id,
		taskId: id,
		callId: id,
		toolName: "read",
		source: "task",
		inherited: false,
		phase: "terminal",
		toolResult: "success",
		abortRequested: false,
		receiptIds: [],
		textAvailable: true,
		outputTruncated: false,
	};
}
function fixture() {
	let items = [item("1"), item("2")];
	let defer = false;
	let fail = false;
	let presentation: FilePresentation | undefined;
	let content = (id: string) => `output ${id}`;
	const calls: { method: Method; id?: string; cursor?: string }[] = [];
	const pending: { resolve: (page: ToolActivityTextPage) => void; signal?: AbortSignal; id: string }[] = [];
	const client: AppClient = {
		async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) {
			const args = params as Params<"getToolActivityText">;
			calls.push({ method, id: args.activityId, cursor: args.cursor });
			if (method === "getToolActivities")
				return parseResult(method, { items, nextCursor: null, coverage: "tasks", membershipFence: "f" });
			if (fail) throw new Error("offline");
			const result: ToolActivityTextPage = {
				activityId: args.activityId,
				text: args.cursor ? "next output" : content(args.activityId),
				nextCursor: args.cursor ? null : "next",
				retainedOutputOnly: true,
				...(presentation && !args.cursor ? { presentation } : {}),
			};
			if (defer)
				return parseResult(
					method,
					await new Promise<ToolActivityTextPage>((resolve) => pending.push({ resolve, signal, id: args.activityId })),
				);
			return parseResult(method, result);
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const session = new ActivitySession(client, { workspaceId: "w", conversationId: "c" });
	session.activate();
	return {
		session,
		calls,
		pending,
		setItems(value: ToolActivity[]) {
			items = value;
		},
		defer(value: boolean) {
			defer = value;
		},
		fail(value: boolean) {
			fail = value;
		},
		presentation(value: FilePresentation) {
			presentation = value;
		},
		content(value: (id: string) => string) {
			content = value;
		},
	};
}
test("verified multi-output leases share a slot and preserve other consumers when one closes", async () => {
	const f = fixture();
	await f.session.page();
	const inline = f.session.outputs.lease(Symbol(), ["1", "2", "foreign"]);
	const dialog = f.session.outputs.lease(Symbol(), ["1"]);
	await tick();
	assert.equal(f.session.snapshot().outputs?.size, 2);
	assert.equal(f.calls.filter((call) => call.method === "getToolActivityText").length, 2);
	const first = f.session.snapshot().outputs?.get("1")?.page;
	inline();
	assert.equal(f.session.snapshot().outputs?.size, 1);
	assert.equal(f.session.snapshot().outputs?.get("1")?.page, first);
	dialog();
	assert.equal(f.session.snapshot().outputs?.size, 0);
	const reopen = f.session.outputs.lease(Symbol(), ["1"]);
	await tick();
	assert.equal(f.calls.filter((call) => call.method === "getToolActivityText").length, 3);
	reopen();
	f.session.dispose();
});
test("a pending output cannot starve metadata; disconnect retains data and validates membership before resume", async () => {
	const f = fixture();
	await f.session.page();
	const keep = f.session.outputs.lease(Symbol(), ["1"]);
	await tick();
	const page = f.session.snapshot().outputs?.get("1")?.page;
	f.defer(true);
	f.session.outputs.read("1", "next");
	await tick();
	assert.equal(f.pending.length, 1);
	await f.session.page();
	assert.equal(f.calls.filter((call) => call.method === "getToolActivities").length, 2);
	f.session.cancel();
	assert.equal(f.pending[0]?.signal?.aborted, true);
	assert.equal(f.session.snapshot().outputs?.get("1")?.page, page);
	f.session.outputs.read("1", "next");
	assert.equal(f.pending.length, 1);
	f.setItems([item("2")]);
	await f.session.page();
	assert.equal(f.session.snapshot().outputs?.has("1"), false);
	f.pending[0]?.resolve({ activityId: "1", text: "late", nextCursor: null, retainedOutputOnly: true });
	await tick();
	assert.equal(f.session.snapshot().outputs?.has("1"), false);
	keep();
	f.session.dispose();
});
test("failed next output keeps the displayed page and cursor, retry remains per activity", async () => {
	const f = fixture();
	await f.session.page();
	const release = f.session.outputs.lease(Symbol(), ["1", "2"]);
	await tick();
	const first = f.session.snapshot().outputs?.get("1")?.page;
	f.fail(true);
	f.session.outputs.read("1", "next");
	await tick();
	assert.equal(f.session.snapshot().outputs?.get("1")?.page, first);
	assert.equal(f.session.snapshot().outputs?.get("1")?.cursor, undefined);
	assert.equal(f.session.snapshot().outputs?.get("1")?.failed, true);
	assert.equal(f.session.snapshot().outputs?.get("2")?.failed, false);
	f.fail(false);
	f.session.outputs.retry("1");
	await tick();
	assert.equal(f.session.snapshot().outputs?.get("1")?.cursor, "next");
	release();
	f.session.dispose();
});
test("output slots obey verified page and serialized-byte budgets; disposal fences late completion", async () => {
	const f = fixture();
	f.setItems(Array.from({ length: 16 }, (_, i) => item(String(i + 1))));
	f.content(() => "\u0000".repeat(8192));
	f.presentation({
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
	});
	await f.session.page();
	const release = f.session.outputs.lease(
		Symbol(),
		Array.from({ length: 20 }, (_, i) => String(i + 1)),
	);
	await tick();
	const slots = f.session.snapshot().outputs;
	assert.equal(slots?.size, 16);
	const bytes = [...(slots?.values() ?? [])].reduce(
		(total, slot) => total + (slot.page ? new TextEncoder().encode(JSON.stringify(slot.page)).byteLength : 0),
		0,
	);
	assert.ok(bytes <= ACTIVITY_OUTPUT_BYTES);
	assert.equal(ACTIVITY_OUTPUT_BYTES, 2229584);
	assert.ok([...(slots?.values() ?? [])].every((slot) => !!slot.page?.presentation && !slot.failed));
	release();
	f.defer(true);
	const hold = f.session.outputs.lease(Symbol(), ["1"]);
	await tick();
	f.session.dispose();
	f.pending[0]?.resolve({ activityId: "1", text: "late", nextCursor: null, retainedOutputOnly: true });
	await tick();
	assert.equal(f.session.snapshot().outputs, undefined);
	hold();
});

test("lease replacement and immutable snapshots fence a late cancelled output within the same owner", async () => {
	const f = fixture();
	await f.session.page();
	f.defer(true);
	const owner = Symbol();
	const firstRelease = f.session.outputs.lease(owner, ["1"]);
	await tick();
	const before = f.session.snapshot().outputs;
	const secondRelease = f.session.outputs.lease(owner, ["2"]);
	firstRelease();
	await tick();
	assert.equal(f.pending[0]?.signal?.aborted, true);
	assert.equal(before?.has("1"), true, "published snapshots are never mutated in place");
	assert.equal(f.session.snapshot().outputs?.has("1"), false);
	assert.equal(f.session.snapshot().outputs?.has("2"), true, "old lease cleanup cannot release its replacement");
	f.pending[0]?.resolve({ activityId: "1", text: "stale", nextCursor: null, retainedOutputOnly: true });
	f.pending[1]?.resolve({ activityId: "2", text: "current", nextCursor: null, retainedOutputOnly: true });
	await tick();
	assert.equal(f.session.snapshot().outputs?.get("2")?.page?.text, "current");
	assert.equal(f.session.snapshot().outputs?.has("1"), false);
	secondRelease();
	f.session.dispose();
});
