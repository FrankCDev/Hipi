import assert from "node:assert/strict";
import {
	type AppClient,
	AppError,
	type Scope,
	type SidebarWindowRequest,
	type SidebarWindowResult,
} from "@hipi/work-runtime/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { test, vi } from "vitest";
import { reconcileNavigationPublication } from "../../../src/features/workbench/sidebar/navigation-refresh.ts";
import {
	advanceSlice,
	initialSlice,
	presentedWindow,
	reconcileWindowSlice,
} from "../../../src/features/workbench/sidebar/window-presentation.ts";
import {
	discardRecentWindowStaging,
	fetchRecentWindow,
	type RecentWindow,
	readRecentWindow,
	recentWindowOptions,
	type WindowPage,
	windowItems,
	windowKey,
} from "../../../src/features/workbench/sidebar/window-query.ts";

const view = { kind: "project_recent" } as const;
const coverage = {
	generation: "one",
	membershipGeneration: 0,
	projectMembershipGeneration: 0,
	projectOrderGeneration: 0,
	state: "ready",
	completedAt: 1,
	nextCursor: null,
} as const;
function page(
	start = 0,
	length = 50,
	previousCursor: string | null = null,
	nextCursor: string | null = null,
): WindowPage {
	return {
		kind: "window",
		coverage,
		previousCursor,
		nextCursor,
		retained: { eligible: [], unavailable: [] },
		items: Array.from({ length }, (_, index) => ({
			conversation: {
				workspaceId: "physical",
				conversationId: String(start + index),
				title: String(start + index),
				revision: 1,
				createdAt: 1,
				archivedAt: null,
			},
			membership: { workspaceId: "physical", conversationId: String(start + index), projectId: null, revision: 1 },
			recencyAt: 1,
			activityBasis: "creation",
		})),
	};
}
function reader(read: (request: SidebarWindowRequest) => Promise<SidebarWindowResult>) {
	return { call: vi.fn((_method, input) => read(input)) as AppClient["call"], observe: vi.fn() };
}
const signal = () => new AbortController().signal;
const snapshot = (pages: WindowPage[]): RecentWindow => ({
	pages,
	retained: pages.at(-1)?.retained ?? { eligible: [], unavailable: [] },
	paused: false,
	unpublished: false,
	action: "refresh",
	revision: 1,
});
test("six hundred explicitly loaded rows retain canonical order without eviction or rereading", async () => {
	const focused: Scope = { workspaceId: "physical", conversationId: "0" };
	const client = reader(async (request) => {
		const index = request.position.kind === "continue" ? Number(request.position.cursor) : 0;
		const result = page(index * 50, 50, index ? String(index - 1) : null, index < 11 ? String(index + 1) : null);
		const retainedRow = page().items[0];
		assert.ok(retainedRow);
		result.retained.eligible = [{ row: retainedRow, placement: index ? "before" : "inside" }];
		return result;
	});
	let value = await readRecentWindow(client, view, "active", signal(), undefined, {
		action: "refresh",
		retainedScopes: [focused],
	});
	for (let index = 1; index < 12; index++) {
		value = await readRecentWindow(client, view, "active", signal(), value, {
			action: "next",
			retainedScopes: [focused],
		});
		assert.equal(windowItems(value).length, (index + 1) * 50);
	}
	assert.deepEqual(
		windowItems(value).map((row) => row.conversation.conversationId),
		Array.from({ length: 600 }, (_, index) => String(index)),
	);
	const shown = presentedWindow(value, { start: 350, end: 600 }, focused);
	assert.deepEqual(
		shown.before.map((row) => row.conversation.conversationId),
		["0"],
	);
	assert.equal(shown.rows.length, 250);
	const reads = vi.mocked(client.call).mock.calls.length;
	assert.equal(await readRecentWindow(client, view, "active", signal(), value, { action: "previous" }), value);
	assert.equal(vi.mocked(client.call).mock.calls.length, reads);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "0");
	assert.equal(presentedWindow(value, { start: 0, end: 250 }, focused).before.length, 0);
});
test("sparse action budget is five total reads and pauses without inventing empty completion", async () => {
	const client = reader(async () => page(0, 0, null, "next"));
	const value = await readRecentWindow(client, view, "active", signal());
	assert.equal(vi.mocked(client.call).mock.calls.length, 5);
	assert.equal(value.paused, true);
	assert.equal(value.pages.at(-1)?.nextCursor, "next");
});

test("visibility cancellation stops a sparse action before another bounded read", async () => {
	const controller = new AbortController();
	const client = reader(async () => {
		controller.abort();
		return page(0, 0, null, "next");
	});
	await assert.rejects(readRecentWindow(client, view, "active", controller.signal), { name: "AbortError" });
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
});
test("stale continuation and unavailable anchor fallbacks share the same finite budget", async () => {
	let calls = 0;
	const client = reader(async (request) => {
		calls++;
		if (calls === 1) throw new AppError("CURSOR_STALE");
		if (request.position.kind === "around")
			return { kind: "anchor_unavailable", coverage, anchor: request.position.anchor, reason: "ineligible" };
		return page(0, 0, null, "next");
	});
	const anchor = { workspaceId: "physical", conversationId: "anchor" };
	const old = snapshot([page(0, 50, "previous", "next")]);
	const value = await readRecentWindow(client, view, "active", signal(), old, {
		action: "next",
		anchor,
		neighbors: [
			{ ...anchor, conversationId: "neighbor1" },
			{ ...anchor, conversationId: "neighbor2" },
		],
	});
	assert.equal(calls, 5);
	assert.equal(value.paused, true);
	assert.deepEqual(value.pages, old.pages);
	assert.equal(value.refresh?.reset, "anchor_unavailable");
	assert.equal(value.refreshPaused, "budget");
});
test("unpublished replacement retains old coherent rows without dispatching another action", async () => {
	const old = snapshot([page()]);
	const client = reader(async () => ({ kind: "unpublished", coverage: { ...coverage, state: "building" } }));
	const value = await readRecentWindow(client, view, "active", signal(), old);
	assert.deepEqual(value.pages, old.pages);
	assert.equal(value.unpublished, true);
	assert.equal(value.refreshPaused, undefined);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
});

test("an initial unpublished window resumes on the same-generation ready probe without an extra action", async () => {
	const cache = new QueryClient();
	let ready = false;
	const client = reader(async () =>
		ready ? page() : { kind: "unpublished", coverage: { ...coverage, state: "building" } },
	);
	const options = recentWindowOptions(cache, client, view, "active", () => ({}));
	const waiting = await cache.fetchQuery(options);
	assert.equal(waiting.unpublished, true);
	assert.equal(waiting.refreshPaused, undefined);
	assert.equal(waiting.refresh?.attemptReads, 1);
	const observer = new QueryObserver(cache, { ...options, staleTime: Infinity });
	const unsubscribe = observer.subscribe(() => {});
	try {
		await reconcileNavigationPublication(cache, { ...coverage, state: "building" });
		assert.equal(vi.mocked(client.call).mock.calls.length, 1);
		ready = true;
		await reconcileNavigationPublication(cache, coverage);
		assert.equal(vi.mocked(client.call).mock.calls.length, 2);
		const published = cache.getQueryData<RecentWindow>(windowKey(view, "active"));
		assert.equal(published?.unpublished, false);
		assert.equal(windowItems(published).length, 50);
	} finally {
		unsubscribe();
		cache.clear();
	}
});

test("unpublished waits do not renew the attempt budget before a real exhaustion pauses probes", async () => {
	let calls = 0;
	const client = reader(async () => {
		calls++;
		return { kind: "unpublished", coverage: { ...coverage, state: "building" } };
	});
	let value = await readRecentWindow(client, view, "active", signal());
	for (let index = 0; index < 5; index++) value = await readRecentWindow(client, view, "active", signal(), value);
	assert.equal(calls, 5);
	assert.equal(value.refreshPaused, "budget");
	assert.equal(value.refresh?.attemptReads, 5);
});
test("generation mismatch never appends old rows to a replacement", async () => {
	let calls = 0;
	const client = reader(async () => {
		calls++;
		return { ...page(500), coverage: { ...coverage, generation: "two" } };
	});
	const value = await readRecentWindow(client, view, "active", signal(), snapshot([page(0, 50, null, "next")]), {
		action: "next",
	});
	assert.equal(calls, 2);
	assert.equal(value.pages.length, 1);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "500");
});
test("presentation begins10, advances5, and keeps the runtime tie order of two retained rows", () => {
	assert.deepEqual(initialSlice(50), { start: 0, end: 10 });
	assert.deepEqual(advanceSlice({ start: 0, end: 10 }, 50, "next"), { start: 0, end: 15 });
	const value = snapshot([page(50)]);
	const first = page(0, 2).items;
	value.retained.eligible = first.map((row) => ({ row, placement: "before" }));
	const result = presentedWindow(value, { start: 0, end: 10 }, first[0]?.conversation, first[1]?.conversation);
	assert.deepEqual(
		result.before.map((row) => row.conversation.conversationId),
		["0", "1"],
	);
	const next = snapshot([page(100)]);
	next.action = "next";
	assert.ok(reconcileWindowSlice(value, { start: 0, end: 50 }, next).end <= 50);
});

test("terminal presentation includes the single extra row after a bounded expansion", () => {
	assert.deepEqual(initialSlice(11, true), { start: 0, end: 11 });
	const previous = snapshot([page(0, 10, null, "next")]);
	const next = snapshot([page(0, 16)]);
	next.action = "next";
	assert.deepEqual(reconcileWindowSlice(previous, { start: 0, end: 10 }, next), { start: 0, end: 16 });
});

test("five empty continuation ranges do not evict retained visible rows", async () => {
	const previous = snapshot(
		Array.from({ length: 5 }, (_, index) => page(index * 50, 50, index ? String(index - 1) : null, String(index + 1))),
	);
	const value = await readRecentWindow(
		reader(async () => page(0, 0, "previous", "later")),
		view,
		"active",
		signal(),
		previous,
		{ action: "next" },
	);
	assert.deepEqual(windowItems(value), windowItems(previous));
	assert.equal(value.pages.length, 5);
	assert.equal(value.pages.at(-1)?.nextCursor, "later");
	assert.equal(value.paused, true);
});

test("five sparse one-row ranges cannot evict an entire visible window", async () => {
	const previous = snapshot(Array.from({ length: 5 }, (_, index) => page(index * 50, 50, "before", "next")));
	let index = 250;
	const value = await readRecentWindow(
		reader(async () => page(index++, 1, "before", "next")),
		view,
		"active",
		signal(),
		previous,
		{ action: "next" },
	);
	assert.equal(windowItems(value).length, 255);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "0");
	assert.ok(windowItems(value).some((row) => row.conversation.conversationId === "249"));
	assert.equal(value.pages.length, 6);
});

test("overlapping forward and backward windows deduplicate canonical execution identities", async () => {
	const old = snapshot([page(50, 50, "before", "after")]);
	const next = await readRecentWindow(
		reader(async () => page(90, 50, "before", "later")),
		view,
		"active",
		signal(),
		old,
		{ action: "next" },
	);
	const previous = await readRecentWindow(
		reader(async () => page(20, 40, null, "after")),
		view,
		"active",
		signal(),
		next,
		{ action: "previous" },
	);
	assert.deepEqual(
		windowItems(previous).map((row) => row.conversation.conversationId),
		Array.from({ length: 120 }, (_, index) => String(index + 20)),
	);
	assert.equal(previous.pages[0]?.previousCursor, null);
	assert.equal(previous.pages.at(-1)?.nextCursor, "later");
});

test("ten thousand loaded rows rebuild in two hundred reads without losing their prefix", async () => {
	const old = snapshot(
		Array.from({ length: 200 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")),
	);
	const client = reader(async (request) => {
		const start = request.position.kind === "continue" ? Number(request.position.cursor) : 0;
		return {
			...page(start, 50, start ? "before" : null, String(start + 50)),
			coverage: { ...coverage, generation: "two" },
		};
	});
	const value = await readRecentWindow(client, view, "active", signal(), old, {
		action: "refresh",
		targetCount: 10000,
		anchor: { workspaceId: "physical", conversationId: "9900" },
	});
	assert.equal(vi.mocked(client.call).mock.calls.length, 200);
	assert.deepEqual(vi.mocked(client.call).mock.calls[0]?.[1], { view, filter: "active", position: { kind: "head" } });
	assert.deepEqual(
		windowItems(value).map((row) => row.conversation.conversationId),
		Array.from({ length: 10000 }, (_, index) => String(index)),
	);
	assert.equal(value.pages.at(-1)?.nextCursor, "10000");
	assert.equal(value.paused, false);
	assert.equal(value.refresh, undefined);
	assert.ok(value.pages.every((part) => part.coverage.generation === "two"));
});

test("ten-thousand-row sparse rebuild and its one restart share one thousand total reads", async () => {
	const old = snapshot(
		Array.from({ length: 200 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")),
	);
	let calls = 0;
	let heads = 0;
	const client = reader(async (request) => {
		calls++;
		if (request.position.kind === "head") heads++;
		if (calls === 500) throw new AppError("CURSOR_STALE");
		return { ...page(0, 0, null, "sparse"), coverage: { ...coverage, generation: calls < 500 ? "two" : "three" } };
	});
	const value = await readRecentWindow(client, view, "active", signal(), old, {
		action: "refresh",
		targetCount: 10000,
	});
	assert.equal(calls, 1000);
	assert.equal(heads, 2);
	assert.equal(value.pages, old.pages);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "0");
	assert.equal(value.refresh?.attemptBudget, 1000);
	assert.equal(value.refresh?.attemptReads, 1000);
	assert.equal(value.refresh?.restarts, 1);
	assert.equal(value.refresh?.pages.length, 1);
	assert.equal(value.refreshPaused, "budget");
});

test("refresh stops early at a terminal cursor without fetching unseen catalog rows", async () => {
	const old = snapshot([page(0, 50, null, "later"), page(50)]);
	const client = reader(async () => page(1000, 12));
	const value = await readRecentWindow(client, view, "active", signal(), old, { action: "refresh", targetCount: 100 });
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.equal(windowItems(value).length, 12);
	assert.equal(value.paused, false);
});

test("sparse rebuild exhausts its proportional total once, retains the old snapshot, and ignores probes", async () => {
	const old = snapshot(
		Array.from({ length: 12 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")),
	);
	const client = reader(async () => page(0, 0, null, "sparse"));
	const paused = await readRecentWindow(client, view, "active", signal(), old, { action: "refresh", targetCount: 600 });
	assert.equal(vi.mocked(client.call).mock.calls.length, 60);
	assert.equal(paused.pages, old.pages);
	assert.equal(paused.retained, old.retained);
	assert.equal(paused.revision, old.revision);
	assert.equal(paused.refreshPaused, "budget");
	assert.equal(paused.refresh?.attemptReads, 60);
	assert.equal(paused.refresh?.attemptBudget, 60);
	assert.equal(paused.refresh?.pages.length, 1);
	assert.deepEqual(paused.refresh?.position, { kind: "continue", cursor: "sparse" });
	for (let index = 0; index < 3; index++)
		assert.equal(await readRecentWindow(client, view, "active", signal(), paused), paused);
	assert.equal(vi.mocked(client.call).mock.calls.length, 60);
});

test("one publication restart shares the same total budget rather than renewing it", async () => {
	let calls = 0;
	const old = snapshot([page()]);
	const client = reader(async () => {
		calls++;
		if (calls === 20) throw new AppError("CURSOR_STALE");
		return { ...page(0, 0, null, "next"), coverage: { ...coverage, generation: calls < 20 ? "two" : "three" } };
	});
	const value = await readRecentWindow(client, view, "active", signal(), old);
	assert.equal(calls, 40);
	assert.equal(value.pages, old.pages);
	assert.equal(value.refresh?.restarts, 1);
	assert.equal(value.refresh?.attemptReads, 40);
	assert.equal(value.refreshPaused, "budget");
});

test("a second publication change pauses without mixing rows or automatically restarting again", async () => {
	let calls = 0;
	const old = snapshot([page(0, 50), page(50, 50)]);
	const client = reader(async () => {
		calls++;
		const generation = calls === 1 ? "two" : calls < 4 ? "three" : "four";
		return { ...page(calls * 50, 10, null, "next"), coverage: { ...coverage, generation } };
	});
	const value = await readRecentWindow(client, view, "active", signal(), old);
	assert.equal(calls, 4);
	assert.equal(value.refreshPaused, "publication");
	assert.equal(value.pages, old.pages);
	assert.ok(value.refresh?.pages.every((part) => part.coverage.generation === "three"));
	assert.equal(await readRecentWindow(client, view, "active", signal(), value), value);
	assert.equal(calls, 4);
});

test("stale pagination cannot replace a five-hundred-row snapshot with an incomplete replacement", async () => {
	let calls = 0;
	const old = snapshot(
		Array.from({ length: 10 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")),
	);
	const client = reader(async () => {
		if (++calls === 1) throw new AppError("CURSOR_STALE");
		return { ...page(calls * 50, 50, null, "next"), coverage: { ...coverage, generation: "two" } };
	});
	const value = await readRecentWindow(client, view, "active", signal(), old, { action: "next" });
	assert.equal(calls, 5);
	assert.equal(value.pages, old.pages);
	assert.equal(windowItems(value).length, 500);
	assert.equal(value.refresh?.pages.flatMap((part) => part.items).length, 200);
	assert.equal(value.refresh?.targetCount, 500);
	assert.equal(value.refreshPaused, "budget");
});

test("supervised refresh yields after five reads and cancellation releases the scheduled next batch", async () => {
	vi.useFakeTimers();
	try {
		const controller = new AbortController();
		const old = snapshot([page()]);
		const client = reader(async () => page(0, 0, null, "next"));
		const pending = readRecentWindow(client, view, "active", controller.signal, old);
		const rejected = assert.rejects(pending, { name: "AbortError" });
		for (let index = 0; index < 20; index++) await Promise.resolve();
		assert.equal(vi.mocked(client.call).mock.calls.length, 5);
		assert.equal(vi.getTimerCount(), 1);
		controller.abort();
		await rejected;
		assert.equal(vi.getTimerCount(), 0);
		await vi.runAllTimersAsync();
		assert.equal(vi.mocked(client.call).mock.calls.length, 5);
		assert.equal(windowItems(old).length, 50);
	} finally {
		vi.useRealTimers();
	}
});

test("explicit retry resumes the saved sparse cursor without repeating successful reads", async () => {
	let calls = 0;
	const old = snapshot([page()]);
	const positions: SidebarWindowRequest["position"][] = [];
	const client = reader(async (request) => {
		positions.push(request.position);
		calls++;
		return calls <= 40 ? page(0, 0, null, `cursor-${calls}`) : page(1000);
	});
	const paused = await readRecentWindow(client, view, "active", signal(), old);
	const value = await readRecentWindow(client, view, "active", signal(), paused, {
		action: "refresh",
		explicitRetry: true,
	});
	assert.equal(calls, 41);
	assert.deepEqual(positions[40], { kind: "continue", cursor: "cursor-40" });
	assert.equal(value.refreshPaused, undefined);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "1000");
});

test("explicit retry discards an expired staged cursor once and completes under its new finite budget", async () => {
	let calls = 0;
	const old = snapshot([page()]);
	const positions: SidebarWindowRequest["position"][] = [];
	const client = reader(async (request) => {
		positions.push(request.position);
		calls++;
		if (calls === 41) throw new AppError("CURSOR_STALE");
		return calls <= 40
			? page(0, 0, null, `cursor-${calls}`)
			: { ...page(1000), coverage: { ...coverage, generation: "two" } };
	});
	const paused = await readRecentWindow(client, view, "active", signal(), old);
	const value = await readRecentWindow(client, view, "active", signal(), paused, {
		action: "refresh",
		explicitRetry: true,
	});
	assert.equal(calls, 42);
	assert.deepEqual(positions.slice(40), [{ kind: "continue", cursor: "cursor-40" }, { kind: "head" }]);
	assert.equal(value.paused, false);
	assert.equal(value.pages[0]?.coverage.generation, "two");
});

test("query refresh keeps cached rows coherent until the entire captured extent is ready", async () => {
	const cache = new QueryClient();
	const old = snapshot(Array.from({ length: 6 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")));
	cache.setQueryData(windowKey(view, "active"), old);
	let release: ((result: SidebarWindowResult) => void) | undefined;
	let calls = 0;
	const client = reader(async () => {
		calls++;
		if (calls === 6)
			return new Promise<SidebarWindowResult>((resolve) => {
				release = resolve;
			});
		return { ...page(calls * 50, 50, null, "next"), coverage: { ...coverage, generation: "two" } };
	});
	const pending = fetchRecentWindow(cache, client, view, "active", "refresh", () => ({ targetCount: 300 }));
	await vi.waitFor(() => assert.equal(calls, 6));
	assert.equal(cache.getQueryData(windowKey(view, "active")), old);
	assert.ok(release);
	release({ ...page(300, 50, null, "next"), coverage: { ...coverage, generation: "two" } });
	const value = await pending;
	assert.equal(windowItems(value).length, 300);
	assert.ok(value.pages.every((part) => part.coverage.generation === "two"));
	assert.notEqual(cache.getQueryData(windowKey(view, "active")), old);
	cache.clear();
});

test("automatic query refetch cannot inherit an earlier explicit retry grant", async () => {
	const cache = new QueryClient();
	cache.setQueryData(windowKey(view, "active"), snapshot([page()]));
	const client = reader(async () => page(0, 0, null, "next"));
	const value = await fetchRecentWindow(cache, client, view, "active", "refresh", () => ({}));
	assert.equal(value.refreshPaused, "budget");
	assert.equal(vi.mocked(client.call).mock.calls.length, 40);
	await cache.refetchQueries({ queryKey: windowKey(view, "active") });
	assert.equal(vi.mocked(client.call).mock.calls.length, 40);
	assert.equal(recentWindowOptions(cache, client, view, "active", () => ({})).gcTime, 0);
	cache.clear();
});

test("hiding drops staged metadata without losing committed rows or resetting pause authority", async () => {
	const cache = new QueryClient();
	const old = snapshot([page()]);
	const client = reader(async () => page(0, 0, null, "next"));
	const paused = await readRecentWindow(client, view, "active", signal(), old);
	cache.setQueryData(windowKey(view, "active"), paused);
	await cache.cancelQueries({ queryKey: windowKey(view, "active") });
	discardRecentWindowStaging(cache, view, "active");
	const released = cache.getQueryData<RecentWindow>(windowKey(view, "active"));
	assert.ok(released);
	assert.equal(released.refresh, undefined);
	assert.equal(released.refreshPaused, "budget");
	assert.equal(released.pages, old.pages);
	assert.equal(await readRecentWindow(client, view, "active", signal(), released), released);
	assert.equal(vi.mocked(client.call).mock.calls.length, 40);
	cache.clear();
});

test("a late result after cancellation cannot replace or mutate the committed snapshot", async () => {
	const controller = new AbortController();
	const old = snapshot([page()]);
	let release: ((result: SidebarWindowResult) => void) | undefined;
	const client = reader(
		() =>
			new Promise<SidebarWindowResult>((resolve) => {
				release = resolve;
			}),
	);
	const pending = readRecentWindow(client, view, "active", controller.signal, old);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	controller.abort();
	assert.ok(release);
	release({ ...page(1000), coverage: { ...coverage, generation: "two" } });
	await rejected;
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.equal(windowItems(old)[0]?.conversation.conversationId, "0");
	assert.equal(old.refresh, undefined);
});

test("one disabled active-view observer keeps metadata, while leaving its query releases it", async () => {
	const cache = new QueryClient();
	const client = reader(async () => page());
	const options = recentWindowOptions(cache, client, view, "active", () => ({}));
	const observer = new QueryObserver(cache, options);
	const unsubscribe = observer.subscribe(() => {});
	await observer.refetch({ cancelRefetch: false });
	observer.setOptions({ ...options, enabled: false });
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.equal(windowItems(cache.getQueryData<RecentWindow>(windowKey(view, "active"))).length, 50);
	unsubscribe();
	await vi.waitFor(() => assert.equal(cache.getQueryData(windowKey(view, "active")), undefined));
	cache.clear();
});

test("retained proof requests contain at most two distinct canonical scopes", async () => {
	const first = { workspaceId: "physical", conversationId: "one" };
	const second = { workspaceId: "physical", conversationId: "two" };
	const client = reader(async (request) => {
		assert.deepEqual(request.retainedScopes, [first, second]);
		return page();
	});
	await readRecentWindow(client, view, "active", signal(), undefined, {
		action: "refresh",
		retainedScopes: [first, first, second, { ...first, conversationId: "three" }],
	});
});
