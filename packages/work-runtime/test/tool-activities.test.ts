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
import type { FileOperation, ToolApproval } from "../src/contracts.ts";

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
