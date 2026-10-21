import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { projectRunAdmission } from "../runs/projection.ts";
import { type ConversationExecution, EXECUTION_LIMITS, type ExecutionTool } from "./contracts.ts";

/** Pure projection of the same committed LiveState as the partial; no asynchronous or historical reads. */
export function projectExecution(
	live: LiveState | undefined,
	view?: Pick<ConversationView, "conversation" | "entries">,
): ConversationExecution | undefined {
	if (!live?.run) return undefined;
	const run = projectRunAdmission(live, view);
	// Prove ownership and the COMPLETE ordered round before applying the presentation cap.
	// Neither a matching call ID nor the latest assistant entry is sufficient evidence.
	let anchors: NonNullable<ExecutionTool["anchor"]>[] | undefined;
	if (view && live.tools?.length) {
		for (const entry of view.entries) {
			if (
				entry.conversationId !== view.conversation.id ||
				entry.byTaskId !== live.run.taskId ||
				entry.kind !== "pi.assistant" ||
				entry.head ||
				entry.model?.length !== 1
			)
				continue;
			const message = entry.model[0];
			if (message?.role !== "assistant" || message.stopReason !== "toolUse") continue;
			const calls = message.content.flatMap((part, contentIndex) =>
				part.type === "toolCall" ? [{ part, contentIndex }] : [],
			);
			if (
				calls.length !== live.tools.length ||
				!calls.every(
					({ part }, index) => part.id === live.tools?.[index]?.callId && part.name === live.tools?.[index]?.name,
				)
			)
				continue;
			if (anchors) {
				anchors = undefined;
				break;
			}
			anchors = calls.map(({ contentIndex }) => ({
				assistantEntryId: String(entry.id),
				modelIndex: 0,
				contentIndex,
			}));
		}
	}
	const items: ExecutionTool[] = [];
	let total = 0,
		active = 0;
	for (const slots of [live.tools, live.nestedTools]) {
		for (const [index, slot] of (slots ?? []).entries()) {
			total++;
			if (slot.status !== "done") active++;
			// Do not truncate an identity and accidentally associate a different call. Counts retain omitted coverage.
			if (
				items.length >= EXECUTION_LIMITS.tools ||
				!slot.callId.length ||
				slot.callId.length > EXECUTION_LIMITS.label ||
				!slot.name.length ||
				slot.name.length > EXECUTION_LIMITS.label
			)
				continue;
			items.push({
				callId: slot.callId,
				name: slot.name,
				status: slot.status,
				...(slot.taskId === undefined ? {} : { taskId: String(slot.taskId) }),
				...("parentTaskId" in slot ? { parentTaskId: String(slot.parentTaskId) } : {}),
				...(slots === live.tools && anchors?.[index] ? { anchor: anchors[index] } : {}),
			});
		}
	}
	return {
		ownerTaskId: String(live.run.taskId),
		...(run === undefined ? {} : { run }),
		submissionIds: live.run.inputs.slice(0, EXECUTION_LIMITS.submissions).map(String),
		submissionCount: live.run.inputs.length,
		...(live.generation
			? {
					generation: {
						attempt: live.generation.attempt,
						...(live.generation.retry ? { retryAt: live.generation.retry.at } : {}),
						...(live.generation.deferred ? { deferredPollAt: live.generation.deferred.pollAt } : {}),
					},
				}
			: {}),
		tools: { items, total, active },
		blockingCompactionCount: live.compactions?.filter((item) => item.blocking).length ?? 0,
	};
}
