import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord, TaskId } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {
	filePresentationDetails,
	parseFilePresentation,
	parseFileSummary,
	summarizeFilePresentation,
} from "../src/activities/file-presentation.ts";
import { projectFilePresentation } from "../src/activities/file-projection.ts";
import { projectTask, type StoredTask } from "../src/activities/projection.ts";
import { readToolActivities, readToolActivityText } from "../src/activities/storage.ts";
import { fitsPayloadBudget, parseResult, TOOL_ACTIVITY_TEXT_PAGE_BYTES } from "../src/contracts.ts";

const target = { rootId: "root", path: "note.txt" };
const read = {
	kind: "read" as const,
	revision: "a".repeat(64),
	text: "retained",
	offset: 0,
	nextOffset: null,
	textLength: 8,
};
const value = { version: 1 as const, target, result: read };
const task: StoredTask = {
	id: 20 as StoredTask["id"],
	conversationId: 1 as ConversationId,
	kind: "pi.tool",
	version: 2,
	input: { kind: "model", assistant: 10, callId: "call" },
	background: false,
	abortRequested: false,
	state: { status: "terminal", outcome: { status: "completed", result: { kind: "model", entryId: 30 } } },
};
const assistant: EntryRecord = {
	id: 10 as EntryId,
	conversationId: task.conversationId,
	kind: "pi.assistant",
	model: [fauxAssistantMessage([fauxToolCall("hipi_files_read", target, { id: "call" })], { stopReason: "toolUse" })],
};
const entry: EntryRecord = {
	id: 30 as EntryId,
	conversationId: task.conversationId,
	kind: "pi.tool-result",
	byTaskId: task.id,
	data: { diagnostics: [] },
	model: [
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "hipi_files_read",
			isError: false,
			timestamp: 0,
			content: [{ type: "text", text: "raw fallback" }],
			details: { hipiFiles: value },
		},
	],
};
const scope = { storeId: "store", workspaceId: "work", conversationId: "chat", durableId: 1, generation: "generation" };

test("compact schemas reject malformed and oversized payloads, and omit retained read or directory bodies", () => {
	const activity = projectTask(task, assistant, entry);
	for (const [result, partial] of [
		[read, false],
		[{ ...read, textLength: 9, nextOffset: 8 }, true],
		[{ ...read, offset: 1, textLength: 9 }, true],
	] as const)
		assert.deepEqual(summarizeFilePresentation({ ...value, result }, activity), {
			version: 1,
			target,
			kind: "read",
			partial,
		});
	for (const hasMore of [true, false]) {
		const summary = summarizeFilePresentation(
			{
				...value,
				target: { ...target, path: "" },
				result: {
					kind: "directory",
					entries: [{ name: "PRIVATE_ENTRY", path: "PRIVATE_ENTRY", kind: "file" }],
					hasMore,
				},
			},
			{ ...activity, toolName: "hipi_files_list" },
		);
		assert.deepEqual(summary, { version: 1, target: { ...target, path: "" }, kind: "directory", partial: hasMore });
		assert.equal(JSON.stringify(summary).includes("PRIVATE_ENTRY"), false);
	}
	for (const invalid of [null, [], {}, { version: 1, target, kind: "read", partial: false, text: "x".repeat(8192) }])
		assert.throws(() => parseFileSummary(invalid));
});

test("metadata proof reuses only the existing two entry reads and never includes retained bodies", async () => {
	const storage = new MemoryStorage();
	await storage.commit(
		[
			{ type: "conversation", value: { id: task.conversationId } },
			{ type: "entry", value: assistant },
			{ type: "task", value: task },
			{ type: "entry", value: entry },
		],
		context,
	);
	const entryRead = mock.method(storage, "entry");
	const page = await readToolActivities(storage, scope);
	assert.deepEqual(
		entryRead.mock.calls.map((call) => call.arguments[1]),
		[10, 30],
	);
	assert.deepEqual(page.items[0]?.fileSummary, { version: 1, target, kind: "read", partial: false });
	assert.deepEqual(parseResult("getToolActivities", page), page);
	assert.equal(JSON.stringify(page).includes("retained"), false);
	assert.equal(JSON.stringify(page).includes("raw fallback"), false);
	entryRead.mock.resetCalls();
	await readToolActivities(storage, scope, undefined, { kind: "tasks", taskIds: ["20"] });
	// Existing exact-selection visibility checks the assistant once, before taskActivity loads its two records.
	assert.deepEqual(
		entryRead.mock.calls.map((call) => call.arguments[1]),
		[10, 10, 30],
	);
	await storage.commit(
		[
			{
				type: "conversation",
				value: {
					id: 60 as ConversationId,
					parent: { conversationId: task.conversationId, at: entry.id },
				},
			},
		],
		context,
	);
	const fork = { ...scope, durableId: 60, conversationId: "fork" };
	const first = await readToolActivities(storage, fork);
	assert.ok(first.nextCursor);
	const inherited = await readToolActivities(storage, fork, first.nextCursor);
	assert.equal(inherited.items[0]?.inherited, true);
	assert.equal(inherited.items[0]?.fileSummary, undefined);
});

test("metadata never promotes failed, incomplete, nested, unlinked or mismatched retained evidence", async () => {
	const message = entry.model?.[0];
	if (message?.role !== "toolResult") throw new Error("fixture");
	const cases: { task?: StoredTask; assistant?: EntryRecord; entry?: EntryRecord; omitAssistant?: boolean }[] = [
		{ omitAssistant: true },
		{ task: { ...task, state: { status: "running", checkpoint: null } } },
		{
			task: {
				...task,
				state: {
					status: "terminal",
					outcome: { status: "failed", error: { message: "failure" }, result: { kind: "model", entryId: 30 } },
				},
			},
		},
		{
			task: {
				...task,
				input: { kind: "nested", parent: 2, call: { id: "call", name: "hipi_files_read", arguments: target } },
			},
		},
		{ entry: { ...entry, byTaskId: 99 as TaskId } },
		{ entry: { ...entry, model: [{ ...message, isError: true }] } },
		{ entry: { ...entry, model: [{ ...message, toolCallId: "other" }] } },
		{ entry: { ...entry, model: [{ ...message, toolName: "other" }] } },
		{
			entry: {
				...entry,
				model: [{ ...message, details: { hipiFiles: { ...value, target: { ...target, path: "other" } } } }],
			},
		},
		{
			entry: {
				...entry,
				model: [
					{
						...message,
						details: { hipiFiles: { ...value, result: { kind: "directory", entries: [], hasMore: false } } },
					},
				],
			},
		},
		{ assistant: { ...assistant, model: [...(assistant.model ?? []), ...(assistant.model ?? [])] } },
	];
	for (const changed of cases) {
		const storage = new MemoryStorage();
		await storage.commit(
			[
				{ type: "conversation", value: { id: task.conversationId } },
				...(changed.omitAssistant ? [] : [{ type: "entry" as const, value: changed.assistant ?? assistant }]),
				{ type: "task", value: changed.task ?? task },
				{ type: "entry", value: changed.entry ?? entry },
			],
			context,
		);
		assert.equal((await readToolActivities(storage, scope)).items[0]?.fileSummary, undefined);
	}
});

test("bounded typed read, directory and save schemas preserve historical facts only", () => {
	assert.deepEqual(parseFilePresentation(value), value);
	for (const result of [
		read,
		{ kind: "directory", entries: [{ name: "bad:name", path: "bad:name", kind: "blocked" }], hasMore: true },
		{ kind: "save", operationId: "operation", revision: "b".repeat(64), bytes: 65536 },
	]) {
		const presentation = parseFilePresentation({ ...value, result });
		const page = { activityId: "task:20", text: "raw", nextCursor: null, retainedOutputOnly: true, presentation };
		assert.deepEqual(parseResult("getToolActivityText", page), page);
		assert.ok(fitsPayloadBudget(page));
	}
	assert.deepEqual(filePresentationDetails(target, read), { hipiFiles: value });
	assert.equal(filePresentationDetails(target, { ...read, text: "x".repeat(8193), textLength: 8193 }), undefined);
	assert.equal(filePresentationDetails({ ...target, path: "/absolute" }, read), undefined);
});

test("unknown, inconsistent and oversized details fail closed without disrupting the raw output contract", () => {
	for (const invalid of [
		{ ...value, version: 2 },
		{ ...value, secret: "credential" },
		{ ...value, target: { ...target, absolutePath: "/private" } },
		{ ...value, result: { ...read, nextOffset: 8 } },
		{ ...value, result: { ...read, text: "😀".repeat(3000), textLength: 6000 } },
		{ ...value, result: { ...read, text: "\ud800", textLength: 1 } },
		{
			...value,
			result: {
				kind: "directory",
				entries: Array.from({ length: 51 }, () => ({ name: "a", path: "a", kind: "file" })),
				hasMore: false,
			},
		},
		{ ...value, result: { kind: "save", operationId: "operation", revision: "bad", bytes: 2 } },
	])
		assert.throws(() => parseFilePresentation(invalid));
	assert.deepEqual(
		parseResult("getToolActivityText", {
			activityId: "entry:1",
			text: "legacy",
			nextCursor: null,
			retainedOutputOnly: true,
		}),
		{ activityId: "entry:1", text: "legacy", nextCursor: null, retainedOutputOnly: true },
	);
});

test("projection proves builtin identity and exact retained task/result/target ownership, never JSON sniffing", () => {
	assert.deepEqual(projectFilePresentation(task, assistant, entry), value);
	for (const changed of [
		undefined,
		{ ...entry, conversationId: 99 as ConversationId },
		{ ...entry, byTaskId: 99 as TaskId },
		{ ...entry, id: 31 as EntryId },
	])
		assert.equal(projectFilePresentation(task, assistant, changed), undefined);
	for (const changed of [
		undefined,
		{ ...assistant, conversationId: 99 as ConversationId },
		{ ...assistant, model: [...assistant.model!, ...assistant.model!] },
		{ ...assistant, model: [fauxAssistantMessage([fauxToolCall("arbitrary_mcp", target, { id: "call" })])] },
		{
			...assistant,
			model: [
				fauxAssistantMessage([fauxToolCall("hipi_files_read", { ...target, path: "different" }, { id: "call" })]),
			],
		},
	])
		assert.equal(projectFilePresentation(task, changed, entry), undefined);
	const result = entry.model?.[0];
	assert.equal(result?.role, "toolResult");
	if (result?.role !== "toolResult") throw new Error("fixture");
	for (const patch of [
		{ details: undefined },
		{ details: { hipiFiles: { ...value, version: 2 } } },
		{ toolName: "arbitrary_mcp" },
		{ isError: true },
		{ toolCallId: "other" },
	])
		assert.equal(projectFilePresentation(task, assistant, { ...entry, model: [{ ...result, ...patch }] }), undefined);
	assert.equal(
		projectFilePresentation(
			{ ...task, input: { kind: "nested", parent: 2, call: { id: "call", name: "hipi_files_read" } } },
			assistant,
			entry,
		),
		undefined,
	);
});

test("typed result appears only on the first proven task page; legacy and entry-only reads remain raw", async () => {
	const storage = new MemoryStorage();
	const message = entry.model?.[0];
	assert.equal(message?.role, "toolResult");
	if (message?.role !== "toolResult") throw new Error("fixture");
	await storage.commit(
		[
			{ type: "conversation", value: { id: task.conversationId } },
			{ type: "entry", value: assistant },
			{ type: "task", value: task },
			{
				type: "entry",
				value: { ...entry, model: [{ ...message, content: [{ type: "text", text: "x".repeat(9000) }] }] },
			},
		],
		context,
	);
	const scope = {
		storeId: "store",
		workspaceId: "work",
		conversationId: "chat",
		durableId: 1,
		generation: "generation",
	};
	const first = await readToolActivityText(storage, scope, "task:20");
	assert.deepEqual(first.presentation, value);
	assert.ok(first.nextCursor);
	const next = await readToolActivityText(storage, scope, "task:20", first.nextCursor);
	assert.equal(next.presentation, undefined);
	assert.equal(first.text.length + next.text.length, 9000);
	assert.equal((await readToolActivityText(storage, scope, "entry:30")).presentation, undefined);
	await assert.rejects(() => readToolActivityText(storage, { ...scope, durableId: 99 }, "task:20"));
});

test("serialized page bound includes worst escaping, both opaque strings and typed metadata", () => {
	const presentation = { ...value, result: { ...read, text: "\u0000".repeat(8192), textLength: 8192 } };
	const page = {
		activityId: "\u0000".repeat(2048),
		text: "\u0000".repeat(8192),
		nextCursor: "\u0000".repeat(2048),
		retainedOutputOnly: true as const,
		presentation,
	};
	assert.deepEqual(parseResult("getToolActivityText", page), page);
	const actual = Buffer.byteLength(JSON.stringify(page));
	assert.equal(actual, 85 + 2 * 2048 * 6 + 8192 * 6 + Buffer.byteLength(JSON.stringify(presentation)));
	assert.equal(TOOL_ACTIVITY_TEXT_PAGE_BYTES, 139349);
	assert.ok(actual <= TOOL_ACTIVITY_TEXT_PAGE_BYTES);
	assert.equal(16 * TOOL_ACTIVITY_TEXT_PAGE_BYTES, 2229584);
});
