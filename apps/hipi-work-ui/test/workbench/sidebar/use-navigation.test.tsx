import assert from "node:assert/strict";
import type { SidebarPage } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { navigationKey } from "../../../src/features/workbench/sidebar/navigation-query.ts";
import { useNavigation } from "../../../src/features/workbench/sidebar/use-navigation.ts";

vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => ({ call: vi.fn() }) }));

function read(page: SidebarPage, probe?: SidebarPage) {
	const cache = new QueryClient();
	cache.setQueryData(navigationKey({ kind: "recent" }, "active"), { pages: [page], cursors: [undefined] });
	if (probe) cache.setQueryData(["sidebar-navigation-probe"], probe);
	let result: ReturnType<typeof useNavigation> | undefined;
	function Probe() {
		result = useNavigation({ kind: "recent" }, "active", true);
		return null;
	}
	renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<Probe />
		</QueryClientProvider>,
	);
	cache.clear();
	assert.ok(result);
	return result;
}
const empty = (): SidebarPage => ({
	items: [],
	nextCursor: null,
	coverage: { generation: "one", membershipGeneration: 0, state: "ready", completedAt: 1, nextCursor: null },
});

test("empty is shown only for ready exhausted data, never building, refreshing or continuation pages", () => {
	assert.equal(read(empty()).isEmpty, true);
	for (const state of ["building", "refreshing"] as const) {
		const page = empty();
		page.coverage.state = state;
		assert.equal(read(page).isEmpty, false);
	}
	assert.equal(read({ ...empty(), nextCursor: "continue" }).isEmpty, false);
});

test("probe state labels retained publication refreshing until a replacement is committed", () => {
	const next = empty();
	next.coverage.generation = "two";
	const retained = read(empty(), next);
	assert.equal(retained.coverage?.state, "refreshing");
	assert.equal(retained.coverage?.generation, "one");
	assert.equal(retained.isEmpty, false);
	const refreshing = empty();
	refreshing.coverage.state = "refreshing";
	assert.equal(read(empty(), refreshing).coverage?.state, "refreshing");
});

test("canonical identities retain equal conversation IDs from different workspaces", () => {
	const page = empty();
	page.items = ["a", "b"].map((workspaceId) => ({
		conversation: {
			workspaceId,
			conversationId: "same",
			title: workspaceId,
			revision: 1,
			createdAt: 1,
			archivedAt: null,
		},
		recencyAt: null,
		activityBasis: "unknown",
	}));
	assert.deepEqual(
		read(page).items.map((item) => item.workspaceId),
		["a", "b"],
	);
});
