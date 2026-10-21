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
test("initial sparse reads automatically cross multiple batches without a transport control", async () => {
	let calls = 0;
	const client = reader(async () => page(0, ++calls === 16 ? 10 : 0, null, `cursor-${calls}`));
	const value = await readRecentWindow(client, view, "active", signal());
	assert.equal(calls, 16);
	assert.equal(value.paused, false);
	assert.equal(value.refreshPaused, undefined);
	assert.equal(windowItems(value).length, 10);
	assert.equal(value.pages.length, 1);
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
test("stale continuation and bounded anchor fallbacks automatically reach the coherent head", async () => {
	let calls = 0;
	const client = reader(async (request) => {
		calls++;
		if (calls === 1) throw new AppError("CURSOR_STALE");
		if (request.position.kind === "around")
			return { kind: "anchor_unavailable", coverage, anchor: request.position.anchor, reason: "ineligible" };
		return page(1000, calls === 6 ? 50 : 0, null, `cursor-${calls}`);
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
	assert.equal(calls, 6);
	assert.equal(value.paused, false);
	assert.equal(value.reset, "anchor_unavailable");
	assert.equal(value.refreshPaused, undefined);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "1000");
	assert.equal(windowItems(old)[0]?.conversation.conversationId, "0");
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
	assert.deepEqual(waiting.refresh?.recentCursors, []);
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

test("unpublished probes remain automatic after repeated building responses", async () => {
	let calls = 0;
	const client = reader(async () => {
		calls++;
		return calls === 9 ? page() : { kind: "unpublished", coverage: { ...coverage, state: "building" } };
	});
	let value = await readRecentWindow(client, view, "active", signal());
	for (let index = 0; index < 7; index++) {
		value = await readRecentWindow(client, view, "active", signal(), value);
		assert.equal(value.unpublished, true);
		assert.equal(value.refreshPaused, undefined);
	}
	value = await readRecentWindow(client, view, "active", signal(), value);
	assert.equal(calls, 9);
	assert.equal(value.paused, false);
	assert.equal(windowItems(value).length, 50);
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

test.each(["next", "previous"] as const)(
	"sparse %s ranges continue automatically without evicting visible rows",
	async (action) => {
		const previous = snapshot(Array.from({ length: 5 }, (_, index) => page(index * 50, 50, "before", "after")));
		let calls = 0;
		const value = await readRecentWindow(
			reader(async () => {
				calls++;
				return page(action === "next" ? 250 : -5, calls === 12 ? 5 : 0, `before-${calls}`, `after-${calls}`);
			}),
			view,
			"active",
			signal(),
			previous,
			{ action },
		);
		assert.equal(calls, 12);
		assert.equal(windowItems(value).length, 255);
		assert.ok(windowItems(value).some((row) => row.conversation.conversationId === "0"));
		assert.ok(windowItems(value).some((row) => row.conversation.conversationId === "249"));
		assert.equal(value.pages.length, 6);
		assert.equal(value.paused, false);
	},
);

test("five sparse one-row ranges cannot evict an entire visible window", async () => {
	const previous = snapshot(Array.from({ length: 5 }, (_, index) => page(index * 50, 50, "before", "next")));
	let index = 250;
	const value = await readRecentWindow(
		reader(async () => page(index++, 1, "before", `next-${index}`)),
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

test("a large sparse rebuild crosses the old proportional limit without publishing its partial replacement", async () => {
	const old = snapshot(
		Array.from({ length: 200 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")),
	);
	let calls = 0;
	let heads = 0;
	const client = reader(async (request) => {
		calls++;
		if (request.position.kind === "head") heads++;
		if (calls === 500) throw new AppError("CURSOR_STALE");
		return {
			...page(Math.max(0, calls - 1101) * 50, calls > 1100 ? 50 : 0, null, `cursor-${calls}`),
			coverage: { ...coverage, generation: calls < 500 ? "two" : "three" },
		};
	});
	const value = await readRecentWindow(client, view, "active", signal(), old, {
		action: "refresh",
		targetCount: 10000,
	});
	assert.equal(calls, 1300);
	assert.equal(heads, 2);
	assert.equal(windowItems(old)[0]?.conversation.conversationId, "0");
	assert.equal(windowItems(value).length, 10000);
	assert.equal(value.pages.length, 200);
	assert.equal(value.refresh, undefined);
	assert.equal(value.paused, false);
	assert.ok(value.pages.every((part) => part.coverage.generation === "three"));
});

test("refresh stops early at a terminal cursor without fetching unseen catalog rows", async () => {
	const old = snapshot([page(0, 50, null, "later"), page(50)]);
	const client = reader(async () => page(1000, 12));
	const value = await readRecentWindow(client, view, "active", signal(), old, { action: "refresh", targetCount: 100 });
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.equal(windowItems(value).length, 12);
	assert.equal(value.paused, false);
});

test("a progressing one-row rebuild completes automatically beyond its former sixty-read cap", async () => {
	const old = snapshot(
		Array.from({ length: 12 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")),
	);
	let calls = 0;
	const client = reader(async () => page(1000 + calls++, 1, null, `cursor-${calls}`));
	const value = await readRecentWindow(client, view, "active", signal(), old, { action: "refresh", targetCount: 600 });
	assert.equal(calls, 600);
	assert.equal(windowItems(value).length, 600);
	assert.equal(value.pages.length, 12);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "1000");
	assert.equal(windowItems(old)[0]?.conversation.conversationId, "0");
	assert.equal(value.refreshPaused, undefined);
	assert.equal(value.paused, false);
});

test("one publication restart automatically continues through the next read batch", async () => {
	let calls = 0;
	const old = snapshot([page()]);
	const client = reader(async () => {
		calls++;
		if (calls === 20) throw new AppError("CURSOR_STALE");
		return {
			...page(1000, calls === 41 ? 50 : 0, null, `cursor-${calls}`),
			coverage: { ...coverage, generation: calls < 20 ? "two" : "three" },
		};
	});
	const value = await readRecentWindow(client, view, "active", signal(), old);
	assert.equal(calls, 41);
	assert.equal(value.paused, false);
	assert.equal(value.refresh, undefined);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, "1000");
	assert.ok(value.pages.every((part) => part.coverage.generation === "three"));
});

test("a second publication change pauses without mixing rows or automatically restarting again", async () => {
	let calls = 0;
	const old = snapshot([page(0, 50), page(50, 50)]);
	const client = reader(async () => {
		calls++;
		const generation = calls === 1 ? "two" : calls < 4 ? "three" : "four";
		return { ...page(calls * 50, 10, null, `next-${calls}`), coverage: { ...coverage, generation } };
	});
	const value = await readRecentWindow(client, view, "active", signal(), old);
	assert.equal(calls, 4);
	assert.equal(value.refreshPaused, "publication");
	assert.equal(value.pages, old.pages);
	assert.ok(value.refresh?.pages.every((part) => part.coverage.generation === "three"));
	assert.equal(await readRecentWindow(client, view, "active", signal(), value), value);
	assert.equal(calls, 4);
});

test("an unstable first read never exposes its incomplete replacement as committed rows", async () => {
	let calls = 0;
	const client = reader(async () => {
		calls++;
		return { ...page(calls, 1, null, `cursor-${calls}`), coverage: { ...coverage, generation: String(calls) } };
	});
	const value = await readRecentWindow(client, view, "active", signal());
	assert.equal(calls, 4);
	assert.equal(value.refreshPaused, "publication");
	assert.deepEqual(value.pages, []);
	assert.equal(value.refresh?.pages.flatMap((part) => part.items).length, 1);
});

test("stale pagination automatically rebuilds the entire captured five-hundred-row extent", async () => {
	let calls = 0;
	const old = snapshot(
		Array.from({ length: 10 }, (_, index) => page(index * 50, 50, index ? "before" : null, "after")),
	);
	const client = reader(async () => {
		if (++calls === 1) throw new AppError("CURSOR_STALE");
		return { ...page(calls * 50, 50, null, `next-${calls}`), coverage: { ...coverage, generation: "two" } };
	});
	const value = await readRecentWindow(client, view, "active", signal(), old, { action: "next" });
	assert.equal(calls, 11);
	assert.equal(windowItems(value).length, 500);
	assert.equal(windowItems(old).length, 500);
	assert.equal(value.refresh, undefined);
	assert.equal(value.paused, false);
	assert.ok(value.pages.every((part) => part.coverage.generation === "two"));
});

test("supervised refresh yields after five reads and cancellation releases the scheduled next batch", async () => {
	vi.useFakeTimers();
	try {
		const controller = new AbortController();
		const old = snapshot([page()]);
		let calls = 0;
		const client = reader(async () => page(0, 0, null, `next-${++calls}`));
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

test.each([false, true])("explicit publication retry resumes staged rows, with expired cursor=%s", async (expired) => {
	let calls = 0;
	const old = snapshot([page()]);
	const positions: SidebarWindowRequest["position"][] = [];
	const client = reader(async (request) => {
		positions.push(request.position);
		calls++;
		if (calls === 4 || (calls === 5 && expired)) throw new AppError("CURSOR_STALE");
		return {
			...page(
				calls === 5 ? 2001 : calls === 6 ? 3000 : calls === 3 ? 2000 : 1000,
				calls >= 5 ? (expired ? 50 : 49) : 1,
				null,
				calls >= 5 ? null : `cursor-${calls}`,
			),
			coverage: { ...coverage, generation: calls === 1 ? "two" : calls === 6 ? "four" : "three" },
		};
	});
	const paused = await readRecentWindow(client, view, "active", signal(), old);
	assert.equal(paused.refreshPaused, "publication");
	assert.equal(paused.pages, old.pages);
	const value = await readRecentWindow(client, view, "active", signal(), paused, {
		action: "refresh",
		explicitRetry: true,
	});
	assert.equal(calls, expired ? 6 : 5);
	assert.deepEqual(positions[4], { kind: "continue", cursor: "cursor-3" });
	if (expired) assert.deepEqual(positions[5], { kind: "head" });
	assert.equal(value.refreshPaused, undefined);
	assert.equal(windowItems(value).length, 50);
	assert.equal(windowItems(value)[0]?.conversation.conversationId, expired ? "3000" : "2000");
});

test.each(["repeat", "cycle"] as const)("a %s cursor rejects without publishing or looping", async (kind) => {
	let calls = 0;
	const old = snapshot([page()]);
	const client = reader(async () => page(1000, 0, null, kind === "repeat" ? "same" : `cycle-${++calls % 3}`));
	await assert.rejects(
		readRecentWindow(client, view, "active", signal(), old),
		(error) => error instanceof AppError && error.code === "INVALID_REQUEST",
	);
	assert.equal(vi.mocked(client.call).mock.calls.length, kind === "repeat" ? 2 : 4);
	assert.equal(windowItems(old)[0]?.conversation.conversationId, "0");
});

test("deadline abort retains the cache and a deliberate retry can read again", async () => {
	const deadline = new AbortController();
	const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
	const cache = new QueryClient();
	const old = snapshot([page()]);
	cache.setQueryData(windowKey(view, "active"), old);
	let calls = 0;
	const client = reader(async () => {
		if (++calls === 6) deadline.abort(new DOMException("Timed out", "TimeoutError"));
		return page(1000, 0, null, `cursor-${calls}`);
	});
	try {
		await assert.rejects(
			fetchRecentWindow(cache, client, view, "active", "refresh", () => ({})),
			{ name: "TimeoutError" },
		);
		assert.equal(calls, 6);
		assert.equal(cache.getQueryData(windowKey(view, "active")), old);
		assert.equal(cache.getQueryState(windowKey(view, "active"))?.status, "error");
		spy.mockRestore();
		const replacement = await fetchRecentWindow(
			cache,
			reader(async () => page(1000)),
			view,
			"active",
			"refresh",
			() => ({}),
		);
		assert.equal(windowItems(replacement)[0]?.conversation.conversationId, "1000");
	} finally {
		spy.mockRestore();
		cache.clear();
	}
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
		return { ...page(calls * 50, 50, null, `next-${calls}`), coverage: { ...coverage, generation: "two" } };
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
	let calls = 0;
	const client = reader(async () => {
		calls++;
		return { ...page(1000, 1, null, `cursor-${calls}`), coverage: { ...coverage, generation: String(calls) } };
	});
	const value = await fetchRecentWindow(cache, client, view, "active", "refresh", () => ({}));
	assert.equal(value.refreshPaused, "publication");
	assert.equal(vi.mocked(client.call).mock.calls.length, 4);
	await cache.refetchQueries({ queryKey: windowKey(view, "active") });
	assert.equal(vi.mocked(client.call).mock.calls.length, 4);
	assert.equal(recentWindowOptions(cache, client, view, "active", () => ({})).gcTime, 0);
	cache.clear();
});

test("hiding drops staged metadata without losing committed rows or resetting pause authority", async () => {
	const cache = new QueryClient();
	const old = snapshot([page()]);
	let calls = 0;
	const client = reader(async () => {
		calls++;
		return { ...page(1000, 1, null, `cursor-${calls}`), coverage: { ...coverage, generation: String(calls) } };
	});
	const paused = await readRecentWindow(client, view, "active", signal(), old);
	cache.setQueryData(windowKey(view, "active"), paused);
	await cache.cancelQueries({ queryKey: windowKey(view, "active") });
	discardRecentWindowStaging(cache, view, "active");
	const released = cache.getQueryData<RecentWindow>(windowKey(view, "active"));
	assert.ok(released);
	assert.equal(released.refresh, undefined);
	assert.equal(released.refreshPaused, "publication");
	assert.equal(released.pages, old.pages);
	assert.equal(await readRecentWindow(client, view, "active", signal(), released), released);
	assert.equal(vi.mocked(client.call).mock.calls.length, 4);
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
