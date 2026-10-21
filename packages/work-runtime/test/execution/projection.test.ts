import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
	CompactionResult,
	ConversationId,
	EntryId,
	EntryRecord,
	LiveState,
	SubmissionId,
	TaskId,
} from "@earendil-works/pi-durable";
import { EXECUTION_LIMITS, fitsPayloadBudget, parseFrame, parseSnapshot, type Snapshot } from "../../src/contracts.ts";
import { projectExecution } from "../../src/execution/projection.ts";

const run = { taskId: 1 as TaskId, inputs: [2 as SubmissionId] };
const conversation = { id: 10 as ConversationId };
function toolEntry(live: LiveState, overrides: Partial<EntryRecord> = {}): EntryRecord {
	return {
		id: 20 as EntryId,
		conversationId: conversation.id,
		byTaskId: live.run?.taskId,
		kind: "pi.assistant",
		model: [
			fauxAssistantMessage(
				[
					{ type: "text", text: "prefix" },
					...(live.tools ?? []).map((slot) => fauxToolCall(slot.name, {}, { id: slot.callId })),
				],
				{ stopReason: "toolUse" },
			),
		],
		...overrides,
	};
}
const snapshot: Snapshot = {
	workspaceId: "work",
	conversationId: "chat",
	messages: [],
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: true,
	historyCursor: null,
};
function roundtrip(live: LiveState) {
	const execution = projectExecution(live);
	assert.ok(execution);
	const frame = { kind: "snapshot", epoch: "epoch", version: 1, snapshot: { ...snapshot, execution } };
	assert.ok(fitsPayloadBudget(frame));
	assert.deepEqual(parseFrame(JSON.parse(JSON.stringify(frame))).snapshot.execution, execution);
	return execution;
}

test("projection preserves current ownership, generic generation and independent blocking work without raw content", () => {
	const projected = roundtrip({
		run,
		generation: {
			attempt: 2,
			message: {
				role: "assistant",
				api: "faux",
				provider: "faux",
				model: "faux-1",
				timestamp: 0,
				stopReason: "stop",
				usage: fauxAssistantMessage("").usage,
				content: [{ type: "thinking", thinking: "private", thinkingSignature: "secret" }],
			},
		},
		compactions: [
			{ taskId: 5 as TaskId<CompactionResult>, reason: "threshold", blocking: true, attempt: 1 },
			{ taskId: 6 as TaskId<CompactionResult>, reason: "threshold", blocking: false, attempt: 1 },
		],
	});
	assert.deepEqual(projected, {
		ownerTaskId: "1",
		submissionIds: ["2"],
		submissionCount: 1,
		generation: { attempt: 2 },
		tools: { items: [], total: 0, active: 0 },
		blockingCompactionCount: 1,
	});
	assert.equal(projectExecution({ generation: { attempt: 1 } }), undefined);
	assert.equal(projectExecution(undefined), undefined);
	assert.deepEqual(
		roundtrip({ run, generation: { attempt: 2, retry: { at: 100, error: "secret credential" } } }).generation,
		{ attempt: 2, retryAt: 100 },
	);
	assert.deepEqual(roundtrip({ run, generation: { attempt: 3, deferred: { pollAt: 200 } } }).generation, {
		attempt: 3,
		deferredPollAt: 200,
	});
});

test("only current slots are projected, including unstarted calls and nested identity, never payloads or success claims", () => {
	const execution = roundtrip({
		run,
		tools: [
			{
				taskId: 3 as TaskId,
				callId: "call",
				name: "tool",
				status: "running",
				output: "private",
				details: { token: "secret" },
			},
			{ callId: "not-started", name: "sequential", status: "pending" },
			{ callId: "unavailable", name: "missing", status: "done" },
		],
		nestedTools: [
			{
				taskId: 4 as TaskId,
				parentTaskId: 3 as TaskId,
				parentCallId: "call",
				callId: "call/nested",
				name: "nested",
				status: "running",
				arguments: { secret: "value" },
			},
		],
	});
	assert.deepEqual(execution.tools, {
		total: 4,
		active: 3,
		items: [
			{ taskId: "3", callId: "call", name: "tool", status: "running" },
			{ callId: "not-started", name: "sequential", status: "pending" },
			{ callId: "unavailable", name: "missing", status: "done" },
			{ taskId: "4", parentTaskId: "3", callId: "call/nested", name: "nested", status: "running" },
		],
	});
});

test("oversized runs and labels retain complete counts without truncating correlation identities", () => {
	const execution = roundtrip({
		run: { ...run, inputs: Array.from({ length: 1000 }, (_, i) => (i + 2) as SubmissionId) },
		tools: Array.from({ length: 1000 }, (_, i) => ({
			taskId: (i + 3) as TaskId,
			callId: i === 0 ? "x".repeat(10000) : `call-${i}`,
			name: "tool",
			status: i % 2 ? "running" : "done",
		})),
	});
	assert.equal(execution.submissionIds.length, EXECUTION_LIMITS.submissions);
	assert.equal(execution.submissionCount, 1000);
	assert.equal(execution.tools.items.length, EXECUTION_LIMITS.tools);
	assert.equal(execution.tools.total, 1000);
	assert.equal(execution.tools.active, 500);
	assert.equal(execution.tools.items[0]?.callId, "call-1");
	assert.ok(JSON.stringify(execution).length < 12000);
});

test("wire rejects unknown, oversized, ambiguous and inconsistent execution metadata", () => {
	const execution = roundtrip({ run });
	const tool = { taskId: "3", callId: "call", name: "tool", status: "running" };
	for (const invalid of [
		{ ...execution, reasoning: true },
		{ ...execution, ownerTaskId: "0" },
		{ ...execution, ownerTaskId: "9007199254740992" },
		{ ...execution, submissionIds: ["2", "2"], submissionCount: 2 },
		{ ...execution, submissionCount: 2 },
		{ ...execution, submissionIds: Array.from({ length: 65 }, (_, i) => String(i + 1)), submissionCount: 65 },
		{ ...execution, generation: { attempt: 0 } },
		{ ...execution, generation: { attempt: 1, retryAt: 1, deferredPollAt: 2 } },
		{ ...execution, generation: { attempt: 1, error: "private" } },
		{ ...execution, blockingCompactionCount: -1 },
		{ ...execution, tools: { total: 1, active: 0, items: [tool] } },
		{ ...execution, tools: { total: 1, active: 2, items: [] } },
		{ ...execution, tools: { total: 2, active: 2, items: [tool, tool] } },
		{ ...execution, tools: { total: 1, active: 1, items: [{ ...tool, output: "private" }] } },
		{ ...execution, tools: { total: 1, active: 1, items: [{ ...tool, callId: "x".repeat(257) }] } },
	])
		assert.throws(() => parseSnapshot({ ...snapshot, execution: invalid }), { code: "INVALID_REQUEST" });
	assert.deepEqual(parseSnapshot({ ...snapshot, running: false, execution }).execution, execution);
});

test("same-view anchors include uninstantiated sequential and unavailable slots but never nested calls", () => {
	const live: LiveState = {
		run,
		tools: [
			{ taskId: 3 as TaskId, callId: "first", name: "tool", status: "running" },
			{ callId: "later", name: "tool", status: "pending" },
			{ callId: "missing", name: "missing", status: "done" },
		],
		nestedTools: [
			{
				taskId: 4 as TaskId,
				parentTaskId: 3 as TaskId,
				parentCallId: "first",
				arguments: {},
				callId: "nested",
				name: "tool",
				status: "running",
			},
		],
	};
	const execution = projectExecution(live, { conversation, entries: [toolEntry(live)] });
	assert.deepEqual(
		execution?.tools.items.map((tool) => tool.anchor),
		[
			{ assistantEntryId: "20", modelIndex: 0, contentIndex: 1 },
			{ assistantEntryId: "20", modelIndex: 0, contentIndex: 2 },
			{ assistantEntryId: "20", modelIndex: 0, contentIndex: 3 },
			undefined,
		],
	);
	assert.deepEqual(parseSnapshot({ ...snapshot, execution }).execution, execution);
	assert.deepEqual(projectExecution(live, { conversation, entries: [toolEntry(live)] }), execution);
});

test("anchor proof fails closed across missing, foreign, ambiguous, changed-owner and multi-model rounds", () => {
	const live: LiveState = { run, tools: [{ callId: "repeated", name: "tool", status: "pending" }] };
	const entry = toolEntry(live);
	for (const entries of [
		[],
		[{ ...entry, conversationId: 99 as ConversationId }],
		[{ ...entry, byTaskId: 99 as TaskId }],
		[entry, { ...entry, id: 21 as EntryId }],
		[{ ...entry, model: [...entry.model!, ...entry.model!] }],
		[{ ...entry, head: entry.id }],
		[
			{
				...entry,
				model: [fauxAssistantMessage([fauxToolCall("other", {}, { id: "repeated" })], { stopReason: "toolUse" })],
			},
		],
	]) {
		assert.equal(projectExecution(live, { conversation, entries })?.tools.items[0]?.anchor, undefined);
	}
	const old = { ...entry, byTaskId: 99 as TaskId, id: 19 as EntryId };
	assert.equal(
		projectExecution(live, { conversation, entries: [old, entry] })?.tools.items[0]?.anchor?.assistantEntryId,
		"20",
	);
	assert.equal(
		projectExecution({ ...live, run: { ...run, taskId: 100 as TaskId } }, { conversation, entries: [entry] })?.tools
			.items[0]?.anchor,
		undefined,
	);
	assert.equal(projectExecution({ tools: live.tools }, { conversation, entries: [entry] }), undefined);
});

test("proof checks the full round before bounded projection and anchor metadata remains byte bounded", () => {
	const live: LiveState = {
		run,
		tools: Array.from({ length: 1000 }, (_, index) => ({ callId: `call-${index}`, name: "tool", status: "pending" })),
	};
	const entry = toolEntry(live);
	const execution = projectExecution(live, { conversation, entries: [entry] });
	assert.equal(execution?.tools.items.length, 16);
	assert.equal(execution?.tools.items[15]?.anchor?.contentIndex, 16);
	assert.ok(fitsPayloadBudget({ ...snapshot, execution }));
	assert.ok(Buffer.byteLength(JSON.stringify(execution)) < 12000);
	const changed = {
		...live,
		tools: live.tools?.map((slot, index) => (index === 999 ? { ...slot, callId: "different" } : slot)),
	};
	assert.ok(projectExecution(changed, { conversation, entries: [entry] })?.tools.items.every((tool) => !tool.anchor));
	for (const anchor of [
		{ assistantEntryId: "0", modelIndex: 0, contentIndex: 0 },
		{ assistantEntryId: "20", modelIndex: -1, contentIndex: 0 },
		{ assistantEntryId: "20", modelIndex: 0, contentIndex: Number.MAX_SAFE_INTEGER + 1 },
		{ assistantEntryId: "20", modelIndex: 0, contentIndex: 0, payload: "secret" },
	]) {
		assert.throws(() =>
			parseSnapshot({
				...snapshot,
				execution: {
					...execution,
					tools: { total: 1, active: 1, items: [{ callId: "call", name: "tool", status: "pending", anchor }] },
				},
			}),
		);
	}
});
