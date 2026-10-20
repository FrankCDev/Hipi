type CanonicalSelection = { workspaceId: string; conversationId: string };

/** Until logical projects exist, the canonical conversation scope is the project identity. */
export function newChatDestination(input: {
	explicitWorkspaceId?: string | null;
	selectedConversation: CanonicalSelection | null;
	selectedWorkspaceId: string | null;
	defaultWorkspaceId: string | null;
}): string | null {
	const selected =
		input.explicitWorkspaceId !== undefined
			? input.explicitWorkspaceId
			: input.selectedConversation
				? input.selectedConversation.workspaceId
				: input.selectedWorkspaceId;
	// Do not infer identity from a display name, partial sidebar rows, or a fallback project.
	if (selected === null || selected === "" || selected === input.defaultWorkspaceId) return null;
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(selected)) throw new Error("INVALID_NEW_CHAT_DESTINATION");
	return selected;
}
