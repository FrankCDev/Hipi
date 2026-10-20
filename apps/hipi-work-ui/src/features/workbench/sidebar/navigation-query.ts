import {
	type AppClient,
	AppError,
	type ConversationFilter,
	type SidebarPage,
	type SidebarView,
} from "@hipi/work-runtime/contracts";
import { type QueryClient, queryOptions } from "@tanstack/react-query";

export const SIDEBAR_PAGE_LIMIT = 5;
export type NavigationWindow = { pages: SidebarPage[]; cursors: (string | undefined)[]; rebuilding?: boolean };
export const navigationKey = (view: SidebarView, filter: ConversationFilter) =>
	["sidebar-navigation", view, filter] as const;

/** A replacement is committed only after every page belongs to one published snapshot. */
export async function readNavigationWindow(
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	signal: AbortSignal,
	previous?: NavigationWindow,
	action: "refresh" | "more" | "first" = "refresh",
): Promise<NavigationWindow> {
	const retainWhileBuilding = () =>
		previous && {
			...previous,
			rebuilding: true,
			pages: previous.pages.map((page) => ({ ...page, coverage: { ...page.coverage, state: "refreshing" as const } })),
		};
	const read = async (cursor?: string) => {
		signal.throwIfAborted();
		const page = await client.call("listSidebarConversations", { view, filter, ...(cursor ? { cursor } : {}) }, signal);
		signal.throwIfAborted();
		return page;
	};
	const rebuild = async (start: string | undefined, count: number) => {
		const pages: SidebarPage[] = [];
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
		return { pages, cursors };
	};
	try {
		if (action === "more" && previous) {
			if (previous.rebuilding) return previous;
			const cursor = previous.pages.at(-1)?.nextCursor;
			if (!cursor) return previous;
			const page = await read(cursor);
			if (page.coverage.state === "building") return retainWhileBuilding() ?? previous;
			if (
				page.coverage.generation !== previous.pages[0]?.coverage.generation ||
				page.coverage.membershipGeneration !== previous.pages[0]?.coverage.membershipGeneration ||
				page.coverage.projectMembershipGeneration !== previous.pages[0]?.coverage.projectMembershipGeneration ||
				page.coverage.projectOrderGeneration !== previous.pages[0]?.coverage.projectOrderGeneration
			)
				throw new AppError("CURSOR_STALE");
			return {
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
	action: "refresh" | "more" | "first" = "refresh",
) {
	return navigationRequest(cache, client, view, filter, action).options;
}

function navigationRequest(
	cache: QueryClient,
	client: AppClient,
	view: SidebarView,
	filter: ConversationFilter,
	action: "refresh" | "more" | "first",
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
	action: "refresh" | "more" | "first",
) {
	const request = navigationRequest(cache, client, view, filter, action);
	try {
		return await cache.fetchQuery({ ...request.options, staleTime: 0 });
	} finally {
		// Even a deduplicated/aborted action that never entered queryFn must not
		// become a later background pagination request. No Query internals change.
		request.retire();
	}
}
