import type {
	Conversation,
	ConversationFilter,
	Scope,
	SidebarConversation,
	SidebarView,
} from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { ConversationActions } from "../catalog/controls.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import type { CatalogSession } from "../catalog/session.ts";
import { projectLabels } from "../projects/labels.ts";
import { ConversationPreview } from "./conversation-preview.tsx";
import { useSidebarDragging } from "./drag-provider.tsx";
import type { PresentationSession } from "./presentation-session.ts";
import { SidebarSectionContent, SidebarSectionHeading, useSidebarSection } from "./section.tsx";
import { useRecentVirtualizer } from "./use-recent-virtualizer.ts";
import { WindowInteractionContext } from "./window-interaction.tsx";
import {
	advanceSlice,
	initialSlice,
	presentedWindow,
	reconcileWindowSlice,
	type WindowSlice,
} from "./window-presentation.ts";
import {
	discardRecentWindowStaging,
	fetchRecentWindow,
	type RecentWindow,
	recentWindowOptions,
	scopeKey,
	type WindowIntent,
	windowItems,
	windowKey,
} from "./window-query.ts";
import {
	captureWindowAnchor,
	captureWindowAnchors,
	restoreWindowAnchor,
	type ViewportAnchor,
} from "./window-viewport.ts";
import "./recent-conversations.css";

export function RecentConversations({
	catalog,
	presentation,
	onSelect,
	selected,
	logicalReady,
	visible: surfaceVisible = true,
	last = false,
	scrollRef,
	filter,
	filterMenu,
}: {
	catalog: CatalogSession;
	presentation?: PresentationSession;
	onSelect: (conversation: Conversation) => void;
	selected?: Scope;
	logicalReady: boolean;
	visible?: boolean;
	last?: boolean;
	scrollRef?: RefObject<HTMLElement | null>;
	filter: ConversationFilter;
	filterMenu: ReactNode;
}) {
	const client = useAppClient();
	const cache = useQueryClient();
	const { t, locale } = usePreferences();
	const labels = catalogLabels(locale);
	const [documentVisible, setDocumentVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const update = () => setDocumentVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	const visible = surfaceVisible && documentVisible;
	const collapsed = useSidebarSection()?.collapsed ?? false;
	const dragging = useSidebarDragging();
	const region = useRef<HTMLElement>(null);
	const top = useRef<HTMLLIElement>(null);
	const bottom = useRef<HTMLLIElement>(null);
	const heading = useId();
	const [committed, setCommitted] = useState<RecentWindow>();
	const [slice, setSlice] = useState<WindowSlice>(initialSlice(0));
	const [focused, setFocused] = useState<Scope>();
	const focusElement = useRef<HTMLElement | null>(null);
	const controlOrigin = useRef<HTMLButtonElement | null>(null);
	const [interactionRevision, setInteractionRevision] = useState(0);
	const held = useRef(new Set<string>());
	const heldKeys = useRef(new Map<string, string>());
	const hold = useCallback((owner: string, value: boolean, element?: HTMLElement | null) => {
		const had = held.current.has(owner);
		if (value) {
			held.current.add(owner);
			const row = element?.closest<HTMLElement>("[data-window-row]");
			if (row?.dataset.workspaceId && row.dataset.conversationId)
				heldKeys.current.set(
					owner,
					scopeKey({ workspaceId: row.dataset.workspaceId, conversationId: row.dataset.conversationId }),
				);
		} else {
			held.current.delete(owner);
			heldKeys.current.delete(owner);
		}
		if (had !== value) setInteractionRevision((n) => n + 1);
	}, []);
	const view: SidebarView = { kind: logicalReady ? "project_recent" : "recent" };
	const identity = JSON.stringify(windowKey(view, filter));
	const state = useRef({ committed, slice, focused, selected, visible, collapsed, dragging, identity });
	state.current = { committed, slice, focused, selected, visible, collapsed, dragging, identity };
	const viewport = useCallback(
		() => scrollRef?.current ?? region.current?.closest<HTMLElement>(".navigation-list") ?? null,
		[scrollRef],
	);
	const scrollIntent = useRef(0);
	useEffect(() => {
		const root = viewport();
		if (!root) return;
		const intent = () => {
			scrollIntent.current++;
		};
		for (const kind of ["wheel", "touchmove", "pointerdown", "keydown"])
			root.addEventListener(kind, intent, { passive: true });
		return () => {
			for (const kind of ["wheel", "touchmove", "pointerdown", "keydown"]) root.removeEventListener(kind, intent);
		};
	}, [viewport]);
	const capture = useCallback((): Omit<WindowIntent, "action"> => {
		const current = state.current;
		const anchor = captureWindowAnchor(
			region.current,
			scrollRef?.current ?? region.current?.closest<HTMLElement>(".navigation-list") ?? null,
		)?.scope;
		const rows = windowItems(current.committed);
		const index = anchor ? rows.findIndex((row) => scopeKey(row.conversation) === scopeKey(anchor)) : -1;
		const retainedScopes = [
			...new Map(
				[current.focused, current.selected]
					.filter((scope): scope is Scope => !!scope)
					.map((scope) => [scopeKey(scope), scope]),
			).values(),
		];
		return {
			anchor,
			targetCount: rows.length,
			neighbors:
				index < 0
					? []
					: rows
							.slice(Math.max(0, index - 1), index + 2)
							.map((row) => row.conversation)
							.filter((scope) => scopeKey(scope) !== scopeKey(anchor ?? scope))
							.slice(0, 2),
			retainedScopes,
		};
	}, [scrollRef]);
	const query = useQuery({
		...recentWindowOptions(cache, client, view, filter, capture),
		enabled: visible && !collapsed,
	});
	useEffect(() => {
		let active = true;
		if (!visible || collapsed) {
			const view: SidebarView = { kind: logicalReady ? "project_recent" : "recent" };
			void cache.cancelQueries({ queryKey: windowKey(view, filter), exact: true }).then(() => {
				if (!active) return;
				discardRecentWindowStaging(cache, view, filter);
				setCommitted((current) => {
					if (!current?.refresh) return current;
					const { refresh: _refresh, ...retained } = current;
					return retained;
				});
			});
		}
		return () => {
			active = false;
		};
	}, [cache, logicalReady, filter, visible, collapsed]);
	const selectedKey = selected ? scopeKey(selected) : null;
	useEffect(() => {
		if (!selectedKey || !query.data || query.isFetching || query.isError || !visible || collapsed) return;
		const current = query.data;
		if (
			windowItems(current).some((row) => scopeKey(row.conversation) === selectedKey) ||
			current.retained.eligible.some((proof) => scopeKey(proof.row.conversation) === selectedKey) ||
			current.retained.unavailable.some((proof) => scopeKey(proof.scope) === selectedKey) ||
			current.unpublished ||
			current.refreshPaused
		)
			return;
		void query.refetch({ cancelRefetch: false });
	}, [selectedKey, query.data, query.isFetching, query.isError, query.refetch, visible, collapsed]);
	const anchorToRestore = useRef<ViewportAnchor | undefined>(undefined);
	const restoreIntent = useRef(0);
	const resetToNewest = useRef(false);
	const [replacementNotice, setReplacementNotice] = useState(0);
	const retiredFocus = useRef<{ element: HTMLElement; scope: Scope } | undefined>(undefined);
	// Capture actual geometry immediately before publishing a candidate, never a guessed row height.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Portal ownership release rechecks a staged query result.
	useLayoutEffect(() => {
		const next = query.data;
		if (
			!next ||
			next === committed ||
			dragging ||
			held.current.size ||
			!visible ||
			collapsed ||
			document.visibilityState === "hidden"
		)
			return;
		if (focused) {
			const key = scopeKey(focused);
			const known =
				windowItems(next).some((row) => scopeKey(row.conversation) === key) ||
				next.retained.eligible.some((proof) => scopeKey(proof.row.conversation) === key);
			const unavailable = next.retained.unavailable.some((proof) => scopeKey(proof.scope) === key);
			if (!known && !unavailable && !next.unpublished) {
				if (!next.refreshPaused && !query.isFetching && !query.isError) void query.refetch({ cancelRefetch: false });
				return;
			}
			if (unavailable && focusElement.current && document.activeElement === focusElement.current)
				retiredFocus.current = { element: focusElement.current, scope: focused };
		}
		const anchors = captureWindowAnchors(region.current, viewport());
		const nextKeys = new Set([
			...windowItems(next).map((row) => scopeKey(row.conversation)),
			...next.retained.eligible.map((proof) => scopeKey(proof.row.conversation)),
		]);
		anchorToRestore.current = anchors.find((anchor) => nextKeys.has(scopeKey(anchor.scope)));
		restoreIntent.current = scrollIntent.current;
		resetToNewest.current = next.action === "refresh" && anchors.length > 0 && !anchorToRestore.current;
		if (controlOrigin.current !== document.activeElement) controlOrigin.current = null;
		setSlice(reconcileWindowSlice(committed, slice, next));
		setCommitted(next);
	}, [
		query.data,
		query.isFetching,
		query.isError,
		committed,
		slice,
		dragging,
		interactionRevision,
		visible,
		collapsed,
		focused,
		viewport,
		query.refetch,
	]);
	const pendingAction = useRef(false);
	const retry = async () => {
		const current = state.current;
		if (
			!current.visible ||
			current.collapsed ||
			current.dragging ||
			held.current.size ||
			query.isFetching ||
			pendingAction.current ||
			document.visibilityState === "hidden"
		)
			return;
		pendingAction.current = true;
		try {
			await fetchRecentWindow(cache, client, view, filter, "refresh", capture);
		} catch {
			/* The query retains the coherent snapshot and error. */
		} finally {
			pendingAction.current = false;
		}
	};
	const advance = async (direction: "next" | "previous", explicit = false) => {
		const current = state.current;
		if (
			!current.visible ||
			document.visibilityState === "hidden" ||
			current.collapsed ||
			current.dragging ||
			held.current.size ||
			pendingAction.current ||
			query.isFetching ||
			(!explicit && (query.isError || query.data?.paused || current.committed?.paused))
		)
			return;
		const rows = windowItems(current.committed);
		const canReveal = direction === "next" ? current.slice.end < rows.length : current.slice.start > 0;
		if (canReveal) {
			anchorToRestore.current = captureWindowAnchor(region.current, viewport());
			restoreIntent.current = scrollIntent.current;
			setSlice(advanceSlice(current.slice, rows.length, direction, !current.committed?.pages.at(-1)?.nextCursor));
			return;
		}
		const cursor =
			direction === "next" ? current.committed?.pages.at(-1)?.nextCursor : current.committed?.pages[0]?.previousCursor;
		if (!cursor || query.data?.refreshPaused || current.committed?.refreshPaused) return;
		pendingAction.current = true;
		try {
			await fetchRecentWindow(cache, client, view, filter, direction, capture);
		} catch {
			/* Query owns the retained window and retry. */
		} finally {
			pendingAction.current = false;
		}
	};
	const run = useRef(advance);
	run.current = advance;
	const rows = useMemo(() => windowItems(committed), [committed]);
	const refreshPaused = query.data?.refreshPaused ?? committed?.refreshPaused;
	const paused = query.data?.paused || committed?.paused;
	const canPrevious = slice.start > 0 || (!refreshPaused && !!committed?.pages[0]?.previousCursor);
	const canNext = slice.end < rows.length || (!refreshPaused && !!committed?.pages.at(-1)?.nextCursor);
	const [observerAvailable, setObserverAvailable] = useState(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Each committed slice or interaction release re-arms the one-shot sentinel.
	useEffect(() => {
		if (typeof IntersectionObserver === "undefined") {
			setObserverAvailable(false);
			return;
		}
		if (
			!visible ||
			collapsed ||
			dragging ||
			held.current.size ||
			query.isFetching ||
			query.isError ||
			query.data?.paused ||
			committed?.paused
		)
			return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries)
					if (entry.isIntersecting) {
						observer.unobserve(entry.target);
						void run.current(entry.target === top.current ? "previous" : "next");
						break;
					}
			},
			{ root: viewport(), rootMargin: "24px 0px" },
		);
		if (canPrevious && top.current) observer.observe(top.current);
		if (last && canNext && bottom.current) observer.observe(bottom.current);
		return () => observer.disconnect();
	}, [
		visible,
		collapsed,
		dragging,
		interactionRevision,
		query.isFetching,
		query.isError,
		query.data?.paused,
		committed,
		slice,
		last,
		canPrevious,
		canNext,
		viewport,
	]);
	const visibleRows = useMemo(() => {
		if (!committed) return [];
		const display = presentedWindow(committed, slice, focused, selected);
		return [...display.before, ...display.rows, ...display.after];
	}, [committed, slice, focused, selected]);
	const protectedKeys = [
		...(resetToNewest.current && visibleRows[0] ? [scopeKey(visibleRows[0].conversation)] : []),
		...(anchorToRestore.current ? [scopeKey(anchorToRestore.current.scope)] : []),
		...heldKeys.current.values(),
		...(focused ? [scopeKey(focused)] : []),
		...(selected ? [scopeKey(selected)] : []),
	];
	const {
		setList,
		virtualizer,
		margin,
		items: virtualItems,
		totalSize,
	} = useRecentVirtualizer(
		visibleRows,
		viewport,
		protectedKeys,
		visible && !collapsed,
		canPrevious && (!observerAvailable || paused) ? 32 : 0,
		focused ? scopeKey(focused) : undefined,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Restore only after the keyed rows/slice actually commit.
	useLayoutEffect(() => {
		if (restoreIntent.current === scrollIntent.current) {
			if (resetToNewest.current) {
				const root = viewport();
				const target = region.current?.querySelector<HTMLElement>("[data-window-row]") ?? region.current;
				if (root && target) {
					root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
					setReplacementNotice((count) => count + 1);
				}
			} else restoreWindowAnchor(anchorToRestore.current, region.current, viewport());
		}
		resetToNewest.current = false;
		anchorToRestore.current = undefined;
		const control = controlOrigin.current;
		if (control && !control.isConnected) {
			controlOrigin.current = null;
			if (document.activeElement === document.body) region.current?.focus({ preventScroll: true });
		}
		const lost = retiredFocus.current;
		retiredFocus.current = undefined;
		if (!lost || lost.element.isConnected || document.activeElement !== document.body) return;
		const root = region.current?.closest<HTMLElement>("[data-sidebar-navigation-root]");
		const viewportBox = viewport()?.getBoundingClientRect();
		const alias = Array.from(root?.querySelectorAll<HTMLElement>(".conversation-link") ?? []).find((element) => {
			const box = element.getBoundingClientRect();
			return (
				element.dataset.workspaceId === lost.scope.workspaceId &&
				element.dataset.conversationId === lost.scope.conversationId &&
				!element.closest("[hidden],[inert]") &&
				element.getClientRects().length > 0 &&
				(!viewportBox || (box.bottom > viewportBox.top && box.top < viewportBox.bottom))
			);
		});
		(alias ?? region.current)?.focus({ preventScroll: true });
		setFocused(undefined);
	}, [committed, slice, viewport]);
	const renderRow = (row: SidebarConversation, index: number, start: number) => (
		<li
			key={scopeKey(row.conversation)}
			ref={virtualizer.measureElement}
			data-index={index}
			style={{ position: "absolute", top: start - margin, width: "100%" }}
			className="conversation-nav-item"
			data-window-row=""
			data-workspace-id={row.conversation.workspaceId}
			data-conversation-id={row.conversation.conversationId}
		>
			<ConversationPreview
				conversation={row.conversation}
				projectId={logicalReady ? (row.membership?.projectId ?? null) : undefined}
				location={{ kind: "recent" }}
				onSelect={() => onSelect(row.conversation)}
				renderActions={(controls) => (
					<ConversationActions
						conversation={row.conversation}
						session={catalog}
						presentation={presentation}
						guard={(action) => action()}
						{...controls}
					/>
				)}
			/>
		</li>
	);
	const controls = (direction: "next" | "previous") => (
		<Button
			variant="ghost"
			size="sm"
			aria-disabled={query.isFetching}
			onBlur={() => {
				controlOrigin.current = null;
			}}
			onClick={(event) => {
				if (query.isFetching) return;
				controlOrigin.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
				void advance(direction, true);
			}}
		>
			{t("work.showMore")}
		</Button>
	);
	return (
		<li className="workspace-branch recent-conversations">
			<div className="recent-conversations-heading">
				<SidebarSectionHeading titleId={heading} actions={filterMenu}>
					{logicalReady ? labels.recent : projectLabels(locale).legacyHistory}
				</SidebarSectionHeading>
			</div>
			<SidebarSectionContent>
				<WindowInteractionContext.Provider value={hold}>
					<section
						ref={region}
						tabIndex={-1}
						aria-labelledby={heading}
						className="project-conversations"
						data-sidebar-query={identity}
						data-sidebar-updated-at={query.data === committed ? query.dataUpdatedAt : 0}
						data-sidebar-fetching={query.isFetching}
						onFocusCapture={(event) => {
							const row = event.target.closest<HTMLElement>("[data-window-row]");
							if (row?.dataset.workspaceId && row.dataset.conversationId) {
								focusElement.current = event.target;
								setFocused({ workspaceId: row.dataset.workspaceId, conversationId: row.dataset.conversationId });
							}
						}}
						onBlurCapture={(event) => {
							if (
								event.relatedTarget instanceof Element &&
								!event.currentTarget.contains(event.relatedTarget) &&
								!event.relatedTarget.closest("[data-sidebar-row-portal]")
							) {
								focusElement.current = null;
								setFocused(undefined);
							}
						}}
					>
						{query.isPending && <output className="nav-feedback">{t("common.loading")}</output>}
						{(query.isError || query.data?.refreshPaused || committed?.refreshPaused) && (
							<div className="nav-feedback" role="alert">
								<p>
									{query.isError
										? labels.refreshFailed
										: locale.startsWith("zh")
											? "刷新已暂停，现有会话仍保留。"
											: "Refresh paused. Existing chats remain available."}
								</p>
								<Button
									variant="ghost"
									aria-disabled={query.isFetching}
									onBlur={() => {
										controlOrigin.current = null;
									}}
									onClick={(event) => {
										controlOrigin.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
										void retry();
									}}
								>
									{t("nav.refresh")}
								</Button>
							</div>
						)}
						{committed?.unpublished && (
							<output className={rows.length ? "sr-only" : "nav-feedback"} aria-live={rows.length ? "off" : undefined}>
								{labels.refreshing}
							</output>
						)}
						{committed?.reset && (
							<output className="sr-only">
								{locale.startsWith("zh")
									? "最近会话视图已更新，原位置在当前视图中不可用。"
									: "Recent chats updated. The previous position is unavailable in this view."}
							</output>
						)}
						{replacementNotice > 0 && (
							<output key={replacementNotice} className="sr-only">
								{rows.length
									? locale.startsWith("zh")
										? "最近会话已更新，现显示最新加载的会话。"
										: "Recent changed; showing the newest loaded chats."
									: locale.startsWith("zh")
										? "最近会话已更新，当前视图中没有会话。"
										: "Recent changed; no chats match this view."}
							</output>
						)}
						<ul
							ref={setList}
							className="conversation-list recent-virtual-list"
							style={{
								height: totalSize + (canNext && (!last || !observerAvailable || paused) ? 32 : 1),
							}}
						>
							{[
								<li
									key="previous"
									ref={top}
									className="recent-window-sentinel"
									style={{ position: "absolute", top: 0 }}
									aria-hidden={!canPrevious || (observerAvailable && !paused)}
								>
									{canPrevious && (!observerAvailable || paused) ? controls("previous") : null}
								</li>,
								...virtualItems.map((item) => {
									const row = visibleRows[item.index];
									return row ? renderRow(row, item.index, item.start) : null;
								}),
								<li
									key="next"
									ref={bottom}
									className="recent-window-sentinel"
									style={{ position: "absolute", top: totalSize }}
								>
									{canNext && (!last || !observerAvailable || paused) ? controls("next") : null}
								</li>,
							]}
						</ul>
						{committed && !query.isError && !committed.unpublished && !rows.length && !canNext && !canPrevious && (
							<p className="nav-feedback">{filter === "archived" ? labels.emptyArchived : t("nav.empty")}</p>
						)}
					</section>
				</WindowInteractionContext.Provider>
			</SidebarSectionContent>
		</li>
	);
}
