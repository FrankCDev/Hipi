import assert from "node:assert/strict";
import type { Conversation } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { navigationKey } from "../../../src/features/workbench/sidebar/navigation-query.ts";
import { SidebarPreviewProvider } from "../../../src/features/workbench/sidebar/preview-provider.tsx";
import { visibleSidebarProjects } from "../../../src/features/workbench/sidebar/project-visibility.ts";
import { SidebarSelectionProvider } from "../../../src/features/workbench/sidebar/selection-provider.tsx";
import { WorkspaceTree } from "../../../src/features/workbench/sidebar/workspace-tree.tsx";
import { Workbench } from "../../../src/features/workbench/workbench.tsx";

const local = new LocalState();

test("project presentation caps at five, preserves an eligible active row and avoids hiding one last item", () => {
	const ids = Array.from({ length: 8 }, (_, index) => `project-${index}`);
	const penultimate = ids[6];
	const last = ids[7];
	assert.ok(penultimate);
	assert.ok(last);
	assert.deepEqual(visibleSidebarProjects(ids.slice(0, 5), false, "", false), ids.slice(0, 5));
	assert.deepEqual(visibleSidebarProjects(ids.slice(0, 6), false, "", false), ids.slice(0, 6));
	assert.deepEqual(visibleSidebarProjects(ids.slice(0, 6), false, "", true), ids.slice(0, 5));
	assert.deepEqual(visibleSidebarProjects(ids, false, last, false), [...ids.slice(0, 5), last]);
	assert.deepEqual(visibleSidebarProjects(ids.slice(0, 7), false, penultimate, false), ids.slice(0, 7));
	assert.deepEqual(visibleSidebarProjects(ids.slice(0, 7), false, penultimate, true), [
		...ids.slice(0, 5),
		penultimate,
	]);
	assert.deepEqual(visibleSidebarProjects(ids, true, "", true), ids);
	assert.deepEqual(visibleSidebarProjects(ids, false, "unloaded-project", false), ids.slice(0, 5));
	assert.equal(ids.length, 8, "Presentation never prunes the loaded canonical data");
});
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call: vi.fn() }),
	useLocalState: () => local,
	useFiles: () => ({}),
	useCredentialClient: () => undefined,
}));
vi.mock("../../../src/features/workbench/conversation/pane.tsx", () => ({
	ConversationPane: ({ conversation }: { conversation: Conversation }) => (
		<section data-selected-conversation={conversation.conversationId}>{conversation.title}</section>
	),
}));
vi.mock("../../../src/features/files/pdf-preview.tsx", () => ({
	PdfPreview: () => {
		throw new Error("This sidebar SSR fixture must not render the browser PDF adapter");
	},
}));

function renderTree(
	expanded: boolean,
	count = 1,
	nextCursor: string | null = "next-page",
	selectedConversation = "conversation-id",
	defaultWorkspaceId?: string,
	section: "projects" | "recent" | "all" = "projects",
) {
	const navigationRoot = createRef<HTMLElement>();
	const cache = new QueryClient();
	const window = {
		pages: [
			{
				items: [
					{
						conversation: {
							workspaceId: "workspace-id",
							conversationId: "conversation-id",
							title: "My conversation",
							revision: 1,
							createdAt: 1,
							archivedAt: null,
						},
						recencyAt: 1,
						activityBasis: "creation",
					},
				],
				nextCursor,
				coverage: { generation: "one", membershipGeneration: 0, state: "ready", completedAt: 1, nextCursor: null },
			},
		],
		cursors: [undefined],
	};
	cache.setQueryData(navigationKey({ kind: "workspace", workspaceId: "workspace-id" }, "active"), window);
	cache.setQueryData(navigationKey({ kind: "recent" }, "active"), window);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<PreferencesProvider>
				<aside ref={navigationRoot}>
					<SidebarSelectionProvider
						scope={{ workspaceId: "workspace-id", conversationId: selectedConversation }}
						preferredLocation={null}
						rootRef={navigationRoot}
					>
						<SidebarPreviewProvider disabled={false} navigationKey="tree-fixture">
							<WorkspaceTree
								section={section === "all" ? undefined : section}
								catalog={new CatalogSession({ call: vi.fn(), observe: vi.fn() }, new LocalState())}
								guard={(action) => action()}
								workspaces={Array.from({ length: count }, (_, index) => ({
									workspaceId: index === 0 ? "workspace-id" : `workspace-${index}`,
									name: `My project ${index}`,
								}))}
								selectedWorkspace="workspace-id"
								defaultWorkspaceId={defaultWorkspaceId}
								selectedConversation={selectedConversation}
								isExpanded={() => expanded}
								onToggle={() => {}}
								onOpenProject={() => {}}
								onSelect={() => {}}
								onNewConversation={() => {}}
							/>
						</SidebarPreviewProvider>
					</SidebarSelectionProvider>
				</aside>
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	cache.clear();
	return html;
}

test("current conversation and its containing project retain distinct SSR surfaces without premature alias selection", () => {
	const html = renderTree(true);
	assert.match(
		html,
		/class="sidebar-preview-row project-row" data-selected="false" data-current="false" data-contains-current="true"/,
	);
	assert.match(html, /class="sidebar-preview-row conversation-preview-row" data-selected="false"/);
	assert.match(
		html,
		/data-workspace-id="workspace-id" data-conversation-id="conversation-id" data-sidebar-location="workspace" data-sidebar-location-workspace="workspace-id"/,
	);
	assert.doesNotMatch(html, /aria-current=/);
	assert.match(html, /class="project-toggle" aria-expanded="true"/);
	const open = html.match(/<button\b[^>]*class="project-open"[^>]*>/)?.[0];
	assert.ok(open);
	assert.match(open, /aria-labelledby="[^"]+"/);
	assert.match(open, /title="打开项目"/);
	assert.match(open, /data-sidebar-cycle-item=""/);
	assert.match(html, />收起项目<\/span>/);
	assert.match(html, />打开项目<\/span>/);
	assert.match(html, /aria-label="新聊天: My project 0"/);
	assert.match(html, /aria-label="会话操作: My conversation"/);
	assert.match(html, /aria-haspopup="menu"/);
	assert.equal(
		(html.match(/lucide-ellipsis/g) ?? []).length,
		2,
		"one management menu per workspace and one menu per conversation",
	);
	assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
});

test("project overview alone marks the project as current", () => {
	const html = renderTree(true, 1, null, "");
	assert.match(
		html,
		/class="sidebar-preview-row project-row" data-selected="true" data-current="true" data-contains-current="false"/,
	);
	const open = html.match(/<button\b[^>]*class="project-open"[^>]*>/)?.[0];
	assert.ok(open);
	assert.match(open, /aria-current="page"/);
	assert.match(open, /data-sidebar-cycle-item=""/);
	assert.match(html, /class="sidebar-preview-row conversation-preview-row" data-selected="false"/);
	assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test("collapsed projects retain their row preview entry and expansion semantics", () => {
	const html = renderTree(false);
	assert.match(html, /class="project-toggle" aria-expanded="false"/);
	assert.match(html, />展开项目<\/span>/);
	assert.match(html, /class="project-open"/);
	assert.match(html, /hidden="" class="project-conversations"/);
	assert.equal((html.match(/lucide-ellipsis/g) ?? []).length, 1);
	assert.doesNotMatch(html, /conversation-preview-row/);
});

test("project disclosure and navigation have distinct names and only disclosure controls expansion", () => {
	const html = renderTree(true);
	const disclosure = html.match(/<button\b[^>]*class="project-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
	const open = html.match(/<button\b[^>]*class="project-open"[^>]*>[\s\S]*?<\/button>/)?.[0];
	assert.ok(disclosure);
	assert.ok(open);
	const disclosureLabels = disclosure.match(/aria-labelledby="([^"]+)"/)?.[1]?.split(" ");
	const openLabels = open.match(/aria-labelledby="([^"]+)"/)?.[1]?.split(" ");
	assert.equal(disclosureLabels?.length, 2);
	assert.equal(openLabels?.length, 2);
	assert.notEqual(disclosureLabels?.[0], openLabels?.[0]);
	assert.equal(disclosureLabels?.[1], openLabels?.[1], "Both actions identify the same visible project title");
	assert.ok(open.includes(`id="${openLabels?.[1]}" class="project-name sidebar-title"`));
	assert.match(open, /class="sidebar-title-content">My project 0<\/span>/);
	assert.match(disclosure, /收起项目/);
	assert.match(open, /打开项目/);
	assert.match(disclosure, /class="project-icon" aria-hidden="true"/);
	assert.match(disclosure, /class="project-chevron" data-expanded="true" aria-hidden="true"/);
	assert.doesNotMatch(disclosure, /project-name|project-page-count/);
	assert.doesNotMatch(open, /aria-expanded|aria-controls|project-chevron|project-icon/);
	const region = disclosure.match(/aria-controls="([^"]+)"/)?.[1];
	assert.ok(region);
	assert.ok(html.includes(`<section id="${region}" aria-labelledby="${openLabels?.[1]}"`));
});

test("a catalog page is rendered without the old lifetime slice and pagination remains explicit", () => {
	const html = renderTree(false, 20);
	assert.equal((html.match(/class="workspace-branch"/g) ?? []).length, 20);
	assert.match(html, /My project 19/);
	const expanded = renderTree(true);
	assert.match(expanded, /加载更多/);
	assert.match(expanded, /项目操作: My project 0/);
	assert.match(expanded, /会话操作: My conversation/);
	assert.doesNotMatch(expanded, /重命名会话/);
	assert.doesNotMatch(expanded, />归档会话</);
});

test("single-page conversation lists omit inert pagination without hiding their actions", () => {
	const html = renderTree(true, 1, null);
	assert.doesNotMatch(html, /第一页|加载更多/);
	assert.match(html, /会话操作: My conversation/);
});

test("healthy project lists contain no persistent filter bar, counts or creation dialog", () => {
	const html = renderTree(true);
	assert.doesNotMatch(
		html,
		/conversation-filter-tabs|project-list-toolbar|project-page-summary|project-match-count|project-page-count|role="dialog"/,
	);
	assert.match(html, /project-actions-trigger/);
	assert.match(html, /project-new-conversation/);
	assert.match(html, /class="project-pagination"/);
});

test("the sidebar remains an unfiltered bounded list independently of the search dialog", () => {
	const html = renderTree(true, 1, "next-page");
	assert.doesNotMatch(html, /project-page-summary|project-match-count|project-page-count/);
	assert.match(html, /class="conversation-link"/);
	assert.match(html, /加载更多/);
});

test("Recent is global and remains available independently of default workspace and project catalog windows", () => {
	const known = renderTree(false, 1, null, "conversation-id", "workspace-id", "all");
	assert.match(known, /recent-conversations-heading/);
	assert.match(known, />最近<\/h3>/);
	assert.match(known, /class="conversation-link"/);
	assert.match(
		known,
		/data-workspace-id="workspace-id" data-conversation-id="conversation-id" data-sidebar-location="recent"/,
	);
	assert.doesNotMatch(known, /aria-current=|data-sidebar-location-workspace=/);
	assert.doesNotMatch(known, /project-row|project-toggle|project-open|project-new-conversation|My project 0/);
	const outsideWindow = renderTree(false, 1, null, "conversation-id", "verified-default", "all");
	assert.match(outsideWindow, /My project 0/);
	assert.match(outsideWindow, /recent-conversations-heading/);
	assert.equal((outsideWindow.match(/class="project-toggle"/g) ?? []).length, 1);
	const noDefault = renderTree(true, 1, null, "conversation-id", undefined, "all");
	assert.match(noDefault, /data-sidebar-location="recent"/);
	assert.match(noDefault, /data-sidebar-location="workspace"/);
	assert.equal((noDefault.match(/data-conversation-id="conversation-id"/g) ?? []).length, 2);
});

test("selected conversation remains mounted when it is outside the displayed directory page", () => {
	local.write("workspace", "selected-workspace");
	local.write("conversation", "selected-conversation");
	local.write("draft.selected-workspace.selected-conversation", "keep this draft");
	const cache = new QueryClient();
	cache.setQueryData(["project-catalog"], { state: "ready", generation: 1, defaultWorkspaceId: null });
	cache.setQueryData(["projects", "pages"], {
		pages: [
			{
				items: [
					{
						project: {
							projectId: "other-project",
							homeWorkspaceId: "other-workspace",
							name: "Other project",
							revision: 1,
						},
						presentation: { projectId: "other-project", pinned: false, revision: 0 },
					},
				],
				metadataGeneration: 1,
				orderGeneration: 0,
				nextCursor: "next",
			},
		],
		pageParams: [undefined],
	});
	cache.setQueryData(["workspaces", "pages"], {
		pages: [{ items: [{ workspaceId: "other-workspace", name: "Other project" }], nextCursor: "next" }],
		pageParams: [undefined],
	});
	cache.setQueryData(["workspace", "selected-workspace"], {
		workspaceId: "selected-workspace",
		name: "Selected project",
	});
	cache.setQueryData(["conversation", "selected-workspace", "selected-conversation"], {
		workspaceId: "selected-workspace",
		conversationId: "selected-conversation",
		title: "Selected outside this page",
		revision: 3,
		createdAt: 1,
		archivedAt: null,
	});
	const render = () =>
		renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					<Workbench disconnect={() => {}} />
				</PreferencesProvider>
			</QueryClientProvider>,
		);
	assert.match(render(), /data-selected-conversation="selected-conversation"/);
	assert.match(render(), /加载更多/);
	cache.setQueryData(["workspaces", "pages"], { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });
	cache.setQueryData(["projects", "pages"], {
		pages: [{ items: [], metadataGeneration: 1, orderGeneration: 0, nextCursor: null }],
		pageParams: [undefined],
	});
	const empty = render();
	assert.match(empty, /data-selected-conversation="selected-conversation"/);
	assert.doesNotMatch(empty, /第一页|加载更多/);
	assert.match(empty, /aria-label="新建项目"/);
	assert.match(empty, /aria-label="工作台设置"/);
	assert.match(empty, /aria-label="搜索聊天"/);
	assert.equal(local.read("draft.selected-workspace.selected-conversation"), "keep this draft");
	cache.clear();
});
