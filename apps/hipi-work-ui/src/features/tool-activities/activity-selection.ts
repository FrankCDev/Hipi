import type { ToolActivityPage, ToolActivitySelector } from "@hipi/work-runtime/contracts";

/** Reject incomplete or cross-selector responses rather than silently attributing evidence. */
export function validateActivitySelection(
	page: ToolActivityPage,
	selector?: ToolActivitySelector,
	expectedCalls?: ReadonlyMap<string, string>,
) {
	if (selector?.kind !== "tasks") {
		if (page.unavailableTaskIds !== undefined) throw new Error("Unexpected task partition");
		if (
			selector?.kind === "message" &&
			page.items.some(
				(item) =>
					!item.anchor ||
					`${item.anchor.assistantEntryId}_${item.anchor.modelIndex}` !== selector.messageId ||
					(selector.contentIndex !== undefined && item.anchor.contentIndex !== selector.contentIndex),
			)
		)
			throw new Error("Activity anchor mismatch");
		return;
	}
	if (!page.unavailableTaskIds || page.nextCursor !== null) throw new Error("Missing task partition");
	const requested = new Set(selector.taskIds);
	const seen = new Set<string>();
	for (const item of page.items) {
		if (
			!item.taskId ||
			!requested.has(item.taskId) ||
			seen.has(item.taskId) ||
			(expectedCalls?.has(item.taskId) && expectedCalls.get(item.taskId) !== item.callId)
		)
			throw new Error("Activity task mismatch");
		seen.add(item.taskId);
	}
	for (const id of page.unavailableTaskIds) {
		if (!requested.has(id) || seen.has(id)) throw new Error("Invalid unavailable task partition");
		seen.add(id);
	}
	if (seen.size !== requested.size) throw new Error("Incomplete task partition");
}
