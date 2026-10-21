// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, Conversation, ProjectListItem, SidebarPage } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useStore } from "zustand";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { createNavigation } from "../../../src/features/workbench/navigation/state.ts";
import { useNavigationActions } from "../../../src/features/workbench/navigation/use-actions.ts";
import { SidebarInitialLoading } from "../../../src/features/workbench/sidebar/initial-loading.tsx";
import { navigationKey } from "../../../src/features/workbench/sidebar/navigation-query.ts";
import { watchNavigationSignals } from "../../../src/features/workbench/sidebar/navigation-refresh.ts";
import { SidebarPreviewProvider } from "../../../src/features/workbench/sidebar/preview-provider.tsx";
import { SidebarSelectionProvider } from "../../../src/features/workbench/sidebar/selection-provider.tsx";
import { WorkspaceTree } from "../../../src/features/workbench/sidebar/workspace-tree.tsx";

// Real React, Query and navigation owners. jsdom cannot establish painted-frame
// geometry; assertions distinguish out-of-flow feedback from retained row owners.
const projects: ProjectListItem[] = ["one", "two"].map((id) => ({
	project: { projectId: id, homeWorkspaceId: id, name: `Project ${id}`, revision: 1, createdAt: 1 },
	presentation: { projectId: id, pinned: false, revision: 0 },
}));
function conversation(id: string, title = `Chat ${id}`): Conversation {
	return { workspaceId: id, conversationId: id, title, revision: 1, createdAt: 1, archivedAt: null };
}
function page(id: string, title?: string): SidebarPage {
	return {
		items: [{ conversation: conversation(id, title), recencyAt: 1, activityBasis: "creation" }],
		nextCursor: null,
		coverage: { generation: "one", membershipGeneration: 0, state: "ready", completedAt: 1, nextCursor: null },
	};
}
let cache: QueryClient;
let client: AppClient;
let catalog: CatalogSession;
let navigation: ReturnType<typeof createNavigation>;
let root: Root;
let host: HTMLDivElement;
const pending = new Map<string, { resolve: (page: SidebarPage) => void; reject: (error: Error) => void }>();
function Fixture() {
	const state = useStore(navigation.store);
	const region = useRef<HTMLElement>(null);
	useEffect(() => watchNavigationSignals(cache), []);
	const actions = useNavigationActions({
		navigation,
		client,
		cache,
		projects,
		isConnected: () => true,
		cancelDraft: () => {},
		currentProjectId: state.projectId,
		onHome: () => {},
		onConversation: () => {},
		onSearch: () => {},
	});
	return (
		<aside ref={region}>
			<SidebarInitialLoading>
				<SidebarSelectionProvider scope={state.scope} preferredLocation={state.sidebarLocation} rootRef={region}>
					<SidebarPreviewProvider disabled={false} navigationKey={JSON.stringify(state.scope)}>
						<WorkspaceTree
							catalog={catalog}
							guard={(action) => action()}
							workspaces={[]}
							projects={projects}
							section="projects"
							logicalReady
							selectedWorkspace={state.scope.workspaceId}
							selectedConversation={state.scope.conversationId}
							selectedProjectId={state.projectId}
							isExpanded={() => true}
							onToggle={() => {}}
							onOpenProject={actions.selectProject}
							onSelect={(item, location) => actions.selectConversation(item, undefined, location)}
							onNewConversation={() => {}}
						/>
					</SidebarPreviewProvider>
				</SidebarSelectionProvider>
			</SidebarInitialLoading>
		</aside>
	);
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	pending.clear();
	cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const call = vi.fn((method: string, input: { view?: { projectId?: string } }) => {
		assert.equal(method, "listSidebarConversations");
		const id = input.view?.projectId;
		assert.ok(id);
		return new Promise<SidebarPage>((resolve, reject) => pending.set(id, { resolve, reject }));
	});
	client = { call: call as AppClient["call"], observe: vi.fn() };
	const local = new LocalState();
	navigation = createNavigation(local);
	catalog = new CatalogSession(client, local);
	for (const { project } of projects)
		cache.setQueryData(navigationKey({ kind: "project", projectId: project.projectId }, "active"), {
			pages: [page(project.projectId)],
			cursors: [undefined],
		});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<AppClientProvider client={client}>
				<QueryClientProvider client={cache}>
					<PreferencesProvider>
						<Fixture />
					</PreferencesProvider>
				</QueryClientProvider>
			</AppClientProvider>,
		),
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	cache.clear();
	catalog.dispose();
	host.remove();
	localStorage.clear();
	vi.unstubAllGlobals();
});
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function click(selector: string) {
	const element = host.querySelector<HTMLButtonElement>(selector);
	assert.ok(element);
	await act(async () => element.click());
	await flush();
}
function feedback() {
	return [
		...host.querySelectorAll<HTMLElement>(
			".project-conversations > [data-disclosure-motion] > [data-disclosure-content] > output",
		),
	];
}

test("project and chat switching retains rows while background publication cannot insert layout feedback", async () => {
	const rows = [...host.querySelectorAll(".conversation-link")];
	const lists = [...host.querySelectorAll(".conversation-list")];
	assert.equal(rows.length, 2);
	for (const id of ["one", "two", "one"]) {
		await click(`[data-project-id='${id}'] .project-open`);
		await click(`[data-project-id='${id}'] .conversation-link`);
		assert.equal(pending.size, 2, "Selection still refreshes all active publication owners");
		assert.equal(feedback().length, 2);
		assert.ok(
			feedback().every((element) => element.classList.contains("sr-only")),
			"Background refresh status must not enter list layout",
		);
		assert.ok(
			feedback().every((element) => element.getAttribute("aria-live") === "off"),
			"Repeated selection must not announce routine refreshes",
		);
		assert.equal(host.querySelector(".sidebar-loaded-sections")?.hasAttribute("hidden"), false);
		assert.deepEqual([...host.querySelectorAll(".conversation-link")], rows);
		assert.deepEqual([...host.querySelectorAll(".conversation-list")], lists);
		await act(async () => {
			for (const [projectId, request] of pending) request.resolve(page(projectId, `Updated ${projectId}`));
			pending.clear();
		});
		await flush();
		assert.equal(feedback().length, 0);
		assert.deepEqual([...host.querySelectorAll(".conversation-link")], rows);
		assert.match(host.textContent ?? "", /Updated one/);
	}
});

test("an uncached initial query still exposes loading instead of a false empty state", async () => {
	await act(async () => {
		void cache.resetQueries({ queryKey: ["sidebar-navigation"] });
	});
	await flush();
	assert.ok(host.querySelector(".sidebar-initial-loading"));
	assert.equal(feedback().length, 2);
	assert.ok(feedback().every((element) => element.classList.contains("nav-feedback")));
	assert.equal(host.querySelectorAll(".nav-empty-state").length, 0);
});

test("a failed background refresh retains rows and exposes its actual error and retry", async () => {
	const row = host.querySelector(".conversation-link");
	await click("[data-project-id='one'] .conversation-link");
	await act(async () => {
		for (const request of pending.values()) request.reject(new Error("offline"));
		pending.clear();
	});
	await flush();
	assert.equal(host.querySelector(".conversation-link"), row);
	assert.equal(
		host.querySelectorAll(
			".project-conversations > [data-disclosure-motion] > [data-disclosure-content] > [role='alert']",
		).length,
		2,
	);
	assert.ok([...host.querySelectorAll("[role='alert']")].every((element) => !element.classList.contains("sr-only")));
	assert.match(host.textContent ?? "", /刷新列表/);
});
