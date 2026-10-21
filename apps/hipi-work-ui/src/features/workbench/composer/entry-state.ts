import type { Conversation, Project, Scope } from "@hipi/work-runtime/contracts";

export type ProjectHomeState = "projectless" | "pending" | "error" | "ready";

/** A missing catalog page or failed metadata read never changes the selected destination. */
export function projectHomeState(
	projectId: string | null | undefined,
	project: Pick<Project, "projectId"> | undefined,
	failed: boolean,
): ProjectHomeState {
	if (projectId === null) return "projectless";
	if (failed) return "error";
	return projectId && project?.projectId === projectId ? "ready" : "pending";
}

/** Navigation intent, not the timing of metadata, decides whether a new-chat composer may exist. */
export function conversationEntryState(
	scope: Scope,
	conversation: Conversation | undefined,
): "home" | "pending" | "ready" {
	if (!scope.conversationId) return "home";
	return conversation?.workspaceId === scope.workspaceId && conversation.conversationId === scope.conversationId
		? "ready"
		: "pending";
}
