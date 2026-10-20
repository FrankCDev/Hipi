import type { Params, PinnedConversation, PinnedConversationPage, Scope } from "@hipi/work-runtime/contracts";
import type { SidebarOrderAction } from "./drag-provider.tsx";

export const pinnedScopeKey = (scope: Scope) => `${scope.workspaceId}.${scope.conversationId}`;

/** Translate visible insertion targets to canonical scopes, never a replacement array of loaded pins. */
export function pinnedOrderActions(
	pages: readonly PinnedConversationPage[],
	items: readonly PinnedConversation[],
	blocked: boolean,
	reorder: (input: Params<"reorderPinnedConversation">) => void,
): Map<string, SidebarOrderAction> {
	const generation = pages[0]?.orderGeneration;
	const scopes = new Map<string, Scope>(items.map(({ conversation }) => [pinnedScopeKey(conversation), conversation]));
	const keys = items.map(({ conversation }) => pinnedScopeKey(conversation));
	const successor = pages.at(-1)?.nextPinnedScope ?? null;
	if (successor) scopes.set(pinnedScopeKey(successor), successor);
	const after = (index: number) => keys[index + 1] ?? (successor ? pinnedScopeKey(successor) : null);
	const disabled = blocked || generation === undefined || pages.some((page) => page.orderGeneration !== generation);
	return new Map(
		items.map(({ conversation }, index) => [
			pinnedScopeKey(conversation),
			{
				item: {
					id: pinnedScopeKey(conversation),
					group: "pinned",
					label: conversation.title,
					revision: `${generation}:${disabled}`,
					disabled,
					after: after(index),
					move: (before: string | null) => {
						if (disabled || generation === undefined) return;
						const anchor = before === null ? null : scopes.get(before);
						if (anchor === undefined) return;
						reorder({
							requestId: crypto.randomUUID(),
							moved: { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId },
							before: anchor ? { workspaceId: anchor.workspaceId, conversationId: anchor.conversationId } : null,
							expectedOrderGeneration: generation,
						});
					},
				},
				up: keys[index - 1],
				down: index < items.length - 1 ? after(index + 1) : undefined,
			},
		]),
	);
}
