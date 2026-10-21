import { AppError } from "@hipi/work-runtime/contracts";
import {
	type InfiniteData,
	infiniteQueryOptions,
	type QueryKey,
	useInfiniteQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { type CatalogPage, type CatalogReadOwner, catalogPublication, readCatalogPage } from "./read-page.ts";

type CatalogPagesOptions<T, P extends CatalogPage<T> = CatalogPage<T>> = {
	queryKey: QueryKey;
	queryPage: (cursor: string | undefined, signal: AbortSignal) => Promise<P>;
	itemKey: (item: T) => string;
	enabled?: boolean;
	gcTime?: number;
	retainedKey?: string;
	readOwner?: CatalogReadOwner<P>;
};

/** Read-only catalog projection. The cache owns pages; selection and command recovery remain independent. */
export function catalogPagesOptions<T, P extends CatalogPage<T> = CatalogPage<T>>({
	queryKey,
	queryPage,
	enabled = true,
	gcTime,
	readOwner = {},
}: CatalogPagesOptions<T, P>) {
	return infiniteQueryOptions({
		queryKey: [...queryKey, "pages"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal, direction }) => readCatalogPage(queryPage, pageParam, direction, signal, readOwner),
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		getPreviousPageParam: (firstPage) => firstPage.previousCursor ?? undefined,
		maxPages: 5,
		...(gcTime === undefined ? {} : { gcTime }),
		// A stale continuation is replaced atomically by the hook, never refetched as a stale chain.
		enabled: (query) =>
			enabled && !(query.state.error instanceof AppError && query.state.error.code === "CURSOR_STALE"),
		retry: false,
	});
}

export function useCatalogPages<T, P extends CatalogPage<T> = CatalogPage<T>>(options: CatalogPagesOptions<T, P>) {
	const cache = useQueryClient();
	const scope = JSON.stringify(options.queryKey);
	const owner = useRef<{ scope: string; reader: CatalogReadOwner<P> }>({ scope, reader: {} });
	if (owner.current.scope !== scope) owner.current = { scope, reader: {} };
	const readOwner = owner.current.reader;
	const replacementOwner = useRef<{ scope: string; reader: CatalogReadOwner<P> }>({ scope, reader: {} });
	if (replacementOwner.current.scope !== scope) replacementOwner.current = { scope, reader: {} };
	const queryOptions = catalogPagesOptions({ ...options, readOwner });
	const query = useInfiniteQuery(queryOptions);
	const [restarting, setRestarting] = useState(false);
	const recoveryKey = [...queryOptions.queryKey, "recovery"];
	const identity = JSON.stringify(queryOptions.queryKey);
	const protectedItem = useRef<
		{ scope: string; publication: string; key: string; item: T; placement: "before" | "after" } | undefined
	>(undefined);
	const [, redraw] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: The serialized key defines the request scope, not freshly allocated key arrays.
	useEffect(
		() => () => {
			void cache.cancelQueries({ queryKey: recoveryKey, exact: true });
		},
		[cache, identity],
	);
	const pages = query.data?.pages ?? [];
	const publication = catalogPublication(pages[0] ?? {});
	if (protectedItem.current && protectedItem.current.publication !== publication) protectedItem.current = undefined;
	const selectedItem = useRef<{ key: string; item: T; scope: string; publication: string } | undefined>(undefined);
	if (
		selectedItem.current &&
		(selectedItem.current.key !== options.retainedKey ||
			selectedItem.current.scope !== identity ||
			selectedItem.current.publication !== publication)
	)
		selectedItem.current = undefined;
	const selected = options.retainedKey
		? pages.flatMap((page) => page.items).find((item) => options.itemKey(item) === options.retainedKey)
		: undefined;
	if (selected && options.retainedKey)
		selectedItem.current = { key: options.retainedKey, item: selected, scope: identity, publication };
	const items = new Map<string, T>();
	if (selectedItem.current) items.set(selectedItem.current.key, selectedItem.current.item);
	if (protectedItem.current?.scope === identity && protectedItem.current.placement === "before")
		items.set(protectedItem.current.key, protectedItem.current.item);
	for (const page of pages) for (const item of page.items) items.set(options.itemKey(item), item);
	if (protectedItem.current?.scope === identity && !items.has(protectedItem.current.key))
		items.set(protectedItem.current.key, protectedItem.current.item);
	const windowed = query.data !== undefined && query.data.pageParams[0] !== undefined;
	const staleCursor = query.error instanceof AppError && query.error.code === "CURSOR_STALE";
	const recovery = useRef({ key: JSON.stringify(queryOptions.queryKey), attempted: false });
	if (recovery.current.key !== JSON.stringify(queryOptions.queryKey))
		recovery.current = { key: JSON.stringify(queryOptions.queryKey), attempted: false };
	if (!query.isError) recovery.current.attempted = false;
	const restart = async () => {
		if (
			query.isFetching ||
			options.enabled === false ||
			cache.getQueryState(recoveryKey)?.fetchStatus === "fetching" ||
			cache.getQueryState(queryOptions.queryKey)?.fetchStatus === "fetching"
		)
			return;
		// Stage the replacement without clearing the coherent rows during a failed read.
		try {
			setRestarting(true);
			const result = await cache.fetchQuery<InfiniteData<P, string | undefined>>({
				queryKey: recoveryKey,
				queryFn: async ({ signal }) => {
					const first = await readCatalogPage(
						options.queryPage,
						undefined,
						"forward",
						signal,
						replacementOwner.current.reader,
					);
					signal.throwIfAborted();
					return { pages: [first], pageParams: [undefined] };
				},
				staleTime: 0,
				retry: false,
			});
			cache.setQueryData(queryOptions.queryKey, result);
		} catch {
			// Query owns the failure; the old snapshot remains readable.
		} finally {
			setRestarting(false);
			cache.removeQueries({ queryKey: recoveryKey, exact: true });
		}
	};
	const restartRef = useRef(restart);
	restartRef.current = restart;
	useEffect(() => {
		if (!staleCursor || query.isFetching || options.enabled === false || recovery.current.attempted) return;
		recovery.current.attempted = true;
		void restartRef.current();
	}, [staleCursor, query.isFetching, options.enabled]);
	return {
		dataUpdatedAt: query.dataUpdatedAt,
		pages,
		items: [...items.values()],
		hasData: query.data !== undefined,
		hasMore: query.hasNextPage,
		hasPrevious: query.hasPreviousPage,
		itemKeys: [...items.keys()],
		windowItemKeys: pages.flatMap((page) => page.items.map(options.itemKey)),
		cancelLoad: () => {
			void cache.cancelQueries({ queryKey: queryOptions.queryKey, exact: true });
		},
		protectItem: (key: string | undefined) => {
			if (key === protectedItem.current?.key && protectedItem.current?.scope === identity) return;
			const item = key ? items.get(key) : undefined;
			protectedItem.current =
				key && item
					? {
							scope: identity,
							publication,
							key,
							item,
							placement: [...items.keys()].indexOf(key) < items.size / 2 ? "before" : "after",
						}
					: undefined;
			redraw((value) => value + 1);
		},
		evictedKeys: (direction: "next" | "previous") =>
			pages.length < 5 ? [] : ((direction === "next" ? pages[0] : pages.at(-1))?.items.map(options.itemKey) ?? []),
		isPending: query.isPending,
		isSuccess: query.isSuccess,
		isError: query.isError,
		isFetching: query.isFetching || restarting,
		isLoadingMore: query.isFetchingNextPage,
		isLoadMoreError: query.isFetchNextPageError,
		error: query.error,
		staleCursor,
		windowed,
		atLimit: pages.length === 5 && query.hasNextPage,
		canRestart: pages.length > 1 || windowed,
		restart,
		loadPrevious: async () => {
			if (!query.hasPreviousPage || query.isFetching || query.isError || options.enabled === false) return;
			await query.fetchPreviousPage({ cancelRefetch: false });
		},
		loadMore: async () => {
			if (!query.hasNextPage || query.isFetching || query.isError || options.enabled === false) return;
			await query.fetchNextPage({ cancelRefetch: false });
		},
		retry: async () => {
			if (query.isFetching || options.enabled === false) return;
			if (staleCursor) await restart();
			else if (query.isFetchPreviousPageError) await query.fetchPreviousPage({ cancelRefetch: false });
			else if (query.isFetchNextPageError) await query.fetchNextPage({ cancelRefetch: false });
			else await query.refetch({ cancelRefetch: false });
		},
	};
}
