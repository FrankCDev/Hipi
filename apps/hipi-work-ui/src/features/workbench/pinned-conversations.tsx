import type { Conversation, PinnedConversation } from "@hipi/work-runtime/contracts";
import { useId, useLayoutEffect, useRef } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ConversationActions } from "./catalog-controls.tsx";
import { CatalogPagination } from "./catalog-pagination.tsx";
import type { CatalogSession } from "./catalog-session.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import { pinLabels } from "./pin-labels.ts";
import type { PresentationSession } from "./presentation-session.ts";
import { useCatalogPages } from "./use-catalog-pages.ts";

export function PinnedConversations({
	catalog,
	presentation,
	selectedWorkspace,
	selectedConversation,
	search,
	onSelect,
}: {
	catalog: CatalogSession;
	presentation: PresentationSession;
	selectedWorkspace: string;
	selectedConversation: string;
	search: string;
	onSelect: (conversation: Conversation) => void;
}) {
	const client = useAppClient();
	const { locale } = usePreferences();
	const l = pinLabels(locale);
	const headingId = useId();
	const region = useRef<HTMLElement>(null);
	const focused = useRef<{ element: HTMLElement; workspaceId: string; conversationId: string } | null>(null);
	const pages = useCatalogPages({
		queryKey: ["pinned-conversations"],
		queryPage: (cursor, signal) => client.call("listPinnedConversations", cursor ? { cursor } : {}, signal),
		itemKey: (item: PinnedConversation) => `${item.conversation.workspaceId}.${item.conversation.conversationId}`,
	});
	const visible = pages.items.filter(({ conversation }) =>
		conversation.title.toLocaleLowerCase(locale).includes(search.trim().toLocaleLowerCase(locale)),
	);
	useLayoutEffect(() => {
		const previous = focused.current;
		if (!previous || previous.element.isConnected || document.activeElement !== document.body) return;
		focused.current = null;
		// Unpin removes a shortcut, not its conversation. Return to the surviving canonical row.
		const target = Array.from(document.querySelectorAll<HTMLButtonElement>(".conversation-link")).find(
			(item) =>
				item.dataset.workspaceId === previous.workspaceId &&
				item.dataset.conversationId === previous.conversationId &&
				item.getClientRects().length > 0,
		);
		(target ?? region.current ?? document.querySelector<HTMLElement>(".navigation-list"))?.focus({
			preventScroll: true,
		});
	});
	if (!visible.length && !pages.isError && !pages.isPending) return null;
	return (
		<section
			ref={region}
			className="pinned-conversations"
			aria-labelledby={headingId}
			tabIndex={-1}
			onFocusCapture={(event) => {
				const row = event.target.closest<HTMLElement>("[data-pinned-conversation]");
				if (row?.dataset.workspaceId && row.dataset.conversationId)
					focused.current = {
						element: event.target,
						workspaceId: row.dataset.workspaceId,
						conversationId: row.dataset.conversationId,
					};
			}}
		>
			<h3 id={headingId} className="nav-section-heading">
				{l.pinned}
			</h3>
			{pages.isPending && <output className="nav-feedback">{l.loading}</output>}
			{pages.isError && (
				<div className="nav-feedback" role="alert">
					<p>{l.listError}</p>
					<Button variant="ghost" size="sm" disabled={pages.isFetching} onClick={() => void pages.retry()}>
						{l.reload}
					</Button>
				</div>
			)}
			<ul className="workspace-tree conversation-list">
				{visible.map(({ conversation }) => (
					<li
						key={`${conversation.workspaceId}.${conversation.conversationId}`}
						data-pinned-conversation=""
						data-workspace-id={conversation.workspaceId}
						data-conversation-id={conversation.conversationId}
					>
						<ConversationPreview
							conversation={conversation}
							selected={
								selectedWorkspace === conversation.workspaceId && selectedConversation === conversation.conversationId
							}
							onSelect={() => onSelect(conversation)}
							renderActions={(controls) => (
								<ConversationActions
									conversation={conversation}
									session={catalog}
									presentation={presentation}
									guard={(action) => action()}
									{...controls}
								/>
							)}
						/>
					</li>
				))}
			</ul>
			<CatalogPagination pages={pages} listRef={region} />
		</section>
	);
}
