import type { ConversationExecution, Scope, ToolApproval } from "@hipi/work-runtime/contracts";

/** A retained pending proposal is not proof that this run is waiting for it. */
export function matchesExecutionApproval(
	approval: ToolApproval | null,
	scope: Scope,
	execution: ConversationExecution | undefined,
	now: number,
): approval is ToolApproval {
	return (
		!!approval &&
		!!execution &&
		approval.status === "pending" &&
		approval.expiresAt > now &&
		approval.workspaceId === scope.workspaceId &&
		approval.conversationId === scope.conversationId &&
		approval.submissionIds.some((id) => execution.submissionIds.includes(id)) &&
		execution.tools.items.some(
			(tool) => tool.status !== "done" && tool.taskId === approval.taskId && tool.callId === approval.callId,
		)
	);
}
