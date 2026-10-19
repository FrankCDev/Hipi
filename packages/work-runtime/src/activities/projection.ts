import type { JsonValue } from "@earendil-works/chord";
import type { EntryRecord, TaskRecord } from "@earendil-works/pi-durable";
import type { ToolActivity } from "./contracts.ts";

export type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
export const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** Only the explicitly stored tool output channel is exposed. Diagnostics are never display text. */
export function resultEvidence(entry: EntryRecord | undefined) {
	const message = entry?.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
	if (message?.role !== "toolResult") return undefined;
	const diagnostics = object(entry?.data)?.diagnostics;
	let content = message.content;
	let textSafe = Array.isArray(diagnostics);
	let truncated = false;
	if (Array.isArray(diagnostics) && diagnostics.length > 0) {
		const records = diagnostics.map(object);
		textSafe = records.every((item) => item && typeof item.message === "string" && typeof item.severity === "string");
		truncated = records.some((item) => item?.code === "truncated");
		if (textSafe) {
			const rendered = `<harness>\n${records.map((item) => `[${item?.severity}] ${item?.message}`).join("\n")}\n</harness>`;
			const last = content.at(-1);
			// This is the exact appendToolResult serialization, not a prefix heuristic.
			textSafe = last?.type === "text" && last.text === rendered;
			if (textSafe) content = content.slice(0, -1);
		}
	}
	const text = textSafe
		? content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
		: undefined;
	return { callId: message.toolCallId, toolName: message.toolName, isError: message.isError, text, truncated };
}

export function projectTask(
	task: StoredTask,
	assistant: EntryRecord | undefined,
	result: EntryRecord | undefined,
): ToolActivity {
	const input = object(task.input);
	const nested = input?.kind === "nested" ? object(input.call) : undefined;
	let callId =
		typeof input?.callId === "string" ? input.callId : typeof nested?.id === "string" ? nested.id : "unavailable";
	let toolName = typeof nested?.name === "string" ? nested.name : "unavailable";
	let anchor: ToolActivity["anchor"];
	if (input?.kind === "model" && assistant?.kind === "pi.assistant") {
		for (const [modelIndex, message] of (assistant.model ?? []).entries()) {
			if (message.role !== "assistant") continue;
			const contentIndex = message.content.findIndex((part) => part.type === "toolCall" && part.id === callId);
			const call = message.content[contentIndex];
			if (call?.type !== "toolCall") continue;
			toolName = call.name;
			anchor = { assistantEntryId: String(assistant.id), modelIndex, contentIndex };
			break;
		}
	}
	const evidence = resultEvidence(result);
	if (evidence && evidence.callId === callId) toolName = evidence.toolName;
	else result = undefined;
	if (callId.length > 256 || toolName.length > 256) {
		callId = "unavailable";
		toolName = "unavailable";
	}
	return {
		activityId: `task:${task.id}`,
		taskId: String(task.id),
		callId,
		toolName,
		source: "task",
		inherited: false,
		...(anchor ? { anchor } : {}),
		phase: task.state.status,
		...(task.state.outcome ? { outcome: task.state.outcome.status } : {}),
		toolResult: result && evidence ? (evidence.isError ? "error" : "success") : "unavailable",
		abortRequested: task.abortRequested,
		...(input?.kind === "nested" && typeof input.parent === "number" ? { parentTaskId: String(input.parent) } : {}),
		...(result ? { resultEntryId: String(result.id) } : {}),
		...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
		...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
		receiptIds: [],
		textAvailable: Boolean(result && evidence?.text !== undefined),
		outputTruncated: Boolean(result && evidence?.truncated),
	};
}

export function projectEntry(entry: EntryRecord, durableId: number): ToolActivity | undefined {
	const evidence = resultEvidence(entry);
	if (!evidence || evidence.callId.length > 256 || evidence.toolName.length > 256) return undefined;
	return {
		activityId: `entry:${entry.id}`,
		callId: evidence.callId,
		toolName: evidence.toolName,
		source: "entry",
		inherited: entry.conversationId !== durableId,
		phase: "unavailable",
		toolResult: evidence.isError ? "error" : "success",
		abortRequested: false,
		resultEntryId: String(entry.id),
		receiptIds: [],
		textAvailable: evidence.text !== undefined,
		outputTruncated: evidence.truncated,
	};
}
