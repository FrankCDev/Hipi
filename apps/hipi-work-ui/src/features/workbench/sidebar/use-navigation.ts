import {
	AppError,
	type ConversationFilter,
	type SidebarConversation,
	type SidebarView,
} from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { fetchNavigationWindow, navigationOptions, SIDEBAR_PAGE_LIMIT } from "./navigation-query.ts";
import { navigationProbeOptions, sameNavigationPublication } from "./navigation-refresh.ts";

export function useNavigation(view: SidebarView, filter: ConversationFilter, enabled: boolean) {
	const client = useAppClient();
	const cache = useQueryClient();
	const options = navigationOptions(cache, client, view, filter);
	const query = useQuery({ ...options, enabled });
	const probe = useQuery({
		...navigationProbeOptions(client, view.kind === "project" || view.kind === "project_recent"),
		enabled: false,
	});
	const [action, setAction] = useState<"refresh" | "more" | "first">("refresh");
	const [loadingMore, setLoadingMore] = useState(false);
	const pages = query.data?.pages ?? [];
	const items = new Map<string, SidebarConversation>();
	for (const page of pages)
		for (const item of page.items)
			items.set(JSON.stringify([item.conversation.workspaceId, item.conversation.conversationId]), item);
	const published = pages[0]?.coverage;
	const coverage =
		published && query.data?.rebuilding
			? { ...published, state: "refreshing" as const }
			: published && probe.data
				? sameNavigationPublication(published, probe.data.coverage)
					? probe.data.coverage
					: { ...published, state: "refreshing" as const }
				: published;
	const hasMore = !query.data?.rebuilding && !!pages.at(-1)?.nextCursor;
	const run = async (next: typeof action) => {
		if (!enabled || cache.getQueryState(options.queryKey)?.fetchStatus === "fetching") return;
		setAction(next);
		setLoadingMore(next === "more");
		try {
			await fetchNavigationWindow(cache, client, view, filter, next);
		} catch {
			// Query owns the visible error and retained coherent rows.
		} finally {
			setLoadingMore(false);
		}
	};
	const error = query.error ?? probe.error;
	return {
		queryIdentity: JSON.stringify(options.queryKey),
		dataUpdatedAt: query.dataUpdatedAt,
		pages,
		memberships: new Map([...items.entries()].map(([key, item]) => [key, item.membership])),
		items: [...items.values()].map((item) => item.conversation),
		coverage,
		hasData: query.data !== undefined,
		hasMore,
		isPending: query.isPending,
		isSuccess: query.isSuccess,
		isError: !!error,
		isFetching: query.isFetching,
		isLoadingMore: query.isFetching && loadingMore,
		isLoadMoreError: query.isError && action === "more",
		error,
		staleCursor: error instanceof AppError && error.code === "CURSOR_STALE",
		windowed: query.data?.cursors[0] !== undefined,
		atLimit: pages.length === SIDEBAR_PAGE_LIMIT && hasMore,
		canRestart: pages.length > 1 || query.data?.cursors[0] !== undefined,
		isEmpty: query.isSuccess && coverage?.state === "ready" && !hasMore && items.size === 0,
		restart: () => run("first"),
		loadMore: () => (hasMore && !query.isError ? run("more") : Promise.resolve()),
		retry: async () => {
			if (!enabled) return;
			await Promise.all([
				run(query.isError ? action : "refresh"),
				probe.error ? probe.refetch({ cancelRefetch: false }) : undefined,
			]);
		},
	};
}
