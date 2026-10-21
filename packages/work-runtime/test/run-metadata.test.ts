import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	type EntryId,
	type EntryRecord,
	Harness,
	MemoryStorage,
	type TaskId,
} from "@earendil-works/pi-durable";
import {
	ACTIVITY_LIMITS,
	type ConversationExecution,
	fitsPayloadBudget,
	jsonBytes,
	LIMITS,
	parseFrame,
	parseHistoryPage,
	parseSnapshot,
	RUN_LIMITS,
	type RunResultObservation,
	runWallElapsedMs,
	type Snapshot,
} from "../src/contracts.ts";
import { projectExecution } from "../src/execution/projection.ts";
import { previewMessage, readHistory } from "../src/history.ts";
import { PiWorkspace } from "../src/pi-workspace.ts";
import { parseRunResults } from "../src/runs/contracts.ts";
import { projectRunResult } from "../src/runs/projection.ts";
import { deterministicModels } from "../src/testing.ts";

const scope = { workspaceId: "work", conversationId: "chat" };
function assistant(id: number, overrides: Partial<EntryRecord> = {}): EntryRecord {
	return {
		id: id as EntryId,
		conversationId: 1 as ConversationId,
		kind: "pi.assistant",
		runId: 5 as TaskId,
		model: [fauxAssistantMessage("public")],
		...overrides,
	};
}
function terminal(id: number, answer = id - 1, overrides: Partial<EntryRecord> = {}): EntryRecord {
	return {
		id: id as EntryId,
		conversationId: 1 as ConversationId,
		kind: "pi.run-result",
		runId: 5 as TaskId,
		data: {
			runId: 5,
			admittedAt: 100,
			settledAt: 250,
			terminalCause: "response",
			settlement: { status: "done", answer },
			answerRequestStartedAt: 230,
		},
		...overrides,
	};
}
function history(entries: EntryRecord[]) {
	const reads: { min?: number; max?: number; limit?: number }[] = [];
	const conversation: Pick<Conversation, "entries"> = {
		async entries(filter, limit) {
			reads.push({ min: filter?.minEntryId, max: filter?.maxEntryId, limit });
			const visible = entries
				.filter((entry) => entry.id >= (filter?.minEntryId ?? 0) && entry.id <= (filter?.maxEntryId ?? Infinity))
				.sort((a, b) => b.id - a.id);
			return {
				items: visible.slice(0, limit),
				next: visible.length > (limit ?? Infinity) ? { next: true } : undefined,
			};
		},
	};
	return { conversation, reads };
}
const result: RunResultObservation = {
	id: "5",
	terminalEntryId: "11",
	admittedAtMs: 100,
	settledAtMs: 250,
	terminalCause: "response",
	settlement: { status: "done" },
	responseMessageId: "10_0",
};
const snapshot: Snapshot = {
	...scope,
	messages: [],
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: false,
	historyCursor: null,
};

test("no-tool process and exact final retain membership without disclosing model internals", async () => {
	const process = assistant(9, {
		model: [
			fauxAssistantMessage([
				{ type: "thinking", thinking: "secret reasoning", thinkingSignature: "private signature" },
				{ type: "text", text: "public" },
			]),
		],
	});
	const { conversation } = history([process, assistant(10), terminal(11)]);
	const page = await readHistory(conversation, scope);
	assert.deepEqual(
		page.messages.map((message) => [message.id, message.runId]),
		[
			["9_0", "5"],
			["10_0", "5"],
		],
	);
	assert.deepEqual(page.runResults, { items: [result], omitted: false });
	assert.deepEqual(parseHistoryPage(page), page);
	assert.equal(runWallElapsedMs(result), 150);
	assert.ok(!JSON.stringify(page).includes("secret"));
	assert.ok(!JSON.stringify(page).includes("signature"));
	assert.ok(!JSON.stringify(page).includes("RequestStarted"));
});

test("legacy, host, context-head and multi-model records never acquire guessed membership", () => {
	const entry = assistant(10);
	for (const candidate of [
		{ ...entry, runId: undefined },
		{ ...entry, runId: 0 as TaskId },
		{ ...entry, kind: "host.message" },
		{ ...entry, head: entry.id },
		{ ...entry, model: [...entry.model!, ...entry.model!] },
	])
		assert.equal(previewMessage(candidate, 0)?.runId, undefined);
	assert.equal(
		previewMessage({ ...entry, kind: "pi.user", model: [{ role: "user", timestamp: 0, content: "continue" }] }, 0)
			?.runId,
		"5",
	);
});

test("final proof rejects foreign, missing, interrupted, tool-calling and ambiguous answer records", async () => {
	const entry = assistant(10);
	for (const candidate of [
		undefined,
		{ ...entry, conversationId: 2 as ConversationId },
		{ ...entry, runId: 6 as TaskId },
		{ ...entry, kind: "host.message" },
		{ ...entry, model: [...entry.model!, ...entry.model!] },
		{ ...entry, model: [fauxAssistantMessage("partial", { stopReason: "aborted" })] },
		{
			...entry,
			model: [fauxAssistantMessage([fauxToolCall("tool", { secret: "argument" })], { stopReason: "toolUse" })],
		},
	]) {
		const page = await readHistory(history([...(candidate ? [candidate] : []), terminal(11)]).conversation, scope);
		assert.equal(page.runResults?.items[0]?.responseMessageId, undefined);
		assert.equal(page.runResults?.items[0]?.id, "5");
		assert.ok(!JSON.stringify(page).includes("argument"));
	}
});

test("terminate, handoff and unanswered retain terminal facts without inventing final prose", async () => {
	for (const cause of ["tool-terminate", "tool-handoff", "unanswered"] as const) {
		const marker = terminal(11, 10, {
			data: {
				runId: 5,
				admittedAt: 100,
				settledAt: 250,
				terminalCause: cause,
				settlement:
					cause === "unanswered" ? { status: "unanswered", reason: "aborted" } : { status: "done", answer: 10 },
			},
		});
		const page = await readHistory(history([assistant(10), marker]).conversation, scope);
		assert.equal(page.runResults?.items[0]?.terminalCause, cause);
		assert.equal(page.runResults?.items[0]?.responseMessageId, undefined);
		assert.deepEqual(parseHistoryPage(page), page);
	}
});

test("invalid raw facts are explicitly omitted and inverted clocks remain unknown", async () => {
	const invalid: JsonValue[] = [
		null,
		{ runId: 6 },
		{
			runId: 5,
			admittedAt: NaN,
			settledAt: 250,
			terminalCause: "response",
			settlement: { status: "done", answer: 10 },
		},
		{
			runId: 5,
			admittedAt: 1,
			settledAt: 2,
			terminalCause: "response",
			settlement: { status: "unanswered", reason: "private error" },
		},
	];
	for (const data of invalid) {
		const marker = terminal(11, 10, { data });
		assert.equal(projectRunResult(marker), undefined);
		const page = await readHistory(history([marker]).conversation, scope);
		assert.deepEqual(page.runResults, { items: [], omitted: true });
	}
	const inverse = { ...result, settledAtMs: 90 };
	assert.deepEqual(parseRunResults({ items: [inverse], omitted: false }).items, [inverse]);
	assert.equal(runWallElapsedMs(inverse), undefined);
	assert.equal(runWallElapsedMs({ admittedAtMs: NaN, settledAtMs: 100 }), undefined);
});

test("model-less pages preserve cursors and exact-answer lookup is bounded to 32 targets", async () => {
	const entries = [assistant(1), ...Array.from({ length: 65 }, (_, index) => terminal(100 + index, index + 1))];
	const { conversation, reads } = history(entries);
	const first = await readHistory(conversation, scope);
	assert.equal(first.messages.length, 0);
	assert.equal(first.runResults?.items.length, 64);
	assert.ok(first.nextCursor);
	assert.equal(reads.filter((read) => read.min !== undefined).length, 32);
	assert.ok(reads.every((read) => (read.limit ?? Infinity) <= 64));
	const second = await readHistory(conversation, scope, first.nextCursor);
	assert.equal(second.messages[0]?.id, "1_0");
	assert.equal(second.nextCursor, null);
	assert.equal(second.runResults?.items.length, 1);
});

test("page fences never harvest later terminals and conflicting same-run markers remain evidence", async () => {
	const { conversation } = history([assistant(10), terminal(11), terminal(12)]);
	const before = await readHistory(conversation, scope, undefined, 10);
	assert.equal(before.runResults, undefined);
	const all = await readHistory(conversation, scope);
	assert.equal(all.runResults?.items.length, 2);
	assert.deepEqual(
		all.runResults?.items.map((item) => item.id),
		["5", "5"],
	);
	assert.deepEqual(parseHistoryPage(all), all);
});

test("same committed admission survives owner handover; invalid time omits only time", () => {
	const group = { id: 5 as TaskId, admittedAt: 100 };
	for (const taskId of [5, 20]) {
		const execution = projectExecution({ run: { taskId: taskId as TaskId, inputs: [], group } });
		assert.deepEqual(execution?.run, { id: "5", admittedAtMs: 100 });
		assert.deepEqual(parseSnapshot({ ...snapshot, execution }).execution, execution);
	}
	assert.deepEqual(
		projectExecution({ run: { taskId: 20 as TaskId, inputs: [], group: { ...group, admittedAt: Infinity } } })?.run,
		{ id: "5" },
	);
	assert.equal(projectExecution({ run: { taskId: 20 as TaskId, inputs: [] } })?.run, undefined);
});

test("strict wire rejects excess fields, invalid identities, timing, reasons, and final claims", () => {
	for (const invalid of [
		{ ...result, id: "0" },
		{ ...result, id: "9007199254740992" },
		{ ...result, id: "01" },
		{ ...result, admittedAtMs: -1 },
		{ ...result, settledAtMs: Infinity },
		{ ...result, admittedAtMs: 0.5 },
		{ ...result, terminalCause: "tool-handoff" },
		{ ...result, terminalCause: "unanswered" },
		{ ...result, responseMessageId: "10_1" },
		{ ...result, responseMessageId: "11_0" },
		{ ...result, reasoning: "secret" },
		{ ...result, settlement: { status: "done", answer: "10" } },
	])
		assert.throws(
			() =>
				parseHistoryPage({
					...scope,
					messages: [],
					nextCursor: null,
					runResults: { items: [invalid], omitted: false },
				}),
			{ code: "INVALID_REQUEST" },
		);
	for (const runResults of [
		{ items: [result, result], omitted: false },
		{
			items: Array.from({ length: 65 }, (_, index) => ({ ...result, terminalEntryId: String(index + 11) })),
			omitted: false,
		},
		{ items: [], omitted: "false" },
	])
		assert.throws(() => parseSnapshot({ ...snapshot, runResults }), { code: "INVALID_REQUEST" });
	for (const runId of ["0", "01", 5, "9007199254740992"])
		assert.throws(
			() =>
				parseHistoryPage({
					...scope,
					messages: [{ id: "10_0", role: "assistant", text: "", textLength: 0, truncated: false, runId }],
					nextCursor: null,
				}),
			{ code: "INVALID_REQUEST" },
		);
});

test("worst-case escaped public text, tool summaries, execution and 64 results fit one frame", () => {
	const toolCalls = {
		total: 64,
		items: Array.from({ length: 4 }, (_, contentIndex) => ({
			contentIndex,
			callId: "\0".repeat(150),
			name: "\0".repeat(150),
		})),
	};
	assert.ok(Buffer.byteLength(JSON.stringify(toolCalls)) <= ACTIVITY_LIMITS.summaryBytes);
	const max = Number.MAX_SAFE_INTEGER;
	const execution: ConversationExecution = {
		ownerTaskId: String(max),
		run: { id: String(max), admittedAtMs: max },
		submissionIds: Array.from({ length: 64 }, (_, index) => String(max - index)),
		submissionCount: 64,
		generation: { attempt: max, retryAt: max },
		blockingCompactionCount: max,
		tools: {
			total: 16,
			active: 16,
			items: Array.from({ length: 16 }, (_, index) => ({
				taskId: String(max - index),
				callId: "\0".repeat(256),
				name: "\0".repeat(256),
				status: "running",
				anchor: { assistantEntryId: String(max), modelIndex: max, contentIndex: max },
			})),
		},
	};
	const frame = {
		kind: "snapshot",
		epoch: "epoch",
		version: 1,
		snapshot: {
			...snapshot,
			execution,
			partial: "\0".repeat(LIMITS.partialPreview),
			partialLength: LIMITS.partialPreview,
			messages: Array.from({ length: 32 }, (_, index) => ({
				id: `${index + 1}_0`,
				role: "assistant",
				runId: "5",
				text: "\0".repeat(2048),
				textLength: 2048,
				truncated: false,
				toolCalls,
			})),
			runResults: {
				items: Array.from({ length: 64 }, (_, index) => ({ ...result, terminalEntryId: String(index + 100) })),
				omitted: false,
			},
		},
	};
	assert.ok(fitsPayloadBudget(frame));
	assert.deepEqual(parseFrame(frame), frame);
	assert.ok(Buffer.byteLength(JSON.stringify(frame.snapshot.runResults)) < RUN_LIMITS.bytes);
	// Reserve the FULL sidecar and every summary budget, not merely the fixture's encoded bytes.
	const fullReservedBytes =
		jsonBytes(frame) +
		RUN_LIMITS.bytes -
		jsonBytes(frame.snapshot.runResults) +
		LIMITS.historyMessages * (ACTIVITY_LIMITS.summaryBytes - jsonBytes(toolCalls));
	assert.ok(fullReservedBytes <= LIMITS.frameBytes - LIMITS.envelopeBytes);
	const page = {
		...scope,
		messages: frame.snapshot.messages,
		runResults: frame.snapshot.runResults,
		nextCursor: null,
	};
	assert.deepEqual(parseHistoryPage(page), page);
	assert.ok(
		jsonBytes(page) +
			RUN_LIMITS.bytes -
			jsonBytes(page.runResults) +
			LIMITS.historyMessages * (ACTIVITY_LIMITS.summaryBytes - jsonBytes(toolCalls)) <=
			LIMITS.frameBytes - LIMITS.envelopeBytes,
	);
});

test("actual fast completion is visible without watching; fork at answer excludes same-commit terminal", async () => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: deterministicModels(), registry: createRegistry() },
		context,
	);
	try {
		const conversation = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
			context,
		);
		const settled = await (await conversation.submit({ type: "input", content: "hello" }, context)).wait(context);
		assert.equal(settled.status, "done");
		if (settled.status !== "done") throw new Error("not done");
		assert.ok(settled.answer);
		const page = await readHistory(conversation, scope);
		const observation = page.runResults?.items[0];
		assert.ok(observation);
		assert.equal(observation.responseMessageId, `${settled.answer}_0`);
		assert.ok(runWallElapsedMs(observation) !== undefined);
		const fork = await conversation.fork(settled.answer, { ownership: { kind: "ownerless" } }, context);
		assert.equal((await readHistory(fork, scope)).runResults, undefined);
		const after = await conversation.fork(
			Number(observation.terminalEntryId) as EntryId,
			{ ownership: { kind: "ownerless" } },
			context,
		);
		assert.deepEqual((await readHistory(after, scope)).runResults, page.runResults);
	} finally {
		await harness.close(context);
	}
});

test("PiWorkspace cold snapshot forwards committed terminal facts and exact public answer", async () => {
	const workspace = await PiWorkspace.open(new MemoryStorage(), {
		workspaceId: "work",
		name: "runs",
		models: deterministicModels(),
		model: { provider: "faux", modelId: "faux-1" },
		resume: true,
	});
	try {
		const conversation = await workspace.createConversation({
			workspaceId: "work",
			requestId: "create",
			title: "runs",
		});
		const currentScope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
		await workspace.submit({ ...currentScope, requestId: "submit", text: "hello" });
		const deadline = Date.now() + 10000;
		let final: Snapshot | undefined;
		while (Date.now() < deadline) {
			const current = await workspace.snapshot(currentScope);
			if (current.runResults?.items.length) {
				final = current;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(final);
		assert.deepEqual(parseSnapshot(final), final);
		assert.equal(final.running, false);
		assert.equal(final.runResults?.items[0]?.responseMessageId, final.messages.at(-1)?.id);
	} finally {
		await workspace.close();
	}
});
