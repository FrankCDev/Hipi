import {
	type AppClient,
	AppError,
	type ConversationFilter,
	type Scope,
	type SidebarPage,
	type SidebarView,
	type SidebarWindowResult,
} from "@hipi/work-runtime/contracts";
import { type QueryClient, queryOptions } from "@tanstack/react-query";

import { type CatalogReadOwner, readCatalogPage } from "../catalog/read-page.ts";

export const SIDEBAR_PAGE_LIMIT = 5;
export type NavigationPage = SidebarPage & {
	previousCursor: string | null;
	retained?: Extract<SidebarWindowResult, { kind: "window" }>["retained"];
};
export type NavigationWindow = {
	pages: NavigationPage[];
	cursors: (string | undefined)[];
	rebuilding?: boolean;
	retained?: Extract<SidebarWindowResult, { kind: "window" }>["retained"];
};
export const navigationKey = (view: SidebarView, filter: ConversationFilter) =>
	["sidebar-navigation", view, filter] as const;

/** A replacement is committed only after every page belongs to one published snapshot. */
export async function readNavigationWindow(
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	signal: AbortSignal,
	previous?: NavigationWindow,
	action: "refresh" | "more" | "previous" | "first" = "refresh",
	retainedScopes: readonly Scope[] = [],
	readOwner: CatalogReadOwner<NavigationPage> = {},
): Promise<NavigationWindow> {
	const retainWhileBuilding = () =>
		previous && {
			...previous,
			rebuilding: true,
			pages: previous.pages.map((page) => ({ ...page, coverage: { ...page.coverage, state: "refreshing" as const } })),
		};
	const readOne = async (cursor: string | undefined, signal: AbortSignal): Promise<NavigationPage> => {
		signal.throwIfAborted();
		const result = await client.call(
			"listSidebarWindow",
			{
				view,
				filter,
				position: cursor ? { kind: "continue", cursor } : { kind: "head" },
				...(retainedScopes.length ? { retainedScopes: [...retainedScopes].slice(0, 2) } : {}),
			},
			signal,
		);
		signal.throwIfAborted();
		if (result.kind === "anchor_unavailable") throw new AppError("CURSOR_STALE");
		return result.kind === "window"
			? result
			: { items: [], coverage: result.coverage, previousCursor: null, nextCursor: null };
	};
	const read = (cursor: string | undefined, direction: "forward" | "backward" = "forward") =>
		readCatalogPage(readOne, cursor, direction, signal, readOwner);
	const rebuild = async (start: string | undefined, count: number) => {
		const pages: NavigationPage[] = [];
		const cursors: (string | undefined)[] = [];
		let cursor = start;
		for (let index = 0; index < count; index++) {
			signal.throwIfAborted();
			const page = await read(cursor);
			if (page.coverage.state === "building" && previous?.pages.some((page) => page.items.length))
				return retainWhileBuilding() ?? { pages: [page], cursors: [cursor] };
			if (
				pages[0] &&
				(page.coverage.generation !== pages[0].coverage.generation ||
					page.coverage.membershipGeneration !== pages[0].coverage.membershipGeneration ||
					page.coverage.projectMembershipGeneration !== pages[0].coverage.projectMembershipGeneration ||
					page.coverage.projectOrderGeneration !== pages[0].coverage.projectOrderGeneration)
			)
				throw new AppError("CURSOR_STALE");
			pages.push(page);
			cursors.push(cursor);
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		return { pages, cursors, retained: pages.at(-1)?.retained };
	};
	try {
		if ((action === "more" || action === "previous") && previous) {
			if (previous.rebuilding) return previous;
			const cursor = action === "previous" ? previous.pages[0]?.previousCursor : previous.pages.at(-1)?.nextCursor;
			if (!cursor) return previous;
			const page = await read(cursor, action === "previous" ? "backward" : "forward");
			if (page.coverage.state === "building") return retainWhileBuilding() ?? previous;
			if (
				page.coverage.generation !== previous.pages[0]?.coverage.generation ||
				page.coverage.membershipGeneration !== previous.pages[0]?.coverage.membershipGeneration ||
				page.coverage.projectMembershipGeneration !== previous.pages[0]?.coverage.projectMembershipGeneration ||
				page.coverage.projectOrderGeneration !== previous.pages[0]?.coverage.projectOrderGeneration
			)
				throw new AppError("CURSOR_STALE");
			return action === "previous"
				? {
						retained: page.retained,
						pages: [page, ...previous.pages].slice(0, SIDEBAR_PAGE_LIMIT),
						cursors: [cursor, ...previous.cursors].slice(0, SIDEBAR_PAGE_LIMIT),
					}
				: {
						retained: page.retained,
						pages: [...previous.pages, page].slice(-SIDEBAR_PAGE_LIMIT),
						cursors: [...previous.cursors, cursor].slice(-SIDEBAR_PAGE_LIMIT),
					};
		}
		return await rebuild(
			action === "first" ? undefined : previous?.cursors[0],
			action === "first" ? 1 : Math.max(1, previous?.pages.length ?? 1),
		);
	} catch (error) {
		if (!(error instanceof AppError) || error.code !== "CURSOR_STALE" || signal.aborted) throw error;
		// One read-only recovery, with no cache reset. A second race remains visible and
		// retains the old coherent window until the next bounded refresh or user retry.
		return rebuild(undefined, Math.max(1, previous?.pages.length ?? 1));
	}
}

export function navigationOptions(
	cache: QueryClient,
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	action: "refresh" | "more" | "previous" | "first" = "refresh",
	capture: () => readonly Scope[] = () => [],
	readOwner: CatalogReadOwner<NavigationPage> = {},
) {
	return navigationRequest(cache, client, view, filter, action, capture, readOwner).options;
}

function navigationRequest(
	cache: QueryClient,
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	action: "refresh" | "more" | "previous" | "first",
	capture: () => readonly Scope[],
	readOwner: CatalogReadOwner<NavigationPage>,
) {
	const queryKey = navigationKey(view, filter);
	let nextAction = action;
	const options = queryOptions({
		queryKey,
		queryFn: ({ signal }) => {
			const requested = nextAction;
			nextAction = "refresh";
			return readNavigationWindow(
				client,
				view,
				filter,
				signal,
				cache.getQueryData<NavigationWindow>(queryKey),
				requested,
				capture(),
				readOwner,
			);
		},
		retry: false,
	});
	return {
		options,
		retire: () => {
			nextAction = "refresh";
		},
	};
}

export async function fetchNavigationWindow(
	cache: QueryClient,
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	action: "refresh" | "more" | "previous" | "first",
	capture: () => readonly Scope[] = () => [],
	readOwner: CatalogReadOwner<NavigationPage> = {},
) {
	const request = navigationRequest(cache, client, view, filter, action, capture, readOwner);
	try {
		return await cache.fetchQuery({ ...request.options, staleTime: 0 });
	} finally {
		// Even a deduplicated/aborted action that never entered queryFn must not
		// become a later background pagination request. No Query internals change.
		request.retire();
	}
}
