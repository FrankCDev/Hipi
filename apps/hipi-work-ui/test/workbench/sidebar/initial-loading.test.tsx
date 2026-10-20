import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import {
	isSidebarInitialLoading,
	SidebarInitialLoading,
} from "../../../src/features/workbench/sidebar/initial-loading.tsx";

test("initial sidebar loading keeps query owners mounted under one heading and four row skeletons", () => {
	const cache = new QueryClient();
	const observer = new QueryObserver(cache, { queryKey: ["projects", "pages"], queryFn: () => new Promise(() => {}) });
	const release = observer.subscribe(() => {});
	assert.equal(isSidebarInitialLoading(cache), true);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<PreferencesProvider>
				<SidebarInitialLoading>
					<span data-query-owner="mounted">Owner</span>
				</SidebarInitialLoading>
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	assert.equal((html.match(/class="sidebar-loading-heading"/g) ?? []).length, 1);
	assert.equal((html.match(/class="sidebar-loading-row"/g) ?? []).length, 4);
	assert.match(html, /data-query-owner="mounted"/);
	assert.match(html, /class="sidebar-loaded-sections" hidden/);
	release();
	cache.clear();
});

test("loaded rows, errors and settled empty refresh never replace sections with a skeleton", () => {
	const cache = new QueryClient();
	const observer = new QueryObserver(cache, { queryKey: ["projects", "pages"], queryFn: () => new Promise(() => {}) });
	const release = observer.subscribe(() => {});
	cache.setQueryData(["sidebar-navigation", { kind: "project_recent" }, "active"], {
		pages: [{ items: [{ conversation: {} }] }],
	});
	const recent = new QueryObserver(cache, {
		queryKey: ["sidebar-navigation", { kind: "project_recent" }, "active"],
		queryFn: () => new Promise(() => {}),
	});
	const releaseRecent = recent.subscribe(() => {});
	assert.equal(isSidebarInitialLoading(cache), false);
	releaseRecent();
	cache.removeQueries({ queryKey: ["sidebar-navigation"] });
	cache.setQueryData(["projects", "pages"], { pages: [{ items: [] }] });
	assert.equal(isSidebarInitialLoading(cache), false);
	cache
		.getQueryCache()
		.find({ queryKey: ["projects", "pages"] })
		?.setState({ status: "error", error: new Error("offline") });
	assert.equal(isSidebarInitialLoading(cache), false);
	release();
	cache.clear();
});

test("inactive prior filters and active preview caches cannot suppress current initial loading", () => {
	const cache = new QueryClient();
	const inventory = new QueryObserver(cache, {
		queryKey: ["projects", "pages"],
		queryFn: () => new Promise(() => {}),
	});
	const release = inventory.subscribe(() => {});
	const oldKey = ["sidebar-navigation", { kind: "project_recent" }, "archived"];
	cache.setQueryData(oldKey, { pages: [{ items: [{ conversation: {} }] }] });
	assert.equal(isSidebarInitialLoading(cache), true, "Inactive prior filter rows are not current inventory");
	cache
		.getQueryCache()
		.find({ queryKey: oldKey })
		?.setState({ status: "error", error: new Error("old failure") });
	assert.equal(isSidebarInitialLoading(cache), true, "Inactive prior errors are not current inventory");
	const preview = new QueryObserver(cache, {
		queryKey: ["sidebar-navigation", "project-preview", "old", "all"],
		queryFn: () => new Promise(() => {}),
		initialData: { pages: [{ items: [{ conversation: {} }] }] },
	});
	const releasePreview = preview.subscribe(() => {});
	assert.equal(isSidebarInitialLoading(cache), true, "Preview data never counts as a sidebar inventory row");
	cache
		.getQueryCache()
		.find({ queryKey: ["sidebar-navigation", "project-preview"] })
		?.setState({ status: "error", error: new Error("preview failure") });
	assert.equal(isSidebarInitialLoading(cache), true, "Preview errors never replace initial inventory loading");
	releasePreview();
	release();
	cache.clear();
});

test("disabled project children do not keep a settled empty sidebar loading", () => {
	const cache = new QueryClient();
	const observer = new QueryObserver(cache, {
		queryKey: ["sidebar-navigation", { kind: "project", projectId: "closed" }],
		enabled: false,
		queryFn: async () => ({ pages: [] }),
	});
	const release = observer.subscribe(() => {});
	cache.setQueryData(["projects", "pages"], { pages: [{ items: [] }] });
	assert.equal(isSidebarInitialLoading(cache), false);
	release();
	cache.clear();
});
