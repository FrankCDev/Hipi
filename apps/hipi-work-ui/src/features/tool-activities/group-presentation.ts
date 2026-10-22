import { parseMessagePublicBlocks, type Snapshot, type ToolActivity } from "@hipi/work-runtime/contracts";

export type ToolGroupPresentation =
	| { kind: "summary"; key: "summary"; completed?: true }
	| { kind: "active"; key: string; toolName: string; status: "pending" | "running" };
export const settledToolGroup: ToolGroupPresentation = { kind: "summary", key: "summary" };

/** Latest means the latest rendered unit, including text, not merely the last tool.
 * Missing source/order/slot coverage cannot establish the reference active header. */
export function projectToolGroupPresentation(
	snapshot: Snapshot | undefined,
	messageId: string,
	contentIndexes: readonly number[] | undefined,
	active: boolean,
	activities: readonly ToolActivity[] = [],
): ToolGroupPresentation {
	// Suppressing an active header is not completion proof. A disconnected or
	// incompletely observed live turn must retain its existing unknown fallback.
	if (snapshot?.running === false) return { kind: "summary", key: "summary", completed: true };
	const execution = snapshot?.execution;
	if (
		!active ||
		!snapshot?.running ||
		!execution ||
		execution.tools.items.length !== execution.tools.total ||
		snapshot.partialLength > 0 ||
		snapshot.partial.length > 0
	)
		return settledToolGroup;
	const index = snapshot.messages.findIndex((message) => message.id === messageId);
	const message = snapshot.messages[index];
	if (
		!message ||
		message.role !== "assistant" ||
		message.truncated ||
		message.text.length !== message.textLength ||
		!message.publicBlocks ||
		message.publicBlocks.omitted ||
		!message.toolCalls ||
		message.toolCalls.items.length !== message.toolCalls.total ||
		snapshot.messages.slice(index + 1).some((later) => later.textLength > 0 || (later.toolCalls?.total ?? 0) > 0)
	)
		return settledToolGroup;
	let trailingTools: number[] = [];
	try {
		for (const block of parseMessagePublicBlocks(message.publicBlocks, message).items) {
			if (block.kind === "text") {
				if (block.end > block.start) trailingTools = [];
			} else trailingTools.push(block.contentIndex);
		}
	} catch {
		return settledToolGroup;
	}
	const selected = contentIndexes ?? message.toolCalls.items.map((tool) => tool.contentIndex);
	if (
		trailingTools.length === 0 ||
		selected.length !== trailingTools.length ||
		selected.some((value, position) => value !== trailingTools[position])
	)
		return settledToolGroup;
	let latest: { index: number; presentation: ToolGroupPresentation } | undefined;
	const seen = new Set<number>();
	for (const tool of execution.tools.items) {
		if (tool.status === "done") continue;
		const matches = activities.filter((item) => item.taskId === tool.taskId && item.callId === tool.callId);
		const anchor = tool.anchor ?? (tool.taskId && matches.length === 1 ? matches[0]?.anchor : undefined);
		// Nested or unresolved current slots cannot be placed by name or call ID alone.
		if (!anchor) return settledToolGroup;
		const anchorId = `${anchor.assistantEntryId}_${anchor.modelIndex}`;
		const anchorMessage = snapshot.messages.find((item) => item.id === anchorId);
		const descriptor = anchorMessage?.toolCalls?.items.find((item) => item.contentIndex === anchor.contentIndex);
		if (
			!descriptor ||
			descriptor.callId !== tool.callId ||
			descriptor.name !== tool.name ||
			(anchorId === messageId && seen.has(anchor.contentIndex))
		)
			return settledToolGroup;
		if (anchorId !== messageId || !selected.includes(anchor.contentIndex)) continue;
		seen.add(anchor.contentIndex);
		if (!latest || anchor.contentIndex > latest.index)
			latest = {
				index: anchor.contentIndex,
				presentation: {
					kind: "active",
					key: JSON.stringify([messageId, anchor.contentIndex, tool.callId]),
					toolName: tool.name,
					status: tool.status,
				},
			};
	}
	return latest?.presentation ?? settledToolGroup;
}
