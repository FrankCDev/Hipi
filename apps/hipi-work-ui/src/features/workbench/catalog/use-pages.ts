import { AppError, type Page } from "@hipi/work-runtime/contracts";
import { infiniteQueryOptions, type QueryKey, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";

type CatalogPagesOptions<T, P extends Page<T> = Page<T>> = {
	queryKey: QueryKey;
	queryPage: (cursor: string | undefined, signal: AbortSignal) => Promise<P>;
	itemKey: (item: T) => string;
	enabled?: boolean;
};

/** Read-only catalog projection. The cache owns pages; selection and command recovery remain independent. */
export function catalogPagesOptions<T, P extends Page<T> = Page<T>>({
	queryKey,
	queryPage,
	enabled = true,
}: CatalogPagesOptions<T, P>) {
	return infiniteQueryOptions({
		queryKey: [...queryKey, "pages"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) => queryPage(pageParam, signal),
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		maxPages: 5,
		// A stale continuation needs the explicit first-page retry, including after remount/reconnect.
		enabled: (query) =>
			enabled && !(query.state.error instanceof AppError && query.state.error.code === "CURSOR_STALE"),
		retry: false,
	});
}

export function useCatalogPages<T, P extends Page<T> = Page<T>>(options: CatalogPagesOptions<T, P>) {
	const cache = useQueryClient();
	const queryOptions = catalogPagesOptions(options);
	const query = useInfiniteQuery(queryOptions);
	const pages = query.data?.pages ?? [];
	const items = new Map<string, T>();
	for (const page of pages) for (const item of page.items) items.set(options.itemKey(item), item);
	const windowed = query.data !== undefined && query.data.pageParams[0] !== undefined;
	const staleCursor = query.error instanceof AppError && query.error.code === "CURSOR_STALE";
	const restart = async () => {
		if (
			query.isFetching ||
			options.enabled === false ||
			cache.getQueryState(queryOptions.queryKey)?.fetchStatus === "fetching"
		)
			return;
		// Reset this exact list only. No obsolete continuation is replayed after a catalog revision changes.
		await cache.resetQueries({ queryKey: queryOptions.queryKey, exact: true });
	};
	return {
		pages,
		items: [...items.values()],
		hasData: query.data !== undefined,
		hasMore: query.hasNextPage,
		isPending: query.isPending,
		isSuccess: query.isSuccess,
		isError: query.isError,
		isFetching: query.isFetching,
		isLoadingMore: query.isFetchingNextPage,
		isLoadMoreError: query.isFetchNextPageError,
		error: query.error,
		staleCursor,
		windowed,
		atLimit: pages.length === 5 && query.hasNextPage,
		canRestart: pages.length > 1 || windowed,
		restart,
		loadMore: async () => {
			if (!query.hasNextPage || query.isFetching || query.isError || options.enabled === false) return;
			await query.fetchNextPage({ cancelRefetch: false });
		},
		retry: async () => {
			if (query.isFetching || options.enabled === false) return;
			if (staleCursor) await restart();
			else if (query.isFetchNextPageError) await query.fetchNextPage({ cancelRefetch: false });
			else await query.refetch({ cancelRefetch: false });
		},
	};
}
