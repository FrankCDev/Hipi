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

function renderTree(expanded: boolean, count = 1) {
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
		nextCursor: "next-page",
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
					search=""
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
	assert.equal((html.match(/lucide-ellipsis/g) ?? []).length, 2);
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
	assert.match(expanded, /重命名会话/);
	assert.match(expanded, /归档会话/);
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
	cache.setQueryData(["workspaces", undefined], { items: [], nextCursor: null });
	assert.match(render(), /data-selected-conversation="selected-conversation"/);
	assert.equal(local.read("draft.selected-workspace.selected-conversation"), "keep this draft");
	cache.clear();
});
