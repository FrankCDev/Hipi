import assert from "node:assert/strict";
import test from "node:test";
import {
	ACTIVITY_LIMITS,
	type ConversationExecution,
	jsonBytes,
	LIMITS,
	type Message,
	PUBLIC_BLOCK_LIMITS,
	parseFrame,
	parseHistoryPage,
	parseResult,
	RUN_LIMITS,
	type RunResults,
	type Snapshot,
} from "../src/contracts.ts";

const max = Number.MAX_SAFE_INTEGER;
const scope = { workspaceId: "w".repeat(128), conversationId: "c".repeat(128) };
const cursor = "\0".repeat(LIMITS.cursor);
const inputRefs = {
	entryIds: Array.from({ length: RUN_LIMITS.inputRefs }, (_, index) => String(max - 100 + index)),
	total: max,
	omitted: true,
};
const toolCalls = {
	items: [0, 1].map((index) => ({
		contentIndex: max - 2 + index,
		callId: "\0".repeat(256),
		name: "\0".repeat(256),
	})),
	total: max - 1,
};
const publicBlocks = {
	items: [
		{ kind: "text" as const, contentIndex: max - 3, start: 0, end: max },
		...toolCalls.items.map(({ contentIndex }) => ({ kind: "tool" as const, contentIndex })),
	],
	total: max,
	omitted: true,
};
const messages: Message[] = Array.from({ length: LIMITS.historyMessages }, (_, index) => ({
	// Message IDs are opaque strings at this boundary, unlike numeric run/entry IDs.
	id: `${"\0".repeat(255 - index)}\u0001${"\0".repeat(index)}`,
	role: "assistant",
	runId: String(max),
	text: "\0".repeat(LIMITS.messagePreview),
	textLength: max,
	truncated: true,
	interrupted: true,
	streamId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
	toolCalls,
	publicBlocks,
}));
const runResults: RunResults = {
	items: Array.from({ length: RUN_LIMITS.results }, (_, index) => ({
		id: String(max),
		terminalEntryId: String(max - index),
		admittedAtMs: max,
		settledAtMs: max,
		terminalCause: "response",
		settlement: { status: "done" },
		responseMessageId: `${max - 65}_0`,
		inputRefs: { ...inputRefs, entryIds: inputRefs.entryIds.slice(0, 4) },
	})),
	omitted: true,
};
const execution: ConversationExecution = {
	ownerTaskId: String(max),
	run: { id: String(max), admittedAtMs: max, inputRefs },
	submissionIds: Array.from({ length: 64 }, (_, index) => String(max - index)),
	submissionCount: max,
	generation: { attempt: max, deferredPollAt: max },
	blockingCompactionCount: max,
	tools: {
		total: max,
		active: max,
		items: Array.from({ length: 16 }, (_, index) => ({
			taskId: String(max - index),
			callId: "\0".repeat(256),
			name: "\0".repeat(256),
			status: "running",
			anchor: { assistantEntryId: String(max), modelIndex: max, contentIndex: max },
		})),
	},
};
const snapshot: Snapshot = {
	...scope,
	messages,
	partial: "\0".repeat(LIMITS.partialPreview),
	partialLength: max,
	partialTruncated: true,
	partialId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
	running: false,
	historyCursor: cursor,
	execution,
	runResults,
};

/** Reserve every whole per-message envelope, even though no one fixture fills every cap exactly. */
function messageReserve(): number {
	assert.ok(jsonBytes(toolCalls) <= ACTIVITY_LIMITS.summaryBytes);
	assert.ok(jsonBytes(publicBlocks) <= PUBLIC_BLOCK_LIMITS.bytes);
	return (
		LIMITS.historyMessages *
		(ACTIVITY_LIMITS.summaryBytes - jsonBytes(toolCalls) + PUBLIC_BLOCK_LIMITS.bytes - jsonBytes(publicBlocks))
	);
}
function assertBudget(name: string, actual: number, reserved: number): void {
	assert.ok(reserved >= actual);
	assert.ok(reserved <= LIMITS.frameBytes - LIMITS.envelopeBytes, `${name}: ${reserved}`);
}

test("protocol13 full Snapshot frame reserves escaped previews, partial, summaries, blocks, execution and input refs", (t) => {
	const frame = { kind: "snapshot", epoch: "\0".repeat(256), version: max, snapshot };
	assert.deepEqual(parseFrame(frame), frame);
	assert.ok(jsonBytes(runResults) <= RUN_LIMITS.bytes);
	assert.ok(jsonBytes(inputRefs) <= RUN_LIMITS.inputBytes);
	const actual = jsonBytes(frame);
	const reserved =
		actual +
		messageReserve() +
		RUN_LIMITS.bytes -
		jsonBytes(runResults) +
		RUN_LIMITS.inputBytes -
		jsonBytes(inputRefs);
	assertBudget("Snapshot", actual, reserved);
	t.diagnostic(
		`Snapshot actual=${actual}, fully-reserved=${reserved}, payload-limit=${LIMITS.frameBytes - LIMITS.envelopeBytes}`,
	);
});

test("protocol13 full HistoryPage keeps all input refs inside the single 32KiB sidecar budget", (t) => {
	const page = { ...scope, messages, nextCursor: cursor, runResults };
	assert.deepEqual(parseHistoryPage(page), page);
	assert.deepEqual(parseResult("getHistory", page), page);
	const actual = jsonBytes(page);
	const reserved = actual + messageReserve() + RUN_LIMITS.bytes - jsonBytes(runResults);
	assertBudget("History", actual, reserved);
	t.diagnostic(
		`History actual=${actual}, fully-reserved=${reserved}, payload-limit=${LIMITS.frameBytes - LIMITS.envelopeBytes}`,
	);
});

test("protocol13 full SearchHistoryWindow includes a maximal escaped target chunk and both cursors", (t) => {
	const target = {
		...scope,
		messageId: messages[0]!.id,
		text: "\0".repeat(LIMITS.textChunk),
		offset: max - LIMITS.textChunk - 1,
		nextOffset: max - 1,
		textLength: max,
	};
	const window = {
		...scope,
		messages,
		target,
		matchStart: target.offset,
		matchEnd: target.nextOffset,
		olderCursor: cursor,
		newerCursor: cursor,
	};
	assert.deepEqual(parseResult("getHistoryAroundMatch", window), window);
	const actual = jsonBytes(window);
	const reserved = actual + messageReserve();
	assertBudget("Search", actual, reserved);
	t.diagnostic(
		`Search actual=${actual}, fully-reserved=${reserved}, payload-limit=${LIMITS.frameBytes - LIMITS.envelopeBytes}`,
	);
});
