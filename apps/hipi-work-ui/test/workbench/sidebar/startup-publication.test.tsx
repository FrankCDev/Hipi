import assert from "node:assert/strict";
import type { AppClient, SidebarCoverage, SidebarPage, SidebarView } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import {
	type NavigationWindow,
	navigationKey,
	navigationOptions,
} from "../../../src/features/workbench/sidebar/navigation-query.ts";
import { reconcileNavigationPublication } from "../../../src/features/workbench/sidebar/navigation-refresh.ts";
import { useNavigation } from "../../../src/features/workbench/sidebar/use-navigation.ts";

const fixture = vi.hoisted(() => ({ client: undefined as AppClient | undefined }));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => fixture.client }));

function page(state: SidebarCoverage["state"], populated = false): SidebarPage {
	return {
		items: populated
			? [
					{
						conversation: {
							workspaceId: "source",
							conversationId: "alias",
							title: "Shared project and Recent conversation",
							revision: 1,
							createdAt: 1,
							archivedAt: null,
						},
						recencyAt: 1,
						activityBasis: "creation",
					},
				]
			: [],
		nextCursor: null,
		// The runtime publishes the building cycle's generation unchanged.
		coverage: {
			generation: "startup-cycle",
			membershipGeneration: 0,
			state,
			completedAt: state === "building" ? null : 1,
			nextCursor: state === "ready" ? null : "refresh",
		},
	};
}
function read(cache: QueryClient, view: SidebarView) {
	let result: ReturnType<typeof useNavigation> | undefined;
	function Probe() {
		result = useNavigation(view, "active", true);
		return null;
	}
	renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<Probe />
		</QueryClientProvider>,
	);
	assert.ok(result);
	return result;
}

for (const view of [
	{ kind: "recent" },
	{ kind: "project_recent" },
	{ kind: "project", projectId: "project-a" },
] as const) {
	test(`${view.kind}: same-generation publication replaces the initial building page exactly once`, async () => {
		const cache = new QueryClient();
		const key = navigationKey(view, "active");
		const building = page("building");
		cache.setQueryData(key, { pages: [building], cursors: [undefined] });
		let release: ((value: SidebarPage) => void) | undefined;
		const call = vi.fn(
			() =>
				new Promise<SidebarPage>((resolve) => {
					release = resolve;
				}),
		);
		const client = { call: call as AppClient["call"], observe: vi.fn() };
		fixture.client = client;
		const observer = new QueryObserver(cache, {
			...navigationOptions(cache, client, view, "active"),
			staleTime: Infinity,
		});
		const unsubscribe = observer.subscribe(() => {});
		try {
			const ready = page("ready", true);
			cache.setQueryData(
				view.kind === "recent" ? ["sidebar-navigation-probe"] : ["sidebar-navigation-probe", "logical"],
				ready,
			);
			const pending = reconcileNavigationPublication(cache, ready.coverage);
			assert.equal(
				call.mock.calls.length,
				1,
				"a published probe must refetch an unpublished first page even when generation matches",
			);
			assert.equal(read(cache, view).isEmpty, false, "probe readiness is not proof that cached rows were read");
			assert.notEqual(read(cache, view).coverage?.state, "ready");
			assert.ok(release);
			release(ready);
			await pending;
			assert.equal(read(cache, view).items[0]?.conversationId, "alias");
			assert.equal(read(cache, view).coverage?.state, "ready");
			await reconcileNavigationPublication(cache, ready.coverage);
			assert.equal(call.mock.calls.length, 1, "a coherent published window must not refetch on every probe");
		} finally {
			unsubscribe();
			cache.clear();
		}
	});
}

test("ready probe cannot declare an unread building page empty", () => {
	const cache = new QueryClient();
	try {
		cache.setQueryData(navigationKey({ kind: "recent" }, "active"), {
			pages: [page("building")],
			cursors: [undefined],
		});
		cache.setQueryData(["sidebar-navigation-probe"], page("ready", true));
		assert.equal(read(cache, { kind: "recent" }).isEmpty, false);
		assert.notEqual(read(cache, { kind: "recent" }).coverage?.state, "ready");
	} finally {
		cache.clear();
	}
});

test("retained published content remains visible while a replacement builds, then reconciles once", async () => {
	const cache = new QueryClient();
	const view = { kind: "recent" } as const;
	const retained = page("refreshing", true);
	cache.setQueryData(navigationKey(view, "active"), {
		pages: [retained],
		cursors: [undefined],
		rebuilding: true,
	} satisfies NavigationWindow);
	const call = vi.fn(async () => page("ready", true));
	fixture.client = { call: call as AppClient["call"], observe: vi.fn() };
	const observer = new QueryObserver(cache, {
		...navigationOptions(cache, fixture.client, view, "active"),
		staleTime: Infinity,
	});
	const unsubscribe = observer.subscribe(() => {});
	try {
		await reconcileNavigationPublication(cache, page("building").coverage);
		assert.equal(call.mock.calls.length, 0);
		assert.equal(read(cache, view).items[0]?.conversationId, "alias");
		assert.equal(read(cache, view).coverage?.state, "refreshing");
		await reconcileNavigationPublication(cache, page("ready").coverage);
		assert.equal(call.mock.calls.length, 1);
		assert.equal(read(cache, view).coverage?.state, "ready");
		await reconcileNavigationPublication(cache, page("ready").coverage);
		assert.equal(call.mock.calls.length, 1);
	} finally {
		unsubscribe();
		cache.clear();
	}
});
