import assert from "node:assert/strict";
import type { Conversation } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { Workbench } from "../src/features/workbench/workbench.tsx";
import { WorkspaceTree } from "../src/features/workbench/workspace-tree.tsx";

const local = new LocalState();
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call: vi.fn() }),
	useLocalState: () => local,
	useFiles: () => ({}),
	useCredentialClient: () => undefined,
}));
vi.mock("../src/features/workbench/conversation-pane.tsx", () => ({
	ConversationPane: ({ conversation }: { conversation: Conversation }) => (
		<section data-selected-conversation={conversation.conversationId}>{conversation.title}</section>
	),
}));

function renderTree(
	expanded: boolean,
	count = 1,
	nextCursor: string | null = "next-page",
	search = "",
	selectedConversation = "conversation-id",
) {
	const cache = new QueryClient();
	cache.setQueryData(["conversations", "workspace-id", "active", "pages"], {
		pages: [
			{
				items: [
					{
						workspaceId: "workspace-id",
						conversationId: "conversation-id",
						title: "My conversation",
						revision: 1,
						createdAt: 1,
						archivedAt: null,
					},
				],
				nextCursor,
			},
		],
		pageParams: [undefined],
	});
	const html = renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<PreferencesProvider>
				<WorkspaceTree
					catalog={new CatalogSession({ call: vi.fn(), observe: vi.fn() }, new LocalState())}
					guard={(action) => action()}
					workspaces={Array.from({ length: count }, (_, index) => ({
						workspaceId: index === 0 ? "workspace-id" : `workspace-${index}`,
						name: `My project ${index}`,
					}))}
					selectedWorkspace="workspace-id"
					selectedConversation={selectedConversation}
					search={search}
					isExpanded={() => expanded}
					onToggle={() => {}}
					onOpenProject={() => {}}
					onSelect={() => {}}
					onDetails={() => {}}
					onCreate={async () => {}}
				/>
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	cache.clear();
	return html;
}

test("current conversation and its containing project have distinct surfaces without nested action buttons", () => {
	const html = renderTree(true);
	assert.match(
		html,
		/class="sidebar-preview-row project-row" data-selected="false" data-current="false" data-contains-current="true"/,
	);
	assert.match(html, /class="sidebar-preview-row conversation-preview-row" data-selected="true"/);
	assert.match(html, /class="project-toggle" aria-expanded="true"/);
	assert.match(html, /class="project-open" aria-labelledby="[^"]+" title="打开项目"/);
	assert.match(html, />收起项目<\/span>/);
	assert.match(html, />打开项目<\/span>/);
	assert.match(html, /aria-label="新建会话"/);
	assert.match(html, /aria-label="会话操作: My conversation"/);
	assert.match(html, /aria-haspopup="menu"/);
	assert.equal(
		(html.match(/lucide-ellipsis/g) ?? []).length,
		2,
		"one preview action per workspace and one menu per conversation",
	);
	assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
});

test("project overview alone marks the project as current", () => {
	const html = renderTree(true, 1, null, "", "");
	assert.match(
		html,
		/class="sidebar-preview-row project-row" data-selected="true" data-current="true" data-contains-current="false"/,
	);
	assert.match(html, /class="project-open" aria-current="page"/);
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
	const disclosureLabels = disclosure.match(/aria-labelledby="([^"]+)"/)?.[1].split(" ");
	const openLabels = open.match(/aria-labelledby="([^"]+)"/)?.[1].split(" ");
	assert.equal(disclosureLabels?.length, 2);
	assert.equal(openLabels?.length, 2);
	assert.notEqual(disclosureLabels?.[0], openLabels?.[0]);
	assert.equal(disclosureLabels?.[1], openLabels?.[1], "Both actions identify the same visible project title");
	assert.ok(open.includes(`id="${openLabels?.[1]}" class="project-name">My project 0</span>`));
	assert.match(disclosure, /收起项目/);
	assert.match(open, /打开项目/);
	assert.doesNotMatch(disclosure, /project-icon|project-name|project-page-count/);
	assert.doesNotMatch(open, /aria-expanded|aria-controls|project-chevron/);
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
	assert.match(expanded, /已归档会话|会话列表/);
	assert.match(expanded, /会话操作: My conversation/);
	assert.doesNotMatch(expanded, /重命名会话/);
	assert.doesNotMatch(expanded, />归档会话</);
});

test("single-page conversation lists omit inert pagination without hiding their actions", () => {
	const html = renderTree(true, 1, null);
	assert.doesNotMatch(html, /第一页|加载更多/);
	assert.match(html, /会话操作: My conversation/);
});

test("project filters are native radio groups and counts explicitly describe the visible loaded items", () => {
	const html = renderTree(true);
	assert.match(html, /<fieldset class="conversation-filter-tabs"><legend class="sr-only">会话列表<\/legend>/);
	assert.match(html, /type="radio"[^>]*aria-label="当前会话"[^>]*checked=""/);
	assert.match(html, /type="radio"[^>]*aria-label="已归档会话"/);
	const names = [...html.matchAll(/type="radio"[^>]*name="([^"]+)"/g)].map((match) => match[1]);
	assert.equal(names.length, 2);
	assert.equal(names[0], names[1]);
	assert.doesNotMatch(html, /project-page-summary|project-match-count/);
	assert.match(html, /class="subtle-count project-page-count"><span class="sr-only">已加载并显示: <\/span>1<\/span>/);
	assert.match(html, /class="project-pagination"/);
});

test("search counts visible matches without replacing the loaded count or injecting the current conversation", () => {
	const html = renderTree(true, 1, "next-page", "not on this page");
	assert.match(
		html,
		/<button[^>]*class="[^"]*project-match-count[^>]*"[^>]*aria-label="已显示条目中的匹配: 0"[^>]*>0<\/button>/,
	);
	assert.doesNotMatch(html, /project-page-summary/);
	assert.match(html, /class="subtle-count project-page-count"><span class="sr-only">已加载并显示: <\/span>1<\/span>/);
	assert.match(html, /没有匹配的会话/);
	assert.doesNotMatch(html, /class="conversation-link"/);
	assert.match(html, /加载更多/);
});

test("selected conversation remains mounted when it is outside the displayed directory page", () => {
	local.write("workspace", "selected-workspace");
	local.write("conversation", "selected-conversation");
	local.write("draft.selected-workspace.selected-conversation", "keep this draft");
	const cache = new QueryClient();
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
	const empty = render();
	assert.match(empty, /data-selected-conversation="selected-conversation"/);
	assert.doesNotMatch(empty, /第一页|加载更多/);
	assert.match(empty, /aria-label="新建工作区"/);
	assert.match(empty, /aria-label="工作台设置"/);
	assert.match(empty, /<p class="sr-only"[^>]*>仅搜索已展开项目中已加载并显示的会话，不代表全部历史。<\/p>/);
	assert.match(empty, /aria-label="搜索范围"/);
	assert.equal(local.read("draft.selected-workspace.selected-conversation"), "keep this draft");
	cache.clear();
});
