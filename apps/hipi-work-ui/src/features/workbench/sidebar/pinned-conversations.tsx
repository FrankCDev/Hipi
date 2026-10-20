import type { Conversation, PinnedConversation, PinnedConversationPage } from "@hipi/work-runtime/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { ConversationActions } from "../catalog/controls.tsx";
import { CatalogPagination } from "../catalog/pagination.tsx";
import type { CatalogSession } from "../catalog/session.ts";
import { useCatalogPages } from "../catalog/use-pages.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import type { SidebarOrderAction } from "./drag-provider.tsx";
import { sidebarOrderLabels } from "./order-labels.ts";
import { pinLabels } from "./pin-labels.ts";
import { pinnedOrderActions, pinnedScopeKey } from "./pinned-order-actions.ts";
import type { PresentationSession } from "./presentation-session.ts";
import { SidebarOrderSection, SidebarSectionContent, SidebarSectionHeading } from "./section.tsx";

export function PinnedConversations({
	catalog,
	presentation,
	selectedWorkspace,
	selectedConversation,
	onSelect,
	sectionAction,
	onVisibleChange,
	collapsed,
	disclosureDisabled,
	onCollapsedChange,
}: {
	catalog: CatalogSession;
	presentation: PresentationSession;
	selectedWorkspace: string;
	selectedConversation: string;
	onSelect: (conversation: Conversation) => void;
	sectionAction?: SidebarOrderAction;
	onVisibleChange?: (visible: boolean) => void;
	collapsed?: boolean;
	disclosureDisabled?: boolean;
	onCollapsedChange?: (collapsed: boolean) => void;
}) {
	const client = useAppClient();
	const { locale } = usePreferences();
	const l = pinLabels(locale);
	const headingId = useId();
	const [announcement, setAnnouncement] = useState("");
	const region = useRef<HTMLElement>(null);
	const focused = useRef<{ element: HTMLElement; workspaceId: string; conversationId: string } | null>(null);
	const state = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot, presentation.getSnapshot);
	const pages = useCatalogPages<PinnedConversation, PinnedConversationPage>({
		queryKey: ["pinned-conversations"],
		queryPage: (cursor, signal) => client.call("listPinnedConversations", cursor ? { cursor } : {}, signal),
		itemKey: (item: PinnedConversation) => `${item.conversation.workspaceId}.${item.conversation.conversationId}`,
	});
	const blocked = state.busy || !!state.pending || state.incompatible || pages.isFetching || pages.isError;
	const actions = pinnedOrderActions(pages.pages, pages.items, blocked, (input) => {
		setAnnouncement("");
		void presentation.reorder(input).then(() => {
			const current = presentation.getSnapshot().orderResult;
			if (!current) return;
			const index = current.items.findIndex(
				({ conversation }) => pinnedScopeKey(conversation) === pinnedScopeKey(input.moved),
			);
			setAnnouncement(
				index >= 0 ? `${sidebarOrderLabels(locale).movedTo} ${index + 1}` : sidebarOrderLabels(locale).moved,
			);
		});
	});
	useLayoutEffect(() => {
		if (collapsed) {
			focused.current = null;
			return;
		}
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
	const visible = pages.items.length > 0 || pages.isError || pages.isPending;
	useEffect(() => onVisibleChange?.(visible), [visible, onVisibleChange]);
	if (!visible) return null;
	const content = (
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
			<SidebarSectionHeading titleId={headingId}>{l.pinned}</SidebarSectionHeading>
			<SidebarSectionContent>
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
					{pages.items.map(({ conversation }) => (
						<li
							key={`${conversation.workspaceId}.${conversation.conversationId}`}
							data-pinned-conversation=""
							data-workspace-id={conversation.workspaceId}
							data-conversation-id={conversation.conversationId}
						>
							<ConversationPreview
								conversation={conversation}
								resolveWorkspace
								orderAction={actions.get(pinnedScopeKey(conversation))}
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
				<output className="sr-only" aria-live="polite">
					{announcement}
				</output>
			</SidebarSectionContent>
		</section>
	);
	return sectionAction ? (
		<SidebarOrderSection
			action={sectionAction}
			collapsed={collapsed}
			disabled={disclosureDisabled}
			onCollapsedChange={onCollapsedChange}
		>
			{content}
		</SidebarOrderSection>
	) : (
		content
	);
}
