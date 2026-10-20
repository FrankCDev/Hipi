import assert from "node:assert/strict";
import { type AppClient, AppError, type SidebarPage } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { test, vi } from "vitest";
import {
	fetchNavigationWindow,
	type NavigationWindow,
	navigationKey,
	navigationOptions,
	readNavigationWindow,
} from "../../../src/features/workbench/sidebar/navigation-query.ts";
import {
	reconcileNavigationPublication,
	sameNavigationPublication,
	watchNavigationSignals,
} from "../../../src/features/workbench/sidebar/navigation-refresh.ts";

const view = { kind: "recent" } as const;
const page = (
	id: string,
	nextCursor: string | null = null,
	generation = "one",
	membershipGeneration = 0,
): SidebarPage => ({
	items: id
		? [
				{
					conversation: {
						workspaceId: "workspace",
						conversationId: id,
						title: id,
						revision: 1,
						createdAt: 1,
						archivedAt: null,
					},
					recencyAt: 1,
					activityBasis: "creation",
				},
			]
		: [],
	coverage: { generation, membershipGeneration, state: "ready", completedAt: 1, nextCursor: null },
	nextCursor,
});

test("publication probes leave unchanged windows alone and retry failed replacement only after backoff", async () => {
	const cache = new QueryClient();
	let generation = "one";
	let failed = false;
	const client = reader(async () => {
		if (failed) throw new Error("Unavailable");
		return page(generation, null, generation);
	});
	const observer = new QueryObserver(cache, navigationOptions(cache, client, view, "active"));
	const dispose = observer.subscribe(() => {});
	await observer.refetch({ cancelRefetch: false });
	const initialCalls = vi.mocked(client.call).mock.calls.length;
	await reconcileNavigationPublication(cache, page("one").coverage);
	assert.equal(vi.mocked(client.call).mock.calls.length, initialCalls);
	generation = "two";
	failed = true;
	await reconcileNavigationPublication(cache, page("two", null, "two").coverage);
	assert.equal(observer.getCurrentResult().data?.pages[0]?.coverage.generation, "one");
	const failedCalls = vi.mocked(client.call).mock.calls.length;
	await reconcileNavigationPublication(cache, page("two", null, "two").coverage);
	assert.equal(vi.mocked(client.call).mock.calls.length, failedCalls);
	failed = false;
	await reconcileNavigationPublication(cache, page("two", null, "two").coverage, Date.now() + 10001);
	assert.equal(observer.getCurrentResult().data?.pages[0]?.coverage.generation, "two");
	dispose();
	cache.clear();
});
function reader(read: (cursor?: string, signal?: AbortSignal) => Promise<SidebarPage>) {
	const call = vi.fn((_method, input, signal) => read(input.cursor, signal)) as AppClient["call"];
	return { call, observe: vi.fn() };
}
const signal = () => new AbortController().signal;

test("stale continuation atomically recovers and never combines generations or pin memberships", async () => {
	for (const membershipOnly of [false, true]) {
		const old = page("old", "old-next");
		let finish: ((value: SidebarPage) => void) | undefined;
		const client = reader(async (cursor) => {
			if (cursor) throw new AppError("CURSOR_STALE");
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		const cache = new QueryClient();
		const key = navigationKey(view, "active");
		const previous = { pages: [old], cursors: [undefined] };
		cache.setQueryData(key, previous);
		const pending = cache.fetchQuery(navigationOptions(cache, client, view, "active", "more"));
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(cache.getQueryData(key), previous);
		assert.ok(finish);
		finish(page("fresh", null, membershipOnly ? "one" : "two", membershipOnly ? 1 : 0));
		await pending;
		assert.deepEqual(
			cache.getQueryData<NavigationWindow>(key)?.pages.flatMap((p) => p.items.map((i) => i.conversation.title)),
			["fresh"],
		);
		cache.clear();
	}
});

test("second generation race is bounded and retains the previous cache", async () => {
	const previous = { pages: [page("old", "next"), page("old-two")], cursors: [undefined, "next"] };
	const client = reader(async (cursor) => {
		if (cursor) throw new AppError("CURSOR_STALE");
		return page("fresh", "raced-next", "two");
	});
	const cache = new QueryClient();
	cache.setQueryData(navigationKey(view, "active"), previous);
	await assert.rejects(cache.fetchQuery(navigationOptions(cache, client, view, "active")), { code: "CURSOR_STALE" });
	assert.equal(vi.mocked(client.call).mock.calls.length, 4);
	assert.deepEqual(cache.getQueryData(navigationKey(view, "active")), previous);
	cache.clear();
});

test("explicit continuation slides five pages, background refresh preserves that start", async () => {
	const calls: (string | undefined)[] = [];
	const client = reader(async (cursor) => {
		calls.push(cursor);
		const index = Number(cursor ?? 0);
		return page(String(index), String(index + 1));
	});
	let window = await readNavigationWindow(client, view, "active", signal());
	for (let index = 0; index < 5; index++)
		window = await readNavigationWindow(client, view, "active", signal(), window, "more");
	assert.equal(window.pages.length, 5);
	assert.equal(window.cursors[0], "1");
	calls.length = 0;
	window = await readNavigationWindow(client, view, "active", signal(), window);
	assert.deepEqual(calls, ["1", "2", "3", "4", "5"]);
	assert.equal(window.cursors[0], "1");
	window = await readNavigationWindow(client, view, "active", signal(), window, "first");
	assert.deepEqual(window.cursors, [undefined]);
});

test("imperative pagination retires its action before automatic invalidation", async () => {
	const calls: (string | undefined)[] = [];
	const cache = new QueryClient();
	const client = reader(async (cursor) => {
		calls.push(cursor);
		const index = Number(cursor ?? 0);
		return page(String(index), String(index + 1));
	});
	const observer = new QueryObserver(cache, navigationOptions(cache, client, view, "active"));
	const dispose = observer.subscribe(() => {});
	await observer.refetch({ cancelRefetch: false });
	await fetchNavigationWindow(cache, client, view, "active", "more");
	assert.equal(observer.getCurrentResult().data?.pages.length, 2);
	calls.length = 0;
	await cache.invalidateQueries({ queryKey: ["sidebar-navigation"] });
	assert.deepEqual(calls, [undefined, "1"], "No React rerender is needed to retire the pagination query function");
	assert.equal(observer.getCurrentResult().data?.pages.length, 2);
	dispose();
	cache.clear();
});

test("failed imperative pagination does not issue fallback IO or retain a later pagination action", async () => {
	const calls: (string | undefined)[] = [];
	let fail = false;
	const cache = new QueryClient();
	const client = reader(async (cursor) => {
		calls.push(cursor);
		if (fail) throw new Error("OFFLINE");
		return page("row", "next");
	});
	const observer = new QueryObserver(cache, navigationOptions(cache, client, view, "active"));
	const dispose = observer.subscribe(() => {});
	await observer.refetch({ cancelRefetch: false });
	calls.length = 0;
	fail = true;
	await assert.rejects(fetchNavigationWindow(cache, client, view, "active", "more"), /OFFLINE/);
	assert.deepEqual(calls, ["next"]);
	fail = false;
	calls.length = 0;
	await cache.invalidateQueries({ queryKey: ["sidebar-navigation"] });
	assert.deepEqual(calls, [undefined]);
	assert.equal(observer.getCurrentResult().data?.pages.length, 1);
	dispose();
	cache.clear();
});

test("a client ignoring cancellation cannot return either a replacement or an appended page", async () => {
	for (const action of ["refresh", "more"] as const) {
		let finish: ((value: SidebarPage) => void) | undefined;
		const client = reader(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new AbortController();
		const pending = readNavigationWindow(
			client,
			view,
			"active",
			controller.signal,
			{ pages: [page("old", "next")], cursors: [undefined] },
			action,
		);
		assert.ok(finish);
		controller.abort();
		finish(page("late"));
		await assert.rejects(pending, { name: "AbortError" });
	}
});

test("an empty filtered page preserves its continuation and building is not complete coverage", async () => {
	const empty = page("", "next");
	empty.coverage.state = "building";
	const result = await readNavigationWindow(
		reader(async () => empty),
		view,
		"active",
		signal(),
	);
	assert.equal(result.pages[0]?.nextCursor, "next");
	assert.equal(result.pages[0]?.coverage.state, "building");
});

test("a source rebuild retains the old coherent window visibly stale until replacement is published", async () => {
	const previous = { pages: [page("old", "next")], cursors: [undefined] };
	const building = page("", null, "new");
	building.coverage.state = "building";
	const client = reader(async () => building);
	const retained = await readNavigationWindow(client, view, "active", signal(), previous);
	assert.equal(retained.pages[0]?.items[0]?.conversation.title, "old");
	assert.equal(retained.pages[0]?.coverage.generation, "one");
	assert.equal(retained.pages[0]?.coverage.state, "refreshing");
	assert.equal(retained.rebuilding, true);
	const calls = vi.mocked(client.call).mock.calls.length;
	assert.equal(await readNavigationWindow(client, view, "active", signal(), retained, "more"), retained);
	assert.equal(
		vi.mocked(client.call).mock.calls.length,
		calls,
		"Invalidated publication cannot paginate the retained old rows",
	);
	const published = await readNavigationWindow(
		reader(async () => page("fresh", null, "new")),
		view,
		"active",
		signal(),
		retained,
	);
	assert.equal(published.pages[0]?.items[0]?.conversation.title, "fresh");
	assert.equal(published.pages[0]?.coverage.state, "ready");
});

test("a scope replacement aborts old reads and cannot publish into another query", async () => {
	let oldSignal: AbortSignal | undefined;
	let finish: ((value: SidebarPage) => void) | undefined;
	const client = reader((_cursor, requestSignal) => {
		oldSignal = requestSignal;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const cache = new QueryClient();
	const observer = new QueryObserver(cache, navigationOptions(cache, client, view, "active"));
	const dispose = observer.subscribe(() => {});
	assert.ok(oldSignal);
	observer.setOptions(
		navigationOptions(
			cache,
			reader(async () => page("other")),
			{ kind: "workspace", workspaceId: "other" },
			"archived",
		),
	);
	assert.equal(oldSignal.aborted, true);
	await observer.refetch();
	assert.ok(finish);
	finish(page("late"));
	await Promise.resolve();
	assert.equal(observer.getCurrentResult().data?.pages[0]?.items[0]?.conversation.title, "other");
	assert.equal(cache.getQueryData(navigationKey(view, "active")), undefined);
	dispose();
	cache.clear();
});

test("signals invalidate sidebar reads without activating execution and unchanged activity is ignored", () => {
	const cache = new QueryClient();
	const stop = watchNavigationSignals(cache);
	cache.setQueryData(navigationKey(view, "active"), { pages: [page("one")], cursors: [undefined] });
	cache.setQueryData(["receipt", "workspace", "request"], { state: "accepted" });
	assert.equal(cache.getQueryState(navigationKey(view, "active"))?.isInvalidated, true);
	cache.setQueryData(navigationKey(view, "active"), { pages: [page("one")], cursors: [undefined] });
	cache.setQueryData(["receipt", "workspace", "request"], { state: "accepted" });
	assert.equal(cache.getQueryState(navigationKey(view, "active"))?.isInvalidated, false);
	cache.setQueryData(["conversations", "workspace"], {});
	void cache.invalidateQueries({ queryKey: ["conversations", "workspace"] });
	assert.equal(cache.getQueryState(navigationKey(view, "active"))?.isInvalidated, true);
	assert.equal(sameNavigationPublication(page("a").coverage, page("b", null, "one", 1).coverage), false);
	assert.equal(sameNavigationPublication(page("a").coverage, { ...page("a").coverage, state: "refreshing" }), true);
	stop();
	cache.clear();
});

test("logical membership and project-pin generations independently fence pagination", async () => {
	for (const field of ["projectMembershipGeneration", "projectOrderGeneration"] as const) {
		const old = page("old", "next");
		old.coverage.projectMembershipGeneration = 1;
		old.coverage.projectOrderGeneration = 1;
		const changed = page("changed");
		changed.coverage = { ...old.coverage, [field]: 2 };
		assert.equal(sameNavigationPublication(old.coverage, changed.coverage), false);
		const calls: (string | undefined)[] = [];
		const client = reader(async (cursor) => {
			calls.push(cursor);
			return changed;
		});
		const result = await readNavigationWindow(
			client,
			{ kind: "project_recent" },
			"active",
			signal(),
			{ pages: [old], cursors: [undefined] },
			"more",
		);
		assert.deepEqual(calls, ["next", undefined]);
		assert.equal(result.pages.length, 1);
		assert.equal(result.pages[0]?.items[0]?.conversation.title, "changed");
	}
});
