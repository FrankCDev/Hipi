import {
	type AppClient,
	AppError,
	type ConversationFilter,
	type Scope,
	type SidebarView,
	type SidebarWindowRequest,
	type SidebarWindowResult,
} from "@hipi/work-runtime/contracts";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { CATALOG_READ_DEADLINE_MS, yieldCatalogRead } from "../catalog/read-page.ts";
import { sameNavigationPublication } from "./navigation-refresh.ts";

export type WindowPage = Extract<SidebarWindowResult, { kind: "window" }>;
type WindowPosition = SidebarWindowRequest["position"];
export type WindowRefresh = {
	pages: WindowPage[];
	coverage?: WindowPage["coverage"];
	retained: WindowPage["retained"];
	position: WindowPosition;
	start: WindowPosition;
	fallbacks: Scope[];
	targetCount: number;
	recentCursors: string[];
	restarts: number;
	reset?: "anchor_unavailable";
};
export type RecentWindow = {
	pages: WindowPage[];
	retained: WindowPage["retained"];
	paused: boolean;
	unpublished: boolean;
	action: WindowAction;
	revision: number;
	reset?: "anchor_unavailable";
	/** Paused replacement work never becomes the committed row set. */
	refresh?: WindowRefresh;
	refreshPaused?: "publication";
};
export type WindowAction = "refresh" | "next" | "previous";
export type WindowIntent = {
	action: WindowAction;
	anchor?: Scope;
	neighbors?: Scope[];
	retainedScopes?: Scope[];
	targetCount?: number;
	explicitRetry?: boolean;
};
export const windowKey = (view: SidebarView, filter: ConversationFilter) => ["sidebar-window", view, filter] as const;
export const scopeKey = (scope: Scope) => JSON.stringify([scope.workspaceId, scope.conversationId]);
export const windowItems = (value?: RecentWindow) => value?.pages.flatMap((page) => page.items) ?? [];
const emptyRetained: WindowPage["retained"] = { eligible: [], unavailable: [] };

/** Preserve canonical order and opaque boundaries without retaining empty sparse pages. */
function mergePage(pages: WindowPage[], keys: Set<string>, result: WindowPage, direction: "next" | "previous") {
	const items = result.items.filter((row) => {
		const key = scopeKey(row.conversation);
		if (keys.has(key)) return false;
		keys.add(key);
		return true;
	});
	const index = direction === "previous" ? 0 : pages.length - 1;
	const edge = pages[index];
	if (edge && edge.items.length + items.length <= 50) {
		pages[index] = {
			...edge,
			items: direction === "previous" ? [...items, ...edge.items] : [...edge.items, ...items],
			...(direction === "previous" ? { previousCursor: result.previousCursor } : { nextCursor: result.nextCursor }),
			retained: result.retained,
		};
	} else if (!items.length && edge) {
		pages[index] = {
			...edge,
			...(direction === "previous" ? { previousCursor: result.previousCursor } : { nextCursor: result.nextCursor }),
		};
	} else if (direction === "previous") pages.unshift({ ...result, items });
	else pages.push({ ...result, items });
}

/** One deadline-bound query scans serial batches until the requested visible extent is coherent. */
export async function readRecentWindow(
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	signal: AbortSignal,
	previous?: RecentWindow,
	intent: WindowIntent = { action: "refresh" },
): Promise<RecentWindow> {
	signal.throwIfAborted();
	if (previous?.refreshPaused && !(intent.action === "refresh" && intent.explicitRetry)) return previous;
	const resume =
		intent.action === "refresh" && (intent.explicitRetry || previous?.unpublished) ? previous?.refresh : undefined;
	const targetCount = resume?.targetCount ?? Math.max(10, intent.targetCount ?? windowItems(previous).length);
	const headOrigin = previous?.pages[0] && !previous.pages[0].previousCursor;
	// A viewport anchor near the bottom must not erase the earlier, explicitly loaded extent.
	const start: WindowPosition =
		resume?.start ?? (headOrigin || !intent.anchor ? { kind: "head" } : { kind: "around", anchor: intent.anchor });
	let pages = resume ? [...resume.pages] : intent.action === "refresh" ? [] : [...(previous?.pages ?? [])];
	let publication = resume?.coverage ?? pages[0]?.coverage;
	let keys = new Set(pages.flatMap((page) => page.items.map((row) => scopeKey(row.conversation))));
	let retained = resume?.retained ?? previous?.retained ?? emptyRetained;
	let action = intent.action;
	const cursor = action === "previous" ? pages[0]?.previousCursor : pages.at(-1)?.nextCursor;
	if (action !== "refresh" && previous && !cursor) return previous;
	const demand = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_READ_DEADLINE_MS)]);
	let position: WindowPosition =
		resume?.position ?? (action === "refresh" ? start : { kind: "continue", cursor: cursor ?? "" });
	let fallbacks = [...(resume?.fallbacks ?? intent.neighbors ?? []).slice(0, 2)];
	const retainedScopes = [
		...new Map((intent.retainedScopes ?? []).map((scope) => [scopeKey(scope), scope])).values(),
	].slice(0, 2);
	let restarts = resume && !intent.explicitRetry ? resume.restarts : 0;
	let recentCursors = [...(resume?.recentCursors ?? [])];
	let reads = 0;
	let reset = resume?.reset;
	let found = 0;
	const commit = (): RecentWindow => ({
		pages,
		retained,
		paused: false,
		unpublished: false,
		action,
		reset,
		revision: (previous?.revision ?? 0) + 1,
	});
	const pause = (reason: NonNullable<RecentWindow["refreshPaused"]> | "unpublished"): RecentWindow => ({
		...(previous ?? { ...commit(), pages: [], retained: emptyRetained }),
		paused: true,
		unpublished: reason === "unpublished",
		refreshPaused: reason === "unpublished" ? undefined : reason,
		refresh: {
			pages,
			coverage: publication,
			retained,
			position,
			start,
			fallbacks,
			targetCount,
			recentCursors,
			restarts,
			reset,
		},
	});
	const restart = (publicationChanged = true) => {
		action = "refresh";
		pages = [];
		publication = undefined;
		keys = new Set();
		retained = emptyRetained;
		position = start;
		fallbacks = [...(intent.neighbors ?? []).slice(0, 2)];
		recentCursors = [];
		found = 0;
		if (publicationChanged) restarts++;
	};
	for (;;) {
		if (reads && reads % 5 === 0) await yieldCatalogRead(demand);
		demand.throwIfAborted();
		reads++;
		let result: SidebarWindowResult;
		try {
			result = await client.call(
				"listSidebarWindow",
				{ view, filter, position, ...(retainedScopes.length ? { retainedScopes } : {}) },
				demand,
			);
			demand.throwIfAborted();
		} catch (error) {
			demand.throwIfAborted();
			if (!(error instanceof AppError) || error.code !== "CURSOR_STALE") throw error;
			if (restarts) return pause("publication");
			restart();
			continue;
		}
		if (result.kind === "unpublished") {
			if (action !== "refresh") restart(false);
			return pause("unpublished");
		}
		if (publication && !sameNavigationPublication(publication, result.coverage)) {
			if (restarts) return pause("publication");
			restart();
			continue;
		}
		publication = result.coverage;
		if (result.kind === "anchor_unavailable") {
			if (position.kind !== "around") throw new AppError("INVALID_REQUEST");
			reset = "anchor_unavailable";
			const anchor = fallbacks.shift();
			position = anchor ? { kind: "around", anchor } : { kind: "head" };
			continue;
		}
		const next = action === "previous" ? result.previousCursor : result.nextCursor;
		if (next && ((position.kind === "continue" && next === position.cursor) || recentCursors.includes(next)))
			throw new AppError("INVALID_REQUEST");
		retained = result.retained;
		const count = keys.size;
		mergePage(pages, keys, result, action === "previous" ? "previous" : "next");
		found += keys.size - count;
		if ((action === "refresh" ? keys.size >= targetCount : found >= 5) || !next) return commit();
		// Short cursor cycles fail immediately; the deadline also bounds longer malformed streams.
		recentCursors = [...recentCursors, next].slice(-16);
		position = { kind: "continue", cursor: next };
	}
}

/** Call after cancelling the query when hidden; pause authority survives releasing staged metadata. */
export function discardRecentWindowStaging(cache: QueryClient, view: SidebarView, filter: ConversationFilter) {
	cache.setQueryData<RecentWindow>(windowKey(view, filter), (current) => {
		if (!current?.refresh) return current;
		const { refresh: _refresh, ...committed } = current;
		return committed;
	});
}

export function recentWindowOptions(
	cache: QueryClient,
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	capture: () => Omit<WindowIntent, "action">,
) {
	return queryOptions({
		queryKey: windowKey(view, filter),
		queryFn: ({ signal }) =>
			readRecentWindow(client, view, filter, signal, cache.getQueryData<RecentWindow>(windowKey(view, filter)), {
				...capture(),
				action: "refresh",
				explicitRetry: false,
			}),
		retry: false,
		gcTime: 0,
	});
}
export async function fetchRecentWindow(
	cache: QueryClient,
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	action: WindowAction,
	capture: () => Omit<WindowIntent, "action">,
) {
	let pending = true;
	try {
		return await cache.fetchQuery({
			queryKey: windowKey(view, filter),
			queryFn: ({ signal }) => {
				const requested = pending ? action : "refresh";
				const explicitRetry = pending && action === "refresh";
				pending = false;
				return readRecentWindow(
					client,
					view,
					filter,
					signal,
					cache.getQueryData<RecentWindow>(windowKey(view, filter)),
					{ ...capture(), action: requested, explicitRetry },
				);
			},
			retry: false,
			staleTime: 0,
			gcTime: 0,
		});
	} finally {
		pending = false;
	}
}
