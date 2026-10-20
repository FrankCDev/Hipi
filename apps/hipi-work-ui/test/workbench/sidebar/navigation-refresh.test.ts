import assert from "node:assert/strict";
import { AppError, type SidebarPage } from "@hipi/work-runtime/contracts";
import type * as Query from "@tanstack/react-query";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type * as React from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { navigationKey, navigationOptions } from "../../../src/features/workbench/sidebar/navigation-query.ts";
import { useNavigationRefresh } from "../../../src/features/workbench/sidebar/navigation-refresh.ts";

type Cell = { value?: unknown; deps?: React.DependencyList; cleanup?: () => void };
type ProbeOptions = {
	enabled: boolean;
	refetchInterval: (query: { state: { error: Error | null } }) => number | false;
};
const fixture = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	effects: [] as (() => void)[],
	cache: undefined as QueryClient | undefined,
	options: undefined as ProbeOptions | undefined,
	data: undefined as SidebarPage | undefined,
	updatedAt: 1,
}));

// A bounded hook adapter commits the production owner effects using a real Query
// cache. It verifies lifecycle/configuration, not browser timers or React scheduling.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useState: <T>(initial: () => T) => {
			const index = fixture.cursor++;
			fixture.cells[index] ??= { value: initial() };
			const cell = fixture.cells[index];
			return [
				cell.value,
				(value: T) => {
					cell.value = value;
				},
			];
		},
		useEffect: (setup: React.EffectCallback, deps: React.DependencyList) => {
			const index = fixture.cursor++;
			const old = fixture.cells[index];
			if (old?.deps && deps.every((value, offset) => Object.is(value, old.deps?.[offset]))) return;
			fixture.effects.push(() => {
				old?.cleanup?.();
				const cleanup = setup();
				fixture.cells[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
			});
		},
	};
});
vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<typeof Query>("@tanstack/react-query");
	return {
		...actual,
		useQueryClient: () => fixture.cache,
		useQuery: (options: ProbeOptions) => {
			fixture.options = options;
			return { data: fixture.data, dataUpdatedAt: fixture.updatedAt };
		},
	};
});
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => ({ call: vi.fn() }) }));

const page = (generation: string): SidebarPage => ({
	items: [],
	nextCursor: null,
	coverage: { generation, membershipGeneration: 0, state: "ready", completedAt: 1, nextCursor: null },
});
class VisibleDocument extends EventTarget {
	visibilityState = "visible";
}
let document: VisibleDocument;
const cleanups: (() => void)[] = [];
const render = (visible: boolean) => {
	fixture.cursor = 0;
	useNavigationRefresh(visible);
	for (const effect of fixture.effects.splice(0)) effect();
	assert.ok(fixture.options);
	return fixture.options;
};
beforeEach(() => {
	fixture.cells = [];
	fixture.effects = [];
	fixture.data = undefined;
	fixture.updatedAt = 1;
	fixture.cache = new QueryClient();
	document = new VisibleDocument();
	vi.stubGlobal("document", document);
});
afterEach(() => {
	for (const cell of fixture.cells) cell.cleanup?.();
	for (const cleanup of cleanups.splice(0)) cleanup();
	fixture.cache?.clear();
	vi.unstubAllGlobals();
});

test("one probe pauses for hidden document/sidebar, backs off errors and cancels on owner teardown", async () => {
	const cache = fixture.cache;
	assert.ok(cache);
	let options = render(true);
	assert.equal(options.enabled, true);
	assert.equal(options.refetchInterval({ state: { error: null } }), 2000);
	assert.equal(options.refetchInterval({ state: { error: new Error("offline") } }), 10000);
	assert.equal(options.refetchInterval({ state: { error: new AppError("STORE_MISMATCH") } }), false);
	let signal: AbortSignal | undefined;
	const pending = cache
		.fetchQuery({
			queryKey: ["sidebar-navigation-probe"],
			queryFn: ({ signal: current }) => {
				signal = current;
				return new Promise<SidebarPage>(() => {});
			},
		})
		.catch(() => undefined);
	document.visibilityState = "hidden";
	document.dispatchEvent(new Event("visibilitychange"));
	options = render(true);
	assert.equal(options.enabled, false);
	assert.equal(options.refetchInterval({ state: { error: null } }), false);
	assert.equal(signal?.aborted, true);
	await pending;
	document.visibilityState = "visible";
	document.dispatchEvent(new Event("visibilitychange"));
	assert.equal(render(false).enabled, false);
	assert.equal(render(true).enabled, true);
	const next = cache
		.fetchQuery({
			queryKey: ["sidebar-navigation-probe"],
			queryFn: ({ signal: current }) => {
				signal = current;
				return new Promise<SidebarPage>(() => {});
			},
		})
		.catch(() => undefined);
	for (const cell of fixture.cells) {
		cell.cleanup?.();
		cell.cleanup = undefined;
	}
	assert.equal(signal?.aborted, true);
	await next;
});

test("stale cached probe data cannot refresh branches while hidden; becoming visible reconciles once", async () => {
	const cache = fixture.cache;
	assert.ok(cache);
	const call = vi.fn(async () => page("new"));
	const client = { call: call as Parameters<typeof navigationOptions>[1]["call"], observe: vi.fn() };
	cache.setQueryData(navigationKey({ kind: "recent" }, "active"), { pages: [page("old")], cursors: [undefined] });
	const observer = new QueryObserver(cache, {
		...navigationOptions(cache, client, { kind: "recent" }, "active"),
		staleTime: Infinity,
	});
	cleanups.push(observer.subscribe(() => {}));
	fixture.data = page("new");
	render(false);
	assert.equal(call.mock.calls.length, 0);
	render(true);
	await observer.refetch({ cancelRefetch: false });
	assert.equal(call.mock.calls.length, 1);
	fixture.updatedAt++;
	render(true);
	assert.equal(call.mock.calls.length, 1);
});
