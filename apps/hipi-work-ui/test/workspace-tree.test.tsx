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

function renderTree(expanded: boolean, count = 1, nextCursor: string | null = "next-page", search = "") {
	const cache = new QueryClient();
	cache.setQueryData(["conversations", "workspace-id", "active", undefined], {
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
					selectedConversation="conversation-id"
					search={search}
					isExpanded={() => expanded}
					onToggle={() => {}}
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

test("project and conversation share a selected row surface without nested action buttons", () => {
	const html = renderTree(true);
	assert.match(html, /class="sidebar-preview-row project-row" data-selected="true"/);
	assert.match(html, /class="sidebar-preview-row conversation-preview-row" data-selected="true"/);
	assert.match(html, /class="project-toggle" aria-expanded="true"/);
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

test("collapsed projects retain their row preview entry and expansion semantics", () => {
	const html = renderTree(false);
	assert.match(html, /class="project-toggle" aria-expanded="false"/);
	assert.match(html, /hidden="" class="project-conversations"/);
	assert.equal((html.match(/lucide-ellipsis/g) ?? []).length, 1);
	assert.doesNotMatch(html, /conversation-preview-row/);
});

test("a catalog page is rendered without the old lifetime slice and pagination remains explicit", () => {
	const html = renderTree(false, 20);
	assert.equal((html.match(/class="workspace-branch"/g) ?? []).length, 20);
	assert.match(html, /My project 19/);
	const expanded = renderTree(true);
	assert.match(expanded, /下一页/);
	assert.match(expanded, /已归档会话|会话列表/);
	assert.match(expanded, /会话操作: My conversation/);
	assert.doesNotMatch(expanded, /重命名会话/);
	assert.doesNotMatch(expanded, />归档会话</);
});

test("single-page conversation lists omit inert pagination without hiding their actions", () => {
	const html = renderTree(true, 1, null);
	assert.doesNotMatch(html, /第一页|下一页/);
	assert.match(html, /会话操作: My conversation/);
});

test("project filters are native radio groups and counts explicitly describe the displayed page", () => {
	const html = renderTree(true);
	assert.match(html, /<fieldset class="conversation-filter-tabs"><legend class="sr-only">会话列表<\/legend>/);
	assert.match(html, /type="radio"[^>]*aria-label="当前会话"[^>]*checked=""/);
	assert.match(html, /type="radio"[^>]*aria-label="已归档会话"/);
	const names = [...html.matchAll(/type="radio"[^>]*name="([^"]+)"/g)].map((match) => match[1]);
	assert.equal(names.length, 2);
	assert.equal(names[0], names[1]);
	assert.doesNotMatch(html, /project-page-summary|project-match-count/);
	assert.match(html, /class="subtle-count project-page-count"><span class="sr-only">本页数量: <\/span>1<\/span>/);
	assert.match(html, /class="project-pagination"/);
});

test("search counts matches on the current page without replacing the loaded-page count", () => {
	const html = renderTree(true, 1, "next-page", "not on this page");
	assert.match(html, /<button[^>]*class="[^"]*project-match-count[^>]*"[^>]*aria-label="本页匹配: 0"[^>]*>0<\/button>/);
	assert.doesNotMatch(html, /project-page-summary/);
	assert.match(html, /class="subtle-count project-page-count"><span class="sr-only">本页数量: <\/span>1<\/span>/);
	assert.match(html, /没有匹配的会话/);
	assert.doesNotMatch(html, /class="conversation-link"/);
	assert.match(html, /下一页/);
});

test("selected conversation remains mounted when it is outside the displayed directory page", () => {
	local.write("workspace", "selected-workspace");
	local.write("conversation", "selected-conversation");
	local.write("draft.selected-workspace.selected-conversation", "keep this draft");
	const cache = new QueryClient();
	cache.setQueryData(["workspaces", undefined], {
		items: [{ workspaceId: "other-workspace", name: "Other project" }],
		nextCursor: "next",
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
	assert.match(render(), /下一页/);
	cache.setQueryData(["workspaces", undefined], { items: [], nextCursor: null });
	const empty = render();
	assert.match(empty, /data-selected-conversation="selected-conversation"/);
	assert.doesNotMatch(empty, /第一页|下一页/);
	assert.match(empty, /aria-label="新建工作区"/);
	assert.match(empty, /aria-label="工作台设置"/);
	assert.match(empty, /<p class="sr-only"[^>]*>仅搜索已展开项目当前显示的会话页。<\/p>/);
	assert.match(empty, /aria-label="搜索范围"/);
	assert.equal(local.read("draft.selected-workspace.selected-conversation"), "keep this draft");
	cache.clear();
});
