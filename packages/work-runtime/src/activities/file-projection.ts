import type { EntryRecord } from "@earendil-works/pi-durable";
import { parseFilePresentation } from "./file-presentation.ts";
import { object, type StoredTask } from "./projection.ts";

/** Only a proven local model-issued builtin result, never arbitrary tool details or JSON-looking output. */
export function projectFilePresentation(
	task: StoredTask,
	assistant: EntryRecord | undefined,
	entry: EntryRecord | undefined,
) {
	const input = object(task.input),
		outcome = object(task.state.outcome?.result);
	if (
		task.kind !== "pi.tool" ||
		input?.kind !== "model" ||
		!assistant ||
		!entry ||
		assistant.id !== input.assistant ||
		assistant.conversationId !== task.conversationId ||
		assistant.kind !== "pi.assistant" ||
		entry.id !== outcome?.entryId ||
		entry.conversationId !== task.conversationId ||
		entry.byTaskId !== task.id ||
		entry.kind !== "pi.tool-result" ||
		entry.model?.length !== 1
	)
		return undefined;
	const message = entry.model[0];
	if (message?.role !== "toolResult" || message.isError || message.toolCallId !== input.callId) return undefined;
	const calls = (assistant.model ?? []).flatMap((model) =>
		model.role === "assistant"
			? model.content.filter((part) => part.type === "toolCall" && part.id === input.callId)
			: [],
	);
	if (calls.length !== 1 || calls[0]?.type !== "toolCall") return undefined;
	const call = calls[0];
	const kind =
		call.name === "hipi_files_read"
			? "read"
			: call.name === "hipi_files_list"
				? "directory"
				: call.name === "hipi_files_save"
					? "save"
					: undefined;
	if (!kind || message.toolName !== call.name) return undefined;
	try {
		const value = parseFilePresentation(object(message.details)?.hipiFiles);
		if (
			value.result.kind !== kind ||
			value.target.rootId !== call.arguments.rootId ||
			value.target.path !== call.arguments.path
		)
			return undefined;
		if (
			value.result.kind === "read" &&
			(value.result.offset !== (call.arguments.offset ?? 0) ||
				(call.arguments.revision !== undefined && call.arguments.revision !== value.result.revision))
		)
			return undefined;
		if (
			value.result.kind === "save" &&
			(typeof call.arguments.text !== "string" ||
				new TextEncoder().encode(call.arguments.text).byteLength !== value.result.bytes)
		)
			return undefined;
		return value;
	} catch {
		return undefined;
	}
}
