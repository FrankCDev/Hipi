import assert from "node:assert/strict";
import { AppError, type Page } from "@hipi/work-runtime/contracts";
import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test } from "vitest";
import { catalogPagesOptions, useCatalogPages } from "../../../src/features/workbench/catalog/use-pages.ts";

type Item = { id: string; title: string };
type Reader = (cursor: string | undefined, signal: AbortSignal) => Promise<Page<Item>>;
const cleanups: (() => void)[] = [];

// The real Query observer drives requests and cache transitions. SSR samples the
// production hook's public result and callbacks; this is not DOM/focus coverage.
function catalog(queryPage: Reader, queryKey = ["conversations", "project-a", "active"]) {
	const cache = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, refetchOnMount: false } },
	});
	const options = { queryKey, queryPage, itemKey: (item: Item) => item.id };
	const observer = new InfiniteQueryObserver(cache, catalogPagesOptions(options));
	const unsubscribe = observer.subscribe(() => {});
	cleanups.push(() => {
		unsubscribe();
		cache.clear();
	});
	return {
		cache,
		observer,
		ready: () => observer.refetch({ cancelRefetch: false }),
		read: (enabled = true) => {
			let snapshot: ReturnType<typeof useCatalogPages<Item>> | undefined;
			function Probe() {
				snapshot = useCatalogPages({ ...options, enabled });
				return null;
			}
			renderToStaticMarkup(
				<QueryClientProvider client={cache}>
					<Probe />
				</QueryClientProvider>,
			);
			assert.ok(snapshot);
			return snapshot;
		},
	};
}

const page = (id: string, nextCursor: string | null): Page<Item> => ({ items: [{ id, title: id }], nextCursor });
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

test("loading the next page preserves rows and rapid repeated requests share one read", async () => {
	const calls: (string | undefined)[] = [];
	let resolve: ((value: Page<Item>) => void) | undefined;
	const list = catalog(async (cursor) => {
		calls.push(cursor);
		if (!cursor) return page("first", "second");
		return new Promise<Page<Item>>((complete) => {
			resolve = complete;
		});
	});
	await list.ready();
	const initial = list.read();
	const loading = initial.loadMore();
	const duplicate = initial.loadMore();
	assert.deepEqual(
		list.read().items.map((item) => item.id),
		["first"],
	);
	assert.equal(list.read().isLoadingMore, true);
	assert.deepEqual(calls, [undefined, "second"]);
	assert.ok(resolve);
	resolve(page("second", null));
	await Promise.all([loading, duplicate]);
	const loaded = list.read();
	assert.deepEqual(
		loaded.items.map((item) => item.id),
		["first", "second"],
	);
	assert.equal(loaded.hasMore, false);
	assert.equal(loaded.canRestart, true);
	assert.equal(loaded.windowed, false);
	await loaded.loadMore();
	assert.equal(calls.length, 2);
});

test("ordinary continuation failure preserves rows and Retry retries only the failed page", async () => {
	const calls: (string | undefined)[] = [];
	let failing = true;
	const list = catalog(async (cursor) => {
		calls.push(cursor);
		if (!cursor) return page("first", "second");
		if (failing) throw new Error("Read unavailable");
		return page("second", null);
	});
	await list.ready();
	await list.read().loadMore();
	const failed = list.read();
	assert.equal(failed.isLoadMoreError, true);
	assert.deepEqual(
		failed.items.map((item) => item.id),
		["first"],
	);
	await failed.loadMore();
	assert.deepEqual(calls, [undefined, "second"], "Load more never silently retries an errored list");
	failing = false;
	await failed.retry();
	assert.deepEqual(calls, [undefined, "second", "second"]);
	assert.deepEqual(
		list.read().items.map((item) => item.id),
		["first", "second"],
	);
});

test("stale continuation requires explicit first-page retry and resets only its exact catalog", async () => {
	const calls: (string | undefined)[] = [];
	let changed = false;
	const list = catalog(async (cursor) => {
		calls.push(cursor);
		if (cursor) throw new AppError("CURSOR_STALE");
		return page(changed ? "fresh" : "first", changed ? null : "obsolete");
	});
	const otherKey = ["conversations", "project-b", "archived", "pages"];
	const other = { pages: [page("other", null)], pageParams: [undefined] };
	list.cache.setQueryData(otherKey, other);
	await list.ready();
	await list.read().loadMore();
	const stale = list.read();
	assert.equal(stale.staleCursor, true);
	assert.deepEqual(
		stale.items.map((item) => item.id),
		["first"],
	);
	assert.deepEqual(calls, [undefined, "obsolete"]);
	await list.cache.invalidateQueries({ queryKey: ["conversations", "project-a"] });
	assert.deepEqual(calls, [undefined, "obsolete"], "invalidation does not replay a known stale continuation");
	changed = true;
	await stale.retry();
	assert.deepEqual(calls, [undefined, "obsolete", undefined]);
	assert.deepEqual(
		list.read().items.map((item) => item.id),
		["fresh"],
	);
	assert.equal(list.read().staleCursor, false);
	assert.deepEqual(list.cache.getQueryData(otherKey), other);
});

test("five-page retention is explicit before and after eviction and First page discards old continuations", async () => {
	const calls: (string | undefined)[] = [];
	const list = catalog(async (cursor) => {
		calls.push(cursor);
		const index = Number(cursor ?? 0);
		return page(`item-${index}`, index < 6 ? String(index + 1) : null);
	});
	await list.ready();
	for (let index = 1; index < 5; index++) await list.read().loadMore();
	assert.equal(list.read().items.length, 5);
	assert.equal(list.read().atLimit, true);
	assert.equal(list.read().windowed, false);
	await list.read().loadMore();
	assert.deepEqual(
		list.read().items.map((item) => item.id),
		["item-1", "item-2", "item-3", "item-4", "item-5"],
	);
	assert.equal(list.read().windowed, true);
	assert.equal(list.read().canRestart, true);
	await list.read().restart();
	assert.deepEqual(
		list.read().items.map((item) => item.id),
		["item-0"],
	);
	assert.equal(list.read().windowed, false);
	assert.equal(list.read().canRestart, false);
	assert.equal(calls.at(-1), undefined);
});

test("duplicate item identities update in place and disabled branches cannot request more or retry", async () => {
	let count = 0;
	const list = catalog(async (cursor) => {
		count++;
		return cursor
			? {
					items: [
						{ id: "first", title: "Updated first" },
						{ id: "second", title: "Second" },
					],
					nextCursor: "third",
				}
			: page("first", "second");
	});
	await list.ready();
	await list.read(false).loadMore();
	await list.read(false).retry();
	assert.equal(count, 1);
	await list.read().loadMore();
	assert.deepEqual(list.read().items, [
		{ id: "first", title: "Updated first" },
		{ id: "second", title: "Second" },
	]);
});

test("prefix invalidation refreshes retained pages using fresh continuation cursors", async () => {
	let revision = "a";
	const calls: (string | undefined)[] = [];
	const list = catalog(async (cursor) => {
		calls.push(cursor);
		return cursor ? page(`${revision}-second`, null) : page(`${revision}-first`, `${revision}-next`);
	});
	await list.ready();
	await list.read().loadMore();
	revision = "b";
	await list.cache.invalidateQueries({ queryKey: ["conversations", "project-a"] });
	assert.deepEqual(calls, [undefined, "a-next", undefined, "b-next"]);
	assert.deepEqual(
		list.read().items.map((item) => item.id),
		["b-first", "b-second"],
	);
});

test("workspace/filter switches abort old reads and cannot populate the new scope", async () => {
	let oldSignal: AbortSignal | undefined;
	let resolveOld: ((value: Page<Item>) => void) | undefined;
	const list = catalog(async (_cursor, signal) => {
		oldSignal = signal;
		return new Promise<Page<Item>>((resolve) => {
			resolveOld = resolve;
		});
	});
	assert.ok(oldSignal);
	const nextOptions = catalogPagesOptions({
		queryKey: ["conversations", "project-b", "archived"],
		queryPage: async () => page("archived-b", null),
		itemKey: (item: Item) => item.id,
	});
	list.observer.setOptions(nextOptions);
	assert.equal(oldSignal.aborted, true);
	await list.observer.refetch({ cancelRefetch: false });
	assert.ok(resolveOld);
	resolveOld(page("late-active-a", null));
	await Promise.resolve();
	assert.deepEqual(list.observer.getCurrentResult().data?.pages, [page("archived-b", null)]);
	assert.equal(list.cache.getQueryData(["conversations", "project-a", "active", "pages"]), undefined);
});
