import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, EntryRecord, Storage, TaskId } from "@earendil-works/pi-durable";
import { AppError, fitsPayloadBudget, parseResult, parseToolActivitySelector } from "../contracts.ts";
import { validateRelativePath } from "../files/contracts.ts";
import {
	ACTIVITY_LIMITS,
	type ActivityReadScope,
	type ToolActivity,
	type ToolActivityPage,
	type ToolActivitySelector,
	type ToolActivityTextPage,
} from "./contracts.ts";
import { object, projectEntry, projectTask, resultEvidence, type StoredTask } from "./projection.ts";
import { taskSelection } from "./selection.ts";

type ActivityStorage = Pick<
	Storage,
	"entry" | "task" | "findDocument" | "document" | "conversation" | "scanTasks" | "scanEntries"
>;

type Position = { stage: "tasks" | "entries"; upperTask: number; upperEntry: number; after: number };
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const scopeToken = (scope: ActivityReadScope) => ({
	storeId: scope.storeId,
	workspaceId: scope.workspaceId,
	conversationId: scope.conversationId,
	durableId: scope.durableId,
	generation: scope.generation,
});
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number => value === 0 || positive(value);
function decode(raw: string, scope: ActivityReadScope): Record<string, unknown> {
	try {
		if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
		const value = object(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
		if (
			!value ||
			value.v !== 1 ||
			value.storeId !== scope.storeId ||
			value.workspaceId !== scope.workspaceId ||
			value.conversationId !== scope.conversationId ||
			value.durableId !== scope.durableId
		)
			throw new Error();
		if (value.generation !== scope.generation) throw new AppError("CURSOR_STALE");
		const keys = [
			"v",
			"storeId",
			"workspaceId",
			"conversationId",
			"durableId",
			"generation",
			"kind",
			...(value.kind === "activities"
				? ["stage", "upperTask", "upperEntry", "after", "selector"]
				: ["activityId", "entryId", "offset"]),
		];
		if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error();
		return value;
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError("INVALID_REQUEST");
	}
}
function reader(storage: ActivityStorage, scope: ActivityReadScope) {
	let bytes = 0;
	const budget = <T>(value: T): T => {
		bytes += Buffer.byteLength(JSON.stringify(value) ?? "");
		if (bytes > ACTIVITY_LIMITS.hydrationBytes) throw new AppError("CAPACITY_EXCEEDED");
		return value;
	};
	return {
		budget,
		async entry(id: number) {
			return budget((await storage.entry(scope.durableId as ConversationId, id as EntryId, context))?.entry);
		},
		async task(id: number) {
			return budget(await storage.task(id as TaskId, context));
		},
		async doc(kind: string, key: string) {
			const record = await storage.findDocument({ kind, key, scope: { kind: "session" } }, "current", context);
			const doc = record ? await storage.document(record.id, "current", context) : undefined;
			if (doc && doc.version !== 1) throw new AppError("INDEX_RECOVERY_REQUIRED");
			return budget(doc?.value);
		},
	};
}
type Reader = ReturnType<typeof reader>;
async function taskActivity(read: Reader, scope: ActivityReadScope, task: StoredTask) {
	if (task.kind !== "pi.tool" || task.conversationId !== scope.durableId) throw new AppError("NOT_FOUND");
	const input = object(task.input);
	const assistant =
		input?.kind === "model" && positive(input.assistant) ? await read.entry(input.assistant) : undefined;
	const outcome = task.state.outcome;
	const result = object(outcome?.result);
	let entry = positive(result?.entryId) ? await read.entry(result.entryId) : undefined;
	if (entry && (entry.conversationId !== scope.durableId || entry.byTaskId !== task.id)) entry = undefined;
	if (entry && resultEvidence(entry)?.callId !== input?.callId) entry = undefined;
	const activity = projectTask(task, assistant, entry);
	const key = createHash("sha256")
		.update(JSON.stringify([scope.durableId, task.id, activity.callId]))
		.digest("hex");
	const approvalRaw = object(await read.doc("hipi.tool-approval", key))?.value;
	if (approvalRaw !== undefined) {
		const approval = parseResult("decideToolApproval", approvalRaw);
		if (
			approval.workspaceId !== scope.workspaceId ||
			approval.conversationId !== scope.conversationId ||
			approval.taskId !== String(task.id) ||
			approval.callId !== activity.callId ||
			approval.approvalId !== key
		)
			throw new AppError("UNAUTHORIZED");
		const grant = object(await read.doc("hipi.agent-grant", approval.grantId));
		const grantValue = object(grant?.value);
		if (
			grant?.conversationId !== scope.durableId ||
			grantValue?.workspaceId !== scope.workspaceId ||
			grantValue?.conversationId !== scope.conversationId ||
			grantValue?.grantId !== approval.grantId
		)
			throw new AppError("UNAUTHORIZED");
		activity.approval = {
			approvalId: key,
			status: approval.status,
			grantId: approval.grantId,
			expired: approval.expiresAt <= Date.now(),
		};
		activity.receiptIds = [...approval.receiptIds];
		if (approval.operationId) {
			const raw = object(await read.doc("hipi.file-operation", approval.operationId))?.value;
			if (raw !== undefined) {
				const operation = parseResult("getFileOperation", raw);
				if (
					!operation ||
					operation.workspaceId !== scope.workspaceId ||
					operation.conversationId !== scope.conversationId ||
					operation.taskId !== String(task.id) ||
					operation.callId !== activity.callId ||
					operation.approvalId !== key ||
					operation.operationId !== approval.operationId
				)
					throw new AppError("UNAUTHORIZED");
				activity.effect = { operationId: operation.operationId, status: operation.status };
				activity.artifact = {
					rootId: operation.rootId,
					path: validateRelativePath(operation.path),
					operationId: operation.operationId,
					status: operation.status,
					...(operation.evidence ? { expectedRevision: operation.evidence.revision } : {}),
				};
			}
		}
	}
	return { activity, entry };
}

export async function readToolActivities(
	storage: ActivityStorage,
	scope: ActivityReadScope,
	cursor?: string,
	selector?: ToolActivitySelector,
): Promise<ToolActivityPage> {
	selector = selector === undefined ? undefined : parseToolActivitySelector(selector);
	if (!(await storage.conversation(scope.durableId as ConversationId, context))) throw new AppError("NOT_FOUND");
	const read = reader(storage, scope);
	const selection = taskSelection(read, scope);
	if (selector?.kind === "tasks") {
		if (cursor !== undefined) throw new AppError("INVALID_REQUEST");
		const items: ToolActivity[] = [];
		const unavailableTaskIds: string[] = [];
		for (const id of selector.taskIds) {
			const task = await selection.task(Number(id));
			if (!task || !(await selection.visible(task))) unavailableTaskIds.push(id);
			else items.push((await taskActivity(read, scope, task)).activity);
		}
		const result: ToolActivityPage = {
			items,
			unavailableTaskIds,
			nextCursor: null,
			coverage: "tasks",
			membershipFence: encode({ ...scopeToken(scope), selector }),
		};
		if (!fitsPayloadBudget(result)) throw new AppError("CAPACITY_EXCEEDED");
		return result;
	}
	let messageAnchor: { assistantEntryId: string; modelIndex: number; contentIndex?: number } | undefined;
	if (selector?.kind === "message") {
		const [entryId, modelIndex] = selector.messageId.split("_").map(Number);
		const entry = await read.entry(entryId);
		const message = entry?.model?.[modelIndex];
		if (
			message?.role !== "assistant" ||
			(selector.contentIndex !== undefined && message.content[selector.contentIndex]?.type !== "toolCall")
		)
			throw new AppError("NOT_FOUND");
		messageAnchor = {
			assistantEntryId: String(entryId),
			modelIndex,
			...(selector.contentIndex === undefined ? {} : { contentIndex: selector.contentIndex }),
		};
	}
	let position: Position;
	if (cursor) {
		const value = decode(cursor, scope);
		if (JSON.stringify(value.selector) !== JSON.stringify(selector)) throw new AppError("INVALID_REQUEST");
		if (
			value.kind !== "activities" ||
			(value.stage !== "tasks" && value.stage !== "entries") ||
			!nonnegative(value.upperTask) ||
			!nonnegative(value.upperEntry) ||
			!nonnegative(value.after) ||
			value.after > (value.stage === "tasks" ? value.upperTask : value.upperEntry)
		)
			throw new AppError("INVALID_REQUEST");
		if (selector && value.stage !== "tasks") throw new AppError("INVALID_REQUEST");
		position = { stage: value.stage, upperTask: value.upperTask, upperEntry: value.upperEntry, after: value.after };
	} else {
		const tasks = read.budget(
			await storage.scanTasks(
				{ conversationId: scope.durableId as ConversationId, kind: "pi.tool", order: "descending" },
				1,
				undefined,
				context,
			),
		);
		const entries = selector
			? undefined
			: read.budget(
					await storage.scanEntries(
						{ conversationId: scope.durableId as ConversationId, order: "descending" },
						1,
						undefined,
						context,
					),
				);
		position = {
			stage: "tasks",
			upperTask: tasks.items[0]?.id ?? 0,
			upperEntry: entries?.items[0]?.id ?? 0,
			after: 0,
		};
	}
	const items: ToolActivity[] = [];
	const coverage = position.stage;
	let next: Position | undefined;
	if (position.stage === "tasks") {
		const page = read.budget(
			await storage.scanTasks(
				{ conversationId: scope.durableId as ConversationId, kind: "pi.tool", order: "descending" },
				ACTIVITY_LIMITS.page,
				{ order: "descending", after: position.after || position.upperTask + 1 },
				context,
			),
		);
		for (const task of page.items) {
			if (messageAnchor) {
				const input = object(task.input);
				if (
					input?.kind !== "model" ||
					String(input.assistant) !== messageAnchor.assistantEntryId ||
					!(await selection.visible(task))
				)
					continue;
			}
			const activity = (await taskActivity(read, scope, task)).activity;
			if (
				messageAnchor &&
				(activity.anchor?.assistantEntryId !== messageAnchor.assistantEntryId ||
					activity.anchor.modelIndex !== messageAnchor.modelIndex ||
					(messageAnchor.contentIndex !== undefined &&
						activity.anchor.contentIndex !== messageAnchor.contentIndex))
			)
				continue;
			items.push(activity);
		}
		next = page.next
			? { ...position, after: page.items.at(-1)?.id ?? position.after }
			: !selector && position.upperEntry
				? { ...position, stage: "entries", after: 0 }
				: undefined;
	} else {
		// Includes inherited results and local results emitted directly by generation, without a pi.tool task.
		const page = read.budget(
			await storage.scanEntries(
				{
					conversationId: scope.durableId as ConversationId,
					maxEntryId: position.upperEntry as EntryId,
					order: "descending",
				},
				ACTIVITY_LIMITS.page,
				position.after ? { order: "descending", after: position.after } : undefined,
				context,
			),
		);
		for (const entry of page.items) {
			if (entry.kind !== "pi.tool-result") continue;
			if (entry.conversationId === scope.durableId && entry.byTaskId) {
				const task = await read.task(entry.byTaskId);
				if (task?.kind === "pi.tool" && task.conversationId === scope.durableId) continue;
			}
			const activity = projectEntry(entry, scope.durableId);
			if (activity) items.push(activity);
		}
		next = page.next ? { ...position, after: page.items.at(-1)?.id ?? position.after } : undefined;
	}
	const result = {
		items,
		coverage,
		nextCursor: next
			? encode({ v: 1, ...scopeToken(scope), kind: "activities", ...next, ...(selector ? { selector } : {}) })
			: null,
		membershipFence: encode({
			task: position.upperTask,
			entry: position.upperEntry,
			...(selector ? { selector } : {}),
		}),
	};
	if (!fitsPayloadBudget(result)) throw new AppError("CAPACITY_EXCEEDED");
	return result;
}

export async function readToolActivityText(
	storage: ActivityStorage,
	scope: ActivityReadScope,
	activityId: string,
	cursor?: string,
): Promise<ToolActivityTextPage> {
	if (!(await storage.conversation(scope.durableId as ConversationId, context))) throw new AppError("NOT_FOUND");
	const match = /^(task|entry):([1-9][0-9]*)$/.exec(activityId);
	if (!match || !positive(Number(match[2]))) throw new AppError("INVALID_REQUEST");
	const read = reader(storage, scope);
	let entry: EntryRecord | undefined;
	if (match[1] === "task") {
		const task = await read.task(Number(match[2]));
		if (!task) throw new AppError("NOT_FOUND");
		entry = (await taskActivity(read, scope, task)).entry;
	} else entry = await read.entry(Number(match[2]));
	const result = resultEvidence(entry);
	if (!entry || result?.text === undefined) throw new AppError("NOT_FOUND");
	let offset = 0;
	if (cursor) {
		const value = decode(cursor, scope);
		if (
			value.kind !== "activity-text" ||
			value.activityId !== activityId ||
			value.entryId !== entry.id ||
			!nonnegative(value.offset) ||
			value.offset > result.text.length
		)
			throw new AppError("INVALID_REQUEST");
		offset = value.offset;
		if (offset > 0 && /[\uDC00-\uDFFF]/.test(result.text[offset]) && /[\uD800-\uDBFF]/.test(result.text[offset - 1]))
			throw new AppError("INVALID_REQUEST");
	}
	let text = "";
	let bytes = 0;
	for (const char of result.text.slice(offset)) {
		const size = Buffer.byteLength(char);
		if (bytes + size > ACTIVITY_LIMITS.textBytes) break;
		text += char;
		bytes += size;
	}
	const end = offset + text.length;
	return {
		activityId,
		text,
		nextCursor:
			end < result.text.length
				? encode({ v: 1, ...scopeToken(scope), kind: "activity-text", activityId, entryId: entry.id, offset: end })
				: null,
		retainedOutputOnly: true,
	};
}
