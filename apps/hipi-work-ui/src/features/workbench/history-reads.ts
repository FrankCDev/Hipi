import { type AppClient, AppError, type Scope } from "@hipi/work-runtime/contracts";

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
