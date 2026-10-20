import {
	type AppClient,
	AppError,
	type ConversationSearchHit,
	type Scope,
	type SearchHistoryWindow,
} from "@hipi/work-runtime/contracts";

export async function readSearchHistoryWindow(
	client: AppClient,
	scope: Scope,
	locator: string,
	signal: AbortSignal,
	cursor?: string,
): Promise<SearchHistoryWindow> {
	const page = await client.call(
		"getHistoryAroundMatch",
		{ workspaceId: scope.workspaceId, conversationId: scope.conversationId, locator, ...(cursor ? { cursor } : {}) },
		signal,
	);
	if (
		page.workspaceId !== scope.workspaceId ||
		page.conversationId !== scope.conversationId ||
		page.target.workspaceId !== scope.workspaceId ||
		page.target.conversationId !== scope.conversationId ||
		page.matchStart < page.target.offset ||
		page.matchEnd <= page.matchStart ||
		page.matchEnd > page.target.offset + page.target.text.length
	)
		throw new AppError("INVALID_REQUEST");
	return page;
}

/** Resolve everything before navigation, so a stale match never replaces the current reader. */
export async function prepareSearchNavigation(client: AppClient, hit: ConversationSearchHit, signal: AbortSignal) {
	const scope = { workspaceId: hit.workspaceId, conversationId: hit.conversationId };
	const [conversation, window] = await Promise.all([
		client.call("getConversation", scope, signal),
		hit.kind === "message" ? readSearchHistoryWindow(client, scope, hit.locator, signal) : undefined,
	]);
	if (
		conversation.workspaceId !== scope.workspaceId ||
		conversation.conversationId !== scope.conversationId ||
		(window &&
			(hit.kind !== "message" ||
				window.target.messageId !== hit.messageId ||
				window.matchStart !== hit.matchStart ||
				window.matchEnd !== hit.matchEnd ||
				!window.messages.some(
					(message) => message.id === hit.messageId && message.textLength === window.target.textLength,
				)))
	)
		throw new AppError("INVALID_REQUEST");
	if (conversation.archivedAt !== null) throw new AppError("CONVERSATION_ARCHIVED");
	return { conversation, anchor: window && hit.kind === "message" ? { window, locator: hit.locator } : undefined };
}

export async function readHistoryPage(client: AppClient, scope: Scope, cursor: string, signal: AbortSignal) {
	const page = await client.call("getHistory", { ...scope, cursor }, signal);
	if (page.workspaceId !== scope.workspaceId || page.conversationId !== scope.conversationId)
		throw new AppError("INVALID_REQUEST");
	return page;
}

export async function readMessagePage(
	client: AppClient,
	scope: Scope,
	messageId: string,
	textLength: number,
	offset: number,
	signal: AbortSignal,
) {
	const page = await client.call("getMessageText", { ...scope, messageId, offset }, signal);
	if (
		page.workspaceId !== scope.workspaceId ||
		page.conversationId !== scope.conversationId ||
		page.messageId !== messageId ||
		page.textLength !== textLength ||
		(page.offset !== offset &&
			!(
				offset > 0 &&
				page.offset === offset - 1 &&
				page.text.charCodeAt(0) >= 0xd800 &&
				page.text.charCodeAt(0) <= 0xdbff &&
				page.text.charCodeAt(1) >= 0xdc00 &&
				page.text.charCodeAt(1) <= 0xdfff
			))
	)
		throw new AppError("INVALID_REQUEST");
	return page;
}
