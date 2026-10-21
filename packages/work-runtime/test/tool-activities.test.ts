import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, DocumentId, EntryId, EntryRecord, Storage, TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ACTIVITY_LIMITS, type ActivityReadScope } from "../src/activities/contracts.ts";
import { resultEvidence, type StoredTask } from "../src/activities/projection.ts";
import { readToolActivities, readToolActivityText } from "../src/activities/storage.ts";
import { type FileOperation, type FilePresentation, parseResult, type ToolApproval } from "../src/contracts.ts";

const scope: ActivityReadScope = {
	storeId: "store",
	workspaceId: "work",
	conversationId: "conversation",
	durableId: 1,
	generation: "generation",
};
const conversationId = 1 as ConversationId;
function task(id: number, assistant = 10, result = 30): StoredTask & { memos?: never } {
	return {
		id: id as TaskId<JsonValue>,
		conversationId,
		kind: "pi.tool",
		version: 2,
		input: { kind: "model", assistant, callId: "call" },
		background: false,
		abortRequested: false,
		state: { status: "terminal", outcome: { status: "completed", result: { kind: "model", entryId: result } } },
	};
}
function entry(id = 30, byTaskId = 20, text = "retained output", isError = false): EntryRecord {
	return {
		id: id as EntryId,
		conversationId,
		kind: "pi.tool-result",
		byTaskId: byTaskId as TaskId,
		data: { diagnostics: [] },
		model: [
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "official.pack.tool",
				content: [{ type: "text", text }],
				isError,
				timestamp: 123,
			},
		],
	};
}
async function fixture(run: (storage: Storage) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "hipi-activity-"));
	const storage = await openNodeSqliteStorage(join(directory, "workspace.sqlite"));
	try {
		await storage.commit(
			[
				{ type: "conversation", value: { id: conversationId } },
				{
					type: "entry",
					value: {
						id: 10 as EntryId,
						conversationId,
						kind: "pi.assistant",
						model: [
							fauxAssistantMessage([
								fauxToolCall("official.pack.tool", { secret: "ARGUMENT_SENTINEL" }, { id: "call" }),
							]),
						],
					},
				},
			],
			context,
		);
		await run(storage);
	} finally {
		await storage.close(context);
		await rm(directory, { recursive: true, force: true });
	}
}

test("save metadata requires confirmed matching artifact and operation, never retained proposals", async () =>
	fixture(async (storage) => {
		const target = { rootId: "root", path: "note.txt" };
		const text = "PRIVATE_REPLACEMENT";
		const digest = "a".repeat(64);
		const approvalId = createHash("sha256")
			.update(JSON.stringify([1, 20, "call"]))
			.digest("hex");
		const approval: ToolApproval = {
			workspaceId: scope.workspaceId,
			conversationId: scope.conversationId,
			approvalId,
			taskId: "20",
			callId: "call",
			submissionIds: [],
			receiptIds: [],
			toolName: "hipi_files_save",
			model: { provider: "faux", modelId: "faux" },
			...target,
			ifMatch: digest,
			text,
			beforeText: "PRIVATE_BEFORE",
			beforeTextTruncated: false,
			argumentsDigest: digest,
			contentDigest: digest,
			grantId: "grant",
			grantRevision: 1,
			expiresAt: 1,
			createdAt: 0,
			revision: 1,
			status: "consumed",
			operationId: "operation",
		};
		const operation: FileOperation = {
			workspaceId: scope.workspaceId,
			conversationId: scope.conversationId,
			operationId: "operation",
			approvalId,
			taskId: "20",
			callId: "call",
			...target,
			argumentsDigest: digest,
			contentDigest: digest,
			status: "unknown",
			revision: 1,
		};
		const presentation: FilePresentation = {
			version: 1,
			target,
			result: { kind: "save", operationId: "operation", revision: digest, bytes: text.length },
		};
		const result: EntryRecord = {
			...entry(),
			model: [
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "hipi_files_save",
					isError: false,
					timestamp: 0,
					content: [{ type: "text", text: "PRIVATE_RETAINED_OUTPUT" }],
					details: { hipiFiles: presentation },
				},
			],
		};
		await storage.commit(
			[
				{ type: "task", value: task(20, 11) },
				{
					type: "entry",
					value: {
						id: 11 as EntryId,
						conversationId,
						kind: "pi.assistant",
						model: [
							fauxAssistantMessage([
								fauxToolCall("hipi_files_save", { ...target, text, ifMatch: digest }, { id: "call" }),
							]),
						],
					},
				},
				{ type: "entry", value: result },
				{
					type: "document.create",
					record: {
						id: 100 as DocumentId,
						kind: "hipi.tool-approval",
						key: approvalId,
						scope: { kind: "session" },
					},
					content: { kind: "base", version: 1, value: { value: approval } },
				},
				{
					type: "document.create",
					record: { id: 101 as DocumentId, kind: "hipi.agent-grant", key: "grant", scope: { kind: "session" } },
					content: {
						kind: "base",
						version: 1,
						value: {
							conversationId: 1,
							value: { workspaceId: scope.workspaceId, conversationId: scope.conversationId, grantId: "grant" },
						},
					},
				},
				{
					type: "document.create",
					record: {
						id: 102 as DocumentId,
						kind: "hipi.file-operation",
						key: "operation",
						scope: { kind: "session" },
					},
					content: { kind: "base", version: 1, value: { value: operation } },
				},
			],
			context,
		);
		for (const status of ["prepared", "executing", "conflict", "unknown", "observed_match", "confirmed"] as const) {
			await storage.commit(
				[
					{
						type: "document.change",
						id: 102 as DocumentId,
						content: { kind: "base", version: 1, value: { value: { ...operation, status } } },
					},
				],
				context,
			);
			const page = await readToolActivities(storage, scope);
			assert.deepEqual(parseResult("getToolActivities", page), page);
			assert.equal(JSON.stringify(page).includes("PRIVATE_"), false);
			assert.deepEqual(
				page.items[0]?.fileSummary,
				status === "confirmed"
					? {
							version: 1,
							target,
							kind: "save",
							partial: false,
							operationId: "operation",
						}
					: undefined,
			);
		}
		for (const patch of [{ rootId: "other" }, { path: "other.txt" }]) {
			await storage.commit(
				[
					{
						type: "document.change",
						id: 102 as DocumentId,
						content: {
							kind: "base",
							version: 1,
							value: { value: { ...operation, status: "confirmed", ...patch } },
						},
					},
				],
				context,
			);
			assert.equal((await readToolActivities(storage, scope)).items[0]?.fileSummary, undefined);
		}
		await storage.commit(
			[
				{
					type: "document.change",
					id: 102 as DocumentId,
					content: { kind: "base", version: 1, value: { value: { ...operation, status: "confirmed" } } },
				},
			],
			context,
		);
		const message = result.model?.[0];
		if (message?.role !== "toolResult") throw new Error("fixture");
		await storage.commit(
			[
				{ type: "task", value: task(20, 11, 31) },
				{
					type: "entry",
					value: {
						...result,
						id: 31 as EntryId,
						model: [
							{
								...message,
								details: {
									hipiFiles: { ...presentation, result: { ...presentation.result, operationId: "other" } },
								},
							},
						],
					},
				},
			],
			context,
		);
		assert.equal((await readToolActivities(storage, scope)).items[0]?.fileSummary, undefined);
		await storage.commit(
			[
				{
					type: "task",
					value: {
						...task(20, 11),
						state: {
							status: "terminal",
							outcome: {
								status: "failed",
								error: { message: "failure" },
								result: { kind: "model", entryId: 30 },
							},
						},
					},
				},
			],
			context,
		);
		assert.equal((await readToolActivities(storage, scope)).items[0]?.fileSummary, undefined);
	}));

test("SQLite activity reads separate task completion from tool errors without writes or arguments", async () =>
	fixture(async (storage) => {
		await storage.commit(
			[
				{ type: "task", value: task(20) },
				{ type: "entry", value: entry(30, 20, "safe output", true) },
			],
			context,
		);
		storage.commit = async () => {
			throw new Error("Read attempted a commit");
		};
		storage.mintId = async () => {
			throw new Error("Read attempted ID allocation");
		};
		const page = await readToolActivities(storage, scope);
		assert.equal(page.items[0].outcome, "completed");
		assert.equal(page.items[0].toolResult, "error");
		assert.equal(page.items[0].toolName, "official.pack.tool");
		assert.deepEqual(page.items[0].anchor, { assistantEntryId: "10", modelIndex: 0, contentIndex: 0 });
		assert.equal(JSON.stringify(page).includes("ARGUMENT_SENTINEL"), false);
		assert.deepEqual(page.items[0].receiptIds, []);
		assert.equal((await readToolActivityText(storage, scope, "task:20")).text, "safe output");
	}));

test("diagnostic text is removed by exact provenance, not by prefix; unknown boundaries are unavailable", () => {
	const base = entry();
	const message = base.model?.[0];
	assert.equal(message?.role, "toolResult");
	if (message?.role !== "toolResult") return;
	const diagnostic = { severity: "error", message: "SECRET_EXCEPTION_SENTINEL", code: "truncated" };
	const retained = "<harness>user-authored tool output</harness>";
	const value = {
		...base,
		data: { diagnostics: [diagnostic] },
		model: [
			{
				...message,
				content: [
					{ type: "text" as const, text: retained },
					{ type: "text" as const, text: "<harness>\n[error] SECRET_EXCEPTION_SENTINEL\n</harness>" },
				],
			},
		],
	};
	assert.deepEqual(resultEvidence(value), {
		callId: "call",
		toolName: "official.pack.tool",
		isError: false,
		text: retained,
		truncated: true,
	});
	assert.equal(
		resultEvidence({
			...value,
			model: [{ ...message, content: [{ type: "text", text: "mismatched diagnostic SECRET_EXCEPTION_SENTINEL" }] }],
		})?.text,
		undefined,
	);
	assert.equal(resultEvidence({ ...base, data: undefined })?.text, undefined);
});

test("fork entry visibility never enumerates or exposes parent tasks or post-fork outcomes", async () =>
	fixture(async (storage) => {
		await storage.commit(
			[
				{ type: "task", value: task(20) },
				{ type: "entry", value: entry() },
				{ type: "entry", value: entry(50, 40, "HIDDEN_AFTER_FORK") },
				{
					type: "conversation",
					value: { id: 60 as ConversationId, parent: { conversationId, at: 30 as EntryId } },
				},
			],
			context,
		);
		const child = { ...scope, durableId: 60, conversationId: "fork" };
		const original = storage.scanTasks.bind(storage);
		storage.scanTasks = (query, ...rest) => {
			assert.equal(query.conversationId, 60);
			return original(query, ...rest);
		};
		const first = await readToolActivities(storage, child);
		assert.equal(first.items.length, 0);
		assert.ok(first.nextCursor);
		const second = await readToolActivities(storage, child, first.nextCursor);
		assert.equal(second.items.length, 1);
		assert.equal(second.items[0].activityId, "entry:30");
		assert.equal(second.items[0].inherited, true);
		assert.equal(second.items[0].phase, "unavailable");
		assert.equal(second.items[0].outcome, undefined);
		await assert.rejects(readToolActivityText(storage, child, "task:20"), { code: "NOT_FOUND" });
		await assert.rejects(readToolActivityText(storage, child, "entry:50"), { code: "NOT_FOUND" });
	}));

test("task pages keep membership through inserts and status changes; cursor scopes reject", async () =>
	fixture(async (storage) => {
		for (let id = 20; id < 40; id++) await storage.commit([{ type: "task", value: task(id, 10, 999) }], context);
		const first = await readToolActivities(storage, scope);
		assert.equal(first.items.length, ACTIVITY_LIMITS.page);
		assert.ok(first.nextCursor);
		await storage.commit([{ type: "task", value: task(100, 10, 999) }], context);
		const next = await readToolActivities(storage, scope, first.nextCursor);
		assert.deepEqual(
			next.items.map((item) => item.taskId),
			["23", "22", "21", "20"],
		);
		assert.equal(first.membershipFence, next.membershipFence);
		await assert.rejects(readToolActivities(storage, { ...scope, storeId: "other" }, first.nextCursor), {
			code: "INVALID_REQUEST",
		});
		await assert.rejects(readToolActivities(storage, { ...scope, generation: "other" }, first.nextCursor), {
			code: "CURSOR_STALE",
		});
	}));

test("entry section retains direct generation errors and deduplicates local task results", async () =>
	fixture(async (storage) => {
		await storage.commit(
			[
				{ type: "task", value: task(20) },
				{ type: "entry", value: entry() },
				{ type: "entry", value: entry(40, 99, "direct generation failure", true) },
			],
			context,
		);
		const first = await readToolActivities(storage, scope);
		assert.ok(first.nextCursor);
		const second = await readToolActivities(storage, scope, first.nextCursor);
		assert.deepEqual(
			second.items.map((item) => item.activityId),
			["entry:40"],
		);
	}));

test("text pages preserve UTF-16 boundaries and UTF-8 byte budget", async () =>
	fixture(async (storage) => {
		const text = "😀中".repeat(3000);
		await storage.commit([{ type: "entry", value: entry(30, 99, text) }], context);
		let cursor: string | undefined;
		let combined = "";
		do {
			const page = await readToolActivityText(storage, scope, "entry:30", cursor);
			assert.ok(Buffer.byteLength(page.text) <= ACTIVITY_LIMITS.textBytes);
			assert.equal(page.text.isWellFormed(), true);
			combined += page.text;
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.equal(combined, text);
	}));

test("approval expiry and operation observations are read-only facts independent of execution", async () =>
	fixture(async (storage) => {
		const approvalId = createHash("sha256")
			.update(JSON.stringify([1, 20, "call"]))
			.digest("hex");
		const digest = "a".repeat(64);
		const approval: ToolApproval = {
			workspaceId: "work",
			conversationId: "conversation",
			approvalId,
			taskId: "20",
			callId: "call",
			submissionIds: ["submission"],
			receiptIds: ["receipt"],
			toolName: "hipi_files_save",
			model: { provider: "faux", modelId: "faux" },
			rootId: "root",
			path: "file.txt",
			ifMatch: digest,
			text: "PRIVATE_PROPOSAL",
			beforeText: "PRIVATE_BEFORE",
			beforeTextTruncated: false,
			argumentsDigest: digest,
			contentDigest: digest,
			grantId: "grant",
			grantRevision: 1,
			expiresAt: 1,
			createdAt: 0,
			revision: 1,
			status: "approved",
			operationId: "operation",
		};
		const operation: FileOperation = {
			workspaceId: "work",
			conversationId: "conversation",
			operationId: "operation",
			approvalId,
			taskId: "20",
			callId: "call",
			rootId: "root",
			path: "file.txt",
			argumentsDigest: digest,
			contentDigest: digest,
			status: "unknown",
			revision: 1,
		};
		await storage.commit(
			[
				{
					type: "task",
					value: {
						...task(20),
						abortRequested: true,
						state: {
							status: "terminal",
							outcome: { status: "faulted", error: { message: "PRIVATE_EXCEPTION" } },
						},
					},
				},
				{
					type: "document.create",
					record: {
						id: 100 as DocumentId,
						kind: "hipi.tool-approval",
						key: approvalId,
						scope: { kind: "session" },
					},
					content: { kind: "base", version: 1, value: { value: approval } },
				},
				{
					type: "document.create",
					record: { id: 101 as DocumentId, kind: "hipi.agent-grant", key: "grant", scope: { kind: "session" } },
					content: {
						kind: "base",
						version: 1,
						value: {
							conversationId: 1,
							value: { workspaceId: "work", conversationId: "conversation", grantId: "grant" },
						},
					},
				},
				{
					type: "document.create",
					record: {
						id: 102 as DocumentId,
						kind: "hipi.file-operation",
						key: "operation",
						scope: { kind: "session" },
					},
					content: { kind: "base", version: 1, value: { value: operation } },
				},
			],
			context,
		);
		const commit = storage.commit.bind(storage);
		storage.commit = async () => {
			throw new Error("Projection must not write expiration or reconciliation");
		};
		let activity = (await readToolActivities(storage, scope)).items[0];
		assert.equal(activity.approval?.expired, true);
		assert.equal(activity.approval?.status, "approved");
		assert.equal(activity.effect?.status, "unknown");
		assert.equal(activity.outcome, "faulted");
		assert.equal(activity.abortRequested, true);
		assert.equal(activity.toolResult, "unavailable");
		assert.deepEqual(activity.receiptIds, ["receipt"]);
		assert.equal(JSON.stringify(activity).includes("PRIVATE_"), false);
		await commit(
			[
				{
					type: "document.change",
					id: 102 as DocumentId,
					content: {
						kind: "base",
						version: 1,
						value: { value: { ...operation, status: "observed_match", revision: 2 } },
					},
				},
			],
			context,
		);
		activity = (await readToolActivities(storage, scope)).items[0];
		assert.equal(activity.effect?.status, "observed_match");
		assert.equal(activity.outcome, "faulted");
	}));

test("nested retired result remains unavailable, and hydration bytes fail closed", async () =>
	fixture(async (storage) => {
		await storage.commit(
			[
				{
					type: "task",
					value: {
						...task(20),
						owner: 12 as TaskId,
						input: {
							kind: "nested",
							parent: 12,
							parentCallId: "parent",
							key: "nested",
							call: { id: "nested", name: "official.pack.nested", arguments: {} },
						},
						state: { status: "terminal", outcome: { status: "completed", result: { kind: "nested" } } },
					},
				},
			],
			context,
		);
		const activity = (await readToolActivities(storage, scope)).items[0];
		assert.equal(activity.parentTaskId, "12");
		assert.equal(activity.outcome, "completed");
		assert.equal(activity.toolResult, "unavailable");
		assert.equal(activity.textAvailable, false);
		await storage.commit(
			[{ type: "entry", value: entry(30, 99, "x".repeat(ACTIVITY_LIMITS.hydrationBytes + 1)) }],
			context,
		);
		await assert.rejects(readToolActivityText(storage, scope, "entry:30"), { code: "CAPACITY_EXCEEDED" });
	}));

test("message selectors advance empty bounded pages and never join reused call IDs across turns", async () =>
	fixture(async (storage) => {
		await storage.commit(
			[
				{
					type: "entry",
					value: {
						id: 11 as EntryId,
						conversationId,
						kind: "pi.assistant",
						model: [fauxAssistantMessage([fauxToolCall("other", {}, { id: "call" })])],
					},
				},
			],
			context,
		);
		for (let id = 20; id < 40; id++)
			await storage.commit([{ type: "task", value: task(id, id === 20 ? 10 : 11, 999) }], context);
		const selector = { kind: "message", messageId: "10_0", contentIndex: 0 } as const;
		const first = await readToolActivities(storage, scope, undefined, selector);
		assert.deepEqual(first.items, []);
		assert.ok(first.nextCursor);
		assert.equal(first.unavailableTaskIds, undefined);
		const second = await readToolActivities(storage, scope, first.nextCursor, selector);
		assert.deepEqual(
			second.items.map((item) => item.taskId),
			["20"],
		);
		assert.equal(second.nextCursor, null);
		assert.equal(second.membershipFence, first.membershipFence);
		for (const changed of [undefined, { kind: "message", messageId: "11_0" } as const])
			await assert.rejects(readToolActivities(storage, scope, first.nextCursor, changed), {
				code: "INVALID_REQUEST",
			});
		await assert.rejects(
			readToolActivities(storage, { ...scope, generation: "replaced" }, first.nextCursor, selector),
			{ code: "CURSOR_STALE" },
		);
		await assert.rejects(readToolActivities(storage, scope, undefined, { ...selector, contentIndex: 1 }), {
			code: "NOT_FOUND",
		});
	}));

test("exact selection preserves valid cards without exposing missing, foreign, invisible or cyclic tasks", async () =>
	fixture(async (storage) => {
		const nested = (id: number, parent: number): StoredTask => ({
			...task(id),
			input: {
				kind: "nested",
				parent,
				call: { id: `child-${id}`, name: "nested", arguments: { secret: "PRIVATE_INPUT" } },
			},
		});
		await storage.commit(
			[
				{ type: "conversation", value: { id: 2 as ConversationId } },
				{ type: "task", value: task(20) },
				{ type: "task", value: { ...task(21), conversationId: 2 as ConversationId } },
				{ type: "task", value: task(22, 999) },
				{ type: "task", value: { ...task(23), kind: "other" } },
				{ type: "task", value: nested(24, 20) },
				{ type: "task", value: nested(25, 26) },
				{ type: "task", value: nested(26, 25) },
				{ type: "task", value: nested(27, 21) },
			],
			context,
		);
		const readEntry = storage.entry.bind(storage);
		let foreignEvidenceReads = 0;
		// A foreign task must not cause its assistant/evidence to be hydrated.
		const foreign = { ...task(21, 888), conversationId: 2 as ConversationId };
		await storage.commit([{ type: "task", value: foreign }], context);
		storage.entry = ((...args: Parameters<Storage["entry"]>) => {
			if (args[1] === 888) foreignEvidenceReads++;
			return readEntry(...args);
		}) as Storage["entry"];
		const ids = ["20", "21", "22", "23", "24", "25", "27", "999"];
		const page = await readToolActivities(storage, scope, undefined, { kind: "tasks", taskIds: ids });
		assert.deepEqual(
			page.items.map((item) => item.taskId),
			["20", "24"],
		);
		assert.deepEqual(page.unavailableTaskIds, ["21", "22", "23", "25", "27", "999"]);
		assert.equal(foreignEvidenceReads, 0);
		assert.equal(page.nextCursor, null);
		assert.equal(JSON.stringify(page).includes("PRIVATE_INPUT"), false);
		await assert.rejects(readToolActivities(storage, scope, "cursor", { kind: "tasks", taskIds: ["20"] }), {
			code: "INVALID_REQUEST",
		});
		await storage.commit(
			[{ type: "conversation", value: { id: 60 as ConversationId, parent: { conversationId, at: 10 as EntryId } } }],
			context,
		);
		const fork = await readToolActivities(storage, { ...scope, durableId: 60 }, undefined, {
			kind: "tasks",
			taskIds: ["20"],
		});
		assert.deepEqual(fork.items, []);
		assert.deepEqual(fork.unavailableTaskIds, ["20"]);
		for (let id = 100; id <= 116; id++)
			await storage.commit([{ type: "task", value: nested(id, id === 100 ? 20 : id - 1) }], context);
		const deep = await readToolActivities(storage, scope, undefined, { kind: "tasks", taskIds: ["115", "116"] });
		assert.deepEqual(
			deep.items.map((item) => item.taskId),
			["115"],
		);
		assert.deepEqual(deep.unavailableTaskIds, ["116"]);
	}));

test("exact ancestry hydration has a hard request budget and propagates storage failures", async () =>
	fixture(async (storage) => {
		await storage.commit([{ type: "task", value: task(20) }], context);
		for (let id = 200; id < 264; id++)
			await storage.commit(
				[
					{
						type: "task",
						value: {
							...task(id),
							input: {
								kind: "nested",
								parent: (id - 200) % 16 === 0 ? 20 : id - 1,
								call: { id: `nested-${id}`, name: "nested", arguments: {} },
							},
						},
					},
				],
				context,
			);
		const original = storage.task.bind(storage);
		let reads = 0;
		storage.task = (...args) => {
			reads++;
			return original(...args);
		};
		await assert.rejects(
			readToolActivities(storage, scope, undefined, { kind: "tasks", taskIds: ["215", "231", "247", "263"] }),
			{ code: "CAPACITY_EXCEEDED" },
		);
		assert.equal(reads, ACTIVITY_LIMITS.taskHydrations);
		storage.task = async () => {
			throw new Error("Storage failed");
		};
		await assert.rejects(
			readToolActivities(storage, scope, undefined, { kind: "tasks", taskIds: ["20"] }),
			/Storage failed/,
		);
	}));

test("message selection respects model and content indexes rather than presentation position", async () =>
	fixture(async (storage) => {
		await storage.commit(
			[
				{
					type: "entry",
					value: {
						id: 12 as EntryId,
						conversationId,
						kind: "pi.assistant",
						model: [
							fauxAssistantMessage("intro"),
							fauxAssistantMessage([
								{ type: "text", text: "before" },
								fauxToolCall("official.pack.tool", {}, { id: "call" }),
							]),
						],
					},
				},
				{ type: "task", value: task(20, 12, 999) },
			],
			context,
		);
		const found = await readToolActivities(storage, scope, undefined, {
			kind: "message",
			messageId: "12_1",
			contentIndex: 1,
		});
		assert.deepEqual(found.items[0].anchor, { assistantEntryId: "12", modelIndex: 1, contentIndex: 1 });
		assert.deepEqual(
			(await readToolActivities(storage, scope, undefined, { kind: "message", messageId: "12_0" })).items,
			[],
		);
	}));
