import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Snapshot } from "@hipi/work-runtime/contracts";
import { projectTranscript } from "../../../../src/features/workbench/conversation/transcript.ts";
import { turnMembershipChanged } from "../../../../src/features/workbench/conversation/turns/contracts.ts";
import { projectAuthoritativeTurns } from "../../../../src/features/workbench/conversation/turns/projection.ts";

const user = (id: string): Message => ({ id, role: "user", text: "User", textLength: 4, truncated: false });
const assistant = (id: string, runId = "2"): Message => ({ ...user(id), role: "assistant", runId });
const base = () =>
	({
		workspaceId: "w",
		conversationId: "c",
		messages: [user("1_0"), assistant("3_0"), assistant("8_0")],
		running: false,
		partial: "",
		partialLength: 0,
		partialTruncated: false,
		historyCursor: null,
		runResults: {
			omitted: false,
			items: [
				{
					id: "2",
					terminalEntryId: "9",
					admittedAtMs: 1000,
					settledAtMs: 2000,
					terminalCause: "response",
					settlement: { status: "done" },
					responseMessageId: "8_0",
					inputRefs: { entryIds: ["1"], total: 1, omitted: false },
				},
			],
		},
	}) satisfies Snapshot;
function first<T>(values: readonly T[]): T {
	const value = values[0];
	assert.ok(value);
	return value;
}
const project = (snapshot: Snapshot) => projectAuthoritativeTurns(projectTranscript(snapshot), snapshot);
test("one authoritative turn keeps exact message ordering and stable turn identity", () => {
	const snapshot = base();
	const rows = project(snapshot);
	assert.equal(rows.length, 1);
	const turn = first(rows);
	assert.equal(turn.kind, "turn");
	if (turn.kind !== "turn") throw Error();
	assert.deepEqual(
		turn.children.map((row) => row.message?.id),
		["1_0", "3_0", "8_0"],
	);
	assert.equal(first(project({ ...snapshot, messages: [...snapshot.messages, assistant("10_0")] })).key, "turn:2");
});
test("missing admission metadata does not negate verified run identity; genuine barriers remain fragments", () => {
	const absent = project({ ...base(), runResults: undefined });
	assert.equal(first(absent).kind, "user-message");
	assert.equal(absent[1]?.key, "turn:2");
	const omitted = project({ ...base(), runResults: { ...base().runResults, omitted: true } });
	assert.equal(first(omitted).key, "turn:2");
	for (const messages of [
		[user("1_0"), assistant("3_0"), user("5_0"), assistant("8_0")],
		[user("1_0"), assistant("3_0"), assistant("5_0", "9"), assistant("8_0")],
	]) {
		const rows = project({ ...base(), messages });
		assert(rows.filter((row) => row.kind === "turn").every((row) => row.runId !== "2"));
	}
	const unknown = project({
		...base(),
		runResults: undefined,
		messages: [user("1_0"), { ...assistant("3_0"), runId: undefined }],
	});
	assert(unknown.every((row) => row.kind !== "turn"));
});
test("steering stays in original position and partial remains outside immutable turn", () => {
	const snapshot: Snapshot = base();
	assert.ok(snapshot.runResults);
	snapshot.messages.splice(2, 0, user("5_0"));
	first(snapshot.runResults.items).inputRefs = { entryIds: ["1", "5"], total: 2, omitted: false };
	snapshot.running = true;
	snapshot.partial = "partial";
	snapshot.partialLength = 7;
	const rows = project(snapshot);
	const turn = first(rows);
	assert.equal(turn.kind, "turn");
	if (turn.kind !== "turn") throw Error();
	assert.deepEqual(
		turn.children.map((row) => row.message?.id),
		["1_0", "3_0", "5_0", "8_0"],
	);
	assert.equal(rows[1]?.kind, "assistant-stream");
});
test("conflicting terminals and multiply claimed admissions cannot choose a run", () => {
	const snapshot = base();
	snapshot.runResults.items.push({ ...first(snapshot.runResults.items), terminalEntryId: "10" });
	assert(project(snapshot).every((row) => row.kind !== "turn"));
	const other = base();
	other.runResults.items.push({ ...first(other.runResults.items), id: "7", terminalEntryId: "11" });
	assert(project(other).every((row) => row.kind !== "turn"));
});
test("input outside the page then loaded preserves turn key without absorbing nearest user", () => {
	const snapshot = base();
	const partial = project({ ...snapshot, messages: [user("0_0"), ...snapshot.messages.slice(1)] });
	assert.equal(first(partial).message?.id, "0_0");
	const turn = partial[1];
	assert.ok(turn?.kind === "turn");
	assert.equal(turn.inputCoverage, "partial");
	assert.equal(turn.key, first(project(snapshot)).key);
	assert.deepEqual(
		turn.children.map((row) => row.message?.id),
		["3_0", "8_0"],
	);
});

test("same-view current stream shares the admitted turn and retains its key on exact commit", () => {
	const snapshot: Snapshot = {
		...base(),
		runResults: undefined,
		messages: base().messages.slice(0, 2),
		running: true,
		partialId: "stream-1",
		partial: "Final",
		partialLength: 5,
		execution: {
			ownerTaskId: "4",
			submissionIds: [],
			submissionCount: 0,
			tools: { items: [], total: 0, active: 0 },
			blockingCompactionCount: 0,
			run: { id: "2", inputRefs: { entryIds: ["1"], total: 1, omitted: false } },
		},
	};
	assert.ok(snapshot.execution);
	const rows = project(snapshot);
	assert.equal(rows.length, 1);
	const turn = first(rows);
	assert.equal(turn.kind, "turn");
	if (turn.kind !== "turn") throw Error();
	const key = turn.children.at(-1)?.key;
	assert.equal(turn.children.at(-1)?.kind, "assistant-stream");
	const committed = base();
	committed.messages[2] = { ...assistant("8_0"), streamId: "stream-1" };
	const next = project(committed);
	const nextTurn = first(next);
	assert.equal(nextTurn.key, first(rows).key);
	if (nextTurn.kind !== "turn") throw Error();
	assert.equal(nextTurn.children.at(-1)?.key, key);
	const omitted = project({
		...snapshot,
		execution: { ...snapshot.execution, run: { id: "2", inputRefs: { entryIds: [], total: 1, omitted: true } } },
	});
	assert.equal(first(omitted).message?.id, "1_0");
	const suffix = omitted[1];
	assert.ok(suffix?.kind === "turn");
	assert.equal(suffix.key, "turn:2");
	assert.equal(suffix.inputCoverage, "partial");
	assert.equal(suffix.children.at(-1)?.key, key);
});

test("stable outer turn detects newly paged child membership without treating text refresh as layout admission", () => {
	const snapshot = base();
	const before = project(snapshot);
	const after = project({ ...snapshot, messages: [...snapshot.messages, assistant("10_0")] });
	assert.equal(first(before).key, first(after).key);
	assert.equal(turnMembershipChanged(before, after), true);
	const refreshed = project({
		...snapshot,
		messages: snapshot.messages.map((message) => ({ ...message, text: "updated", textLength: 7 })),
	});
	assert.equal(turnMembershipChanged(before, refreshed), false);
});

test("more than a snapshot page of explicit run members remains one stable partial turn", () => {
	const snapshot = base();
	snapshot.messages = Array.from({ length: 64 }, (_, index) => assistant(`${index + 10}_0`));
	const row = first(project(snapshot));
	assert.ok(row.kind === "turn");
	assert.equal(row.children.length, 64);
	assert.equal(row.inputCoverage, "partial");
	assert.equal(row.key, "turn:2");
});
