import type {
	Conversation,
	PinnedConversation,
	PinnedConversationPage,
	ProjectListItem,
	SidebarPinItem,
	SidebarPinPage,
} from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { ConversationActions } from "../catalog/controls.tsx";
import { CatalogPagination } from "../catalog/pagination.tsx";
import type { CatalogSession } from "../catalog/session.ts";
import { useCatalogPages } from "../catalog/use-pages.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import type { SidebarOrderAction } from "./drag-provider.tsx";
import { mixedPinKey, mixedPinOrderActions, pinKey } from "./mixed-pin-order-actions.ts";
import { sidebarOrderLabels } from "./order-labels.ts";
import { navigationFocusSettled, PinFocusRecovery, projectFocusSettled } from "./pin-focus-recovery.ts";
import { pinLabels } from "./pin-labels.ts";
import { pinnedOrderActions, pinnedScopeKey } from "./pinned-order-actions.ts";
import type { PresentationSession } from "./presentation-session.ts";
import { SidebarOrderSection, SidebarSectionContent, SidebarSectionHeading } from "./section.tsx";

function ownsFocus(element: HTMLElement, target: EventTarget | null) {
	if (!(target instanceof Element)) return false;
	const row = element.closest("[data-pinned-conversation], [data-pinned-project]");
	if (row?.contains(target)) return true;
	const menu = target.closest('[role="menu"]');
	const labelledBy = menu?.getAttribute("aria-labelledby");
	return !!labelledBy && Array.from(row?.querySelectorAll("[id]") ?? []).some((item) => item.id === labelledBy);
}

export function PinnedConversations({
	catalog,
	presentation,
	onSelect,
	sectionAction,
	onVisibleChange,
	collapsed,
	disclosureDisabled,
	onCollapsedChange,
	navigationRevision,
	renderProject,
	mixed = renderProject !== undefined,
	mixedReady = true,
}: {
	catalog: CatalogSession;
	presentation: PresentationSession;
	onSelect: (conversation: Conversation) => void;
	sectionAction?: SidebarOrderAction;
	onVisibleChange?: (visible: boolean) => void;
	collapsed?: boolean;
	disclosureDisabled?: boolean;
	onCollapsedChange?: (collapsed: boolean) => void;
	navigationRevision?: number;
	mixed?: boolean;
	renderProject?: (item: ProjectListItem, orderAction: SidebarOrderAction | undefined) => ReactNode;
	mixedReady?: boolean;
}) {
	const client = useAppClient();
	const cache = useQueryClient();
	const { locale } = usePreferences();
	const l = pinLabels(locale);
	const headingId = useId();
	const [announcement, setAnnouncement] = useState("");
	const region = useRef<HTMLElement>(null);
	const focused = useRef<
		| (
				| { element: HTMLElement; workspaceId: string; conversationId: string }
				| { element: HTMLElement; projectId: string }
		  )
		| null
	>(null);
	const confirmedUnpin = useRef<HTMLElement | null>(null);
	const pendingUnpin = useRef<{ requestId: string; element: HTMLElement } | null>(null);
	const focusRecovery = useMemo(() => new PinFocusRecovery(), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Navigation/collapse changes revoke focus intent even when the same DOM survives.
	useLayoutEffect(() => {
		focused.current = null;
		confirmedUnpin.current = null;
		pendingUnpin.current = null;
		focusRecovery.cancel();
		return () => focusRecovery.cancel();
	}, [focusRecovery, navigationRevision, collapsed]);
	useEffect(() => {
		const cancel = () => {
			focusRecovery.cancel();
			if (pendingUnpin.current || confirmedUnpin.current) focused.current = null;
			pendingUnpin.current = null;
			confirmedUnpin.current = null;
		};
		const focus = (event: FocusEvent) => {
			const previous = focused.current;
			if (previous && !ownsFocus(previous.element, event.target)) {
				cancel();
				focused.current = null;
			}
		};
		const blur = (event: FocusEvent) => {
			const previous = focused.current;
			if (
				previous?.element.isConnected &&
				event.relatedTarget === null &&
				event.target instanceof Element &&
				previous.element.closest("[data-pinned-conversation], [data-pinned-project]")?.contains(event.target)
			) {
				cancel();
				focused.current = null;
			}
		};
		document.addEventListener("pointerdown", cancel, true);
		document.addEventListener("keydown", cancel, true);
		document.addEventListener("focusin", focus, true);
		document.addEventListener("focusout", blur, true);
		window.addEventListener("blur", cancel);
		return () => {
			document.removeEventListener("pointerdown", cancel, true);
			document.removeEventListener("keydown", cancel, true);
			document.removeEventListener("focusin", focus, true);
			document.removeEventListener("focusout", blur, true);
			window.removeEventListener("blur", cancel);
		};
	}, [focusRecovery]);
	useEffect(
		() =>
			presentation.subscribePinLifecycle((event) => {
				const owner = focused.current;
				const previous = owner && "workspaceId" in owner ? owner : null;
				if (event.phase === "initiated") {
					if (previous && !ownsFocus(previous.element, document.activeElement)) focused.current = null;
					pendingUnpin.current =
						!event.input.pinned &&
						previous &&
						ownsFocus(previous.element, document.activeElement) &&
						event.input.workspaceId === previous.workspaceId &&
						event.input.conversationId === previous.conversationId
							? { requestId: event.input.requestId, element: previous.element }
							: null;
					return;
				}
				if (pendingUnpin.current?.requestId !== event.input.requestId) return;
				if (event.phase === "retired") {
					pendingUnpin.current = null;
					return;
				}
				if (
					event.phase === "confirmed" &&
					!event.result.pinned &&
					previous &&
					pendingUnpin.current?.element === previous.element &&
					event.result.workspaceId === previous.workspaceId &&
					event.result.conversationId === previous.conversationId
				)
					confirmedUnpin.current = previous.element;
				if (event.phase === "confirmed") pendingUnpin.current = null;
			}),
		[presentation],
	);
	useEffect(() => {
		if (!mixed) return;
		return catalog.subscribeProjectPinLifecycle((event) => {
			const owner = focused.current;
			const previous = owner && "projectId" in owner ? owner : null;
			if (event.phase === "initiated") {
				if (previous && !ownsFocus(previous.element, document.activeElement)) focused.current = null;
				pendingUnpin.current =
					!event.input.pinned &&
					previous &&
					ownsFocus(previous.element, document.activeElement) &&
					event.input.projectId === previous.projectId
						? { requestId: event.input.requestId, element: previous.element }
						: null;
				return;
			}
			if (pendingUnpin.current?.requestId !== event.input.requestId) return;
			if (event.phase === "retired") {
				pendingUnpin.current = null;
				return;
			}
			if (
				event.phase === "confirmed" &&
				!event.result.pinned &&
				previous &&
				pendingUnpin.current.element === previous.element &&
				event.result.projectId === previous.projectId
			)
				confirmedUnpin.current = previous.element;
			if (event.phase === "confirmed") pendingUnpin.current = null;
		});
	}, [catalog, mixed]);
	const state = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot, presentation.getSnapshot);
	const legacyPages = useCatalogPages<PinnedConversation, PinnedConversationPage>({
		enabled: !mixed,
		queryKey: ["pinned-conversations"],
		queryPage: (cursor, signal) => client.call("listPinnedConversations", cursor ? { cursor } : {}, signal),
		itemKey: (item: PinnedConversation) => `${item.conversation.workspaceId}.${item.conversation.conversationId}`,
	});
	const mixedPages = useCatalogPages<SidebarPinItem, SidebarPinPage>({
		enabled: mixed && mixedReady,
		queryKey: ["sidebar-pins"],
		queryPage: (cursor, signal) => client.call("listSidebarPins", cursor ? { cursor } : {}, signal),
		itemKey: (item) => mixedPinKey(pinKey(item)),
	});
	const pages = mixed ? mixedPages : legacyPages;
	const rows: (SidebarPinItem | ({ kind: "conversation" } & PinnedConversation))[] = mixed
		? mixedReady
			? mixedPages.items
			: []
		: legacyPages.items.map((item) => ({ kind: "conversation", ...item }));
	const blocked =
		state.busy || !!state.pending || state.incompatible || pages.isFetching || pages.isError || (mixed && !mixedReady);
	const legacyActions = pinnedOrderActions(legacyPages.pages, legacyPages.items, blocked, (input) => {
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
	const mixedActions = mixedPinOrderActions(mixedPages.pages, mixedPages.items, blocked, (input) => {
		setAnnouncement("");
		void presentation.reorderMixed(input).then(() => {
			const current = presentation.getSnapshot().mixedOrderResult;
			if (!current) return;
			const index = current.items.findIndex((item) => mixedPinKey(pinKey(item)) === mixedPinKey(input.moved));
			setAnnouncement(
				index >= 0 ? `${sidebarOrderLabels(locale).movedTo} ${index + 1}` : sidebarOrderLabels(locale).moved,
			);
			void cache.invalidateQueries({ queryKey: ["sidebar-pins"] });
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
		const fallback = region.current ?? document.querySelector<HTMLElement>(".navigation-list");
		const root = fallback?.closest<HTMLElement>("[data-sidebar-navigation-root]");
		if (fallback && root) {
			if ("projectId" in previous)
				focusRecovery.restoreProject(
					previous.projectId,
					root,
					fallback,
					confirmedUnpin.current === previous.element,
					() => projectFocusSettled(root, cache),
				);
			else
				focusRecovery.restore(previous, root, fallback, confirmedUnpin.current === previous.element, () =>
					navigationFocusSettled(root, cache, previous),
				);
		} else fallback?.focus({ preventScroll: true });
		confirmedUnpin.current = null;
	});
	const visible = pages.items.length > 0 || pages.isError || pages.hasMore;
	useEffect(() => onVisibleChange?.(visible), [visible, onVisibleChange]);
	if (!visible) return null;
	const content = (
		<section
			ref={region}
			className="pinned-conversations"
			aria-labelledby={headingId}
			tabIndex={-1}
			onFocusCapture={(event) => {
				const row = event.target.closest<HTMLElement>("[data-pinned-conversation], [data-pinned-project]");
				if (row?.dataset.projectId && row.hasAttribute("data-pinned-project")) {
					focusRecovery.cancel();
					focused.current = { element: event.target, projectId: row.dataset.projectId };
				} else if (row?.dataset.workspaceId && row.dataset.conversationId) {
					focusRecovery.cancel();
					focused.current = {
						element: event.target,
						workspaceId: row.dataset.workspaceId,
						conversationId: row.dataset.conversationId,
					};
				}
			}}
		>
			<SidebarSectionHeading titleId={headingId}>{l.pinned}</SidebarSectionHeading>
			<SidebarSectionContent>
				{(pages.isPending || (mixed && !mixedReady)) && <output className="nav-feedback">{l.loading}</output>}
				{pages.isError && (
					<div className="nav-feedback" role="alert">
						<p>{l.listError}</p>
						<Button variant="ghost" size="sm" disabled={pages.isFetching} onClick={() => void pages.retry()}>
							{l.reload}
						</Button>
					</div>
				)}
				<ul className="workspace-tree conversation-list">
					{rows.map((item) => {
						if (item.kind === "project") return renderProject?.(item, mixedActions.get(mixedPinKey(pinKey(item))));
						const { conversation } = item;
						return (
							<li
								key={`${conversation.workspaceId}.${conversation.conversationId}`}
								data-pinned-conversation=""
								data-catalog-key={
									mixed
										? mixedPinKey({
												kind: "conversation",
												workspaceId: conversation.workspaceId,
												conversationId: conversation.conversationId,
											})
										: `${conversation.workspaceId}.${conversation.conversationId}`
								}
								data-workspace-id={conversation.workspaceId}
								data-conversation-id={conversation.conversationId}
							>
								<ConversationPreview
									conversation={conversation}
									resolveWorkspace={!mixed}
									projectId={mixed && "membership" in item ? item.membership.projectId : undefined}
									orderAction={
										mixed
											? mixedActions.get(
													mixedPinKey({
														kind: "conversation",
														workspaceId: conversation.workspaceId,
														conversationId: conversation.conversationId,
													}),
												)
											: legacyActions.get(pinnedScopeKey(conversation))
									}
									location={{ kind: "pinned" }}
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
						);
					})}
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
