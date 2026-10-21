import assert from "node:assert/strict";
import type { ProjectFolder } from "@hipi/work-runtime/files";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import type { ProjectActionOwner } from "../../../src/features/workbench/projects/action-owner.ts";
import { ProjectPreviewCard } from "../../../src/features/workbench/sidebar/project-preview-card.tsx";

const state = vi.hoisted(() => ({
	locale: "en",
	more: false,
	count: 1,
	coverage: "ready" as "building" | "refreshing" | "ready",
	error: false,
	folderError: false,
	folder: undefined as ProjectFolder | undefined,
	options: [] as {
		queryKey: string[];
		enabled?: boolean;
		queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
	}[],
	call: vi.fn(async (): Promise<unknown> => ({ items: [], nextCursor: null })),
	getProject: vi.fn(async () => undefined),
}));
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: state.locale, t: (key: string) => key }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call: state.call }),
	useFiles: () => ({ fileAuthority: { getProject: state.getProject } }),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: (typeof state.options)[number]) => {
		state.options.push(options);
		return options.queryKey[0] === "projectFolder"
			? { data: state.folder, isError: state.folderError }
			: {
					data: { count: state.count, partial: state.more || state.coverage !== "ready", state: state.coverage },
					isError: state.error,
					isPending: false,
				};
	},
}));
beforeEach(() => {
	state.options = [];
	state.locale = "en";
	state.more = false;
	state.count = 1;
	state.coverage = "ready";
	state.error = false;
	state.folderError = false;
	state.folder = {
		workspaceId: "project",
		status: "available",
		bindingId: "private-binding",
		revision: 2,
		displayName: "Example",
		displayPath: "~/Work/Example",
		root: { workspaceId: "project", rootId: "private-root", writable: false },
	};
	vi.clearAllMocks();
});

test("only a ready logical hover card exposes title editing and authoritative pin actions; menus remain static", () => {
	const session = new CatalogSession({ call: vi.fn(), observe: vi.fn() }, new LocalState());
	const project = { projectId: "logical", name: "Logical", revision: 4, homeWorkspaceId: "project" };
	const owner: ProjectActionOwner = {
		state: session.getSnapshot(),
		projectId: "logical",
		disabled: false,
		canAct: () => true,
		isBusy: () => false,
		projectPinEnabled: true,
		pinned: false,
		pinDisabled: false,
		inline: null,
		inlineFailed: false,
		renameProject: () => null,
		togglePin: vi.fn(),
		beginInlineRename: vi.fn(),
		changeInlineName: vi.fn(),
		commitInlineRename: vi.fn(),
		cancelInlineRename: vi.fn(),
	};
	const html = renderToStaticMarkup(ProjectPreviewCard({ project, owner }));
	assert.match(html, /Rename project/);
	assert.match(html, /Pin project/);
	owner.pinned = true;
	assert.match(renderToStaticMarkup(ProjectPreviewCard({ project, owner })), /Unpin project/);
	owner.inline = { target: project, draft: "Unsaved", editing: true, request: null };
	assert.match(renderToStaticMarkup(ProjectPreviewCard({ project, owner })), /data-project-inline-rename/);
	assert.doesNotMatch(
		renderToStaticMarkup(ProjectPreviewCard({ project, owner, logicalReady: false })),
		/<input|Rename project|Pin project|Unpin project/,
	);
	assert.doesNotMatch(
		renderToStaticMarkup(ProjectPreviewCard({ workspace: { workspaceId: "project", name: "Legacy" }, owner })),
		/<input|Rename project|Pin project|Unpin project/,
	);
	assert.doesNotMatch(
		renderToStaticMarkup(ProjectPreviewCard({ project, owner, mode: "menu", onManageFolder: vi.fn() })),
		/<input|<button/,
	);
	owner.projectId = "other";
	assert.doesNotMatch(
		renderToStaticMarkup(ProjectPreviewCard({ project, owner })),
		/<input|Rename project|Pin project|Unpin project/,
	);
	session.dispose();
});

function card(onManageFolder?: () => void): ReactNode {
	return ProjectPreviewCard({ workspace: { workspaceId: "project", name: "Example project" }, onManageFolder });
}
test("card renders a verified display label and bounded count, never technical IDs or model authorization", async () => {
	const html = renderToStaticMarkup(card(() => {}));
	assert.match(html, /Example project/);
	assert.match(html, /1 chat/);
	assert.match(html, /~\/Work\/Example/);
	assert.match(html, /Project folder/);
	assert.doesNotMatch(html, /private-binding|private-root|authorize|Agent context/);
	assert.equal(
		state.call.mock.calls.length,
		0,
		"Constructing a card does not execute a request outside its query owner",
	);
	const signal = new AbortController().signal;
	await state.options.find((item) => item.queryKey[0] === "conversations")?.queryFn({ signal });
	await state.options.find((item) => item.queryKey[0] === "projectFolder")?.queryFn({ signal });
	assert.deepEqual(state.call.mock.calls, [["listConversations", { workspaceId: "project", filter: "all" }, signal]]);
	assert.deepEqual(state.getProject.mock.calls, [["project"]]);
});
test("partial catalog and unavailable folder remain truthful in both locales", () => {
	state.more = true;
	assert.match(renderToStaticMarkup(card()), /At least 1 chat/);
	state.locale = "zh-CN";
	state.folder = {
		workspaceId: "project",
		status: "revoked",
		bindingId: "private-binding",
		revision: 3,
		displayName: "Example",
		root: null,
	};
	const html = renderToStaticMarkup(card());
	assert.match(html, /至少 1 个聊天/);
	assert.match(html, /文件夹访问已撤销/);
	assert.doesNotMatch(html, /~\/Work|private-binding|private-root/);
});
test("a failed catalog read does not retain a misleading exact count", () => {
	state.error = true;
	const html = renderToStaticMarkup(card());
	assert.match(html, /Reload project details/);
	assert.doesNotMatch(html, /1 chat/);
});

test("a failed folder refresh hides the previously cached path and offers an explicit check", () => {
	state.folderError = true;
	const html = renderToStaticMarkup(card());
	assert.match(html, /Check folder/);
	assert.doesNotMatch(html, /~\/Work\/Example/);
	state.folderError = false;
	if (state.folder) state.folder.workspaceId = "another-project";
	assert.doesNotMatch(renderToStaticMarkup(card()), /~\/Work\/Example/);
});

test("the touch menu carries the same metadata without nesting card buttons inside its menu label", () => {
	const html = renderToStaticMarkup(
		ProjectPreviewCard({ workspace: { workspaceId: "project", name: "Example project" }, mode: "menu" }),
	);
	assert.match(html, /1 chat/);
	assert.match(html, /~\/Work\/Example/);
	assert.doesNotMatch(html, /<button/);
});

test("logical preview counts project membership but folder access uses only its home workspace adapter", async () => {
	const project = { projectId: "logical", name: "Logical name", revision: 4, homeWorkspaceId: "project" };
	const html = renderToStaticMarkup(ProjectPreviewCard({ project }));
	assert.match(html, /Logical name/);
	assert.match(html, /~\/Work\/Example/);
	const signal = new AbortController().signal;
	state.call.mockResolvedValueOnce({ matchedAtLeast: 3, complete: true, coverage: { state: "ready" } });
	const options = state.options.find((entry) => entry.queryKey[0] === "sidebar-navigation");
	assert.deepEqual(options?.queryKey, ["sidebar-navigation", "project-summary", "logical", "all"]);
	assert.deepEqual(await options?.queryFn({ signal }), { count: 3, partial: false, state: "ready" });
	assert.deepEqual(state.call.mock.calls, [
		["getProjectConversationSummary", { projectId: "logical", filter: "all" }, signal],
	]);
});

test("logical preview fences unreadied membership rather than presenting physical counts", () => {
	const html = renderToStaticMarkup(
		ProjectPreviewCard({
			project: { projectId: "logical", name: "Logical", revision: 4, homeWorkspaceId: "project" },
			logicalReady: false,
		}),
	);
	assert.doesNotMatch(html, /1 chat/);
	assert.match(html, /common.loading/);
	const options = state.options.find((entry) => entry.queryKey[0] === "sidebar-navigation");
	assert.equal(options?.enabled, false);
	assert.equal(
		state.options.some((entry) => entry.queryKey[0] === "conversations"),
		false,
	);
	assert.equal(state.call.mock.calls.length, 0);
});

test("logical summary presents exact totals including pins, bounded lower counts and no false zero while building", () => {
	const project = { projectId: "logical", name: "Logical", revision: 1, homeWorkspaceId: "project" };
	state.count = 3;
	assert.match(renderToStaticMarkup(ProjectPreviewCard({ project })), /3 chats/);
	state.more = true;
	state.count = 128;
	assert.match(renderToStaticMarkup(ProjectPreviewCard({ project })), /At least 128 chats/);
	state.locale = "zh-CN";
	assert.match(renderToStaticMarkup(ProjectPreviewCard({ project })), /至少 128 个聊天/);
	state.coverage = "building";
	state.count = 0;
	const building = renderToStaticMarkup(ProjectPreviewCard({ project }));
	assert.match(building, /common.loading/);
	assert.doesNotMatch(building, /0 个聊天/);
	state.locale = "en";
	state.coverage = "refreshing";
	const refreshing = renderToStaticMarkup(ProjectPreviewCard({ project }));
	assert.doesNotMatch(refreshing, /0 chats/);
	state.coverage = "ready";
	state.more = false;
	assert.match(renderToStaticMarkup(ProjectPreviewCard({ project })), /0 chats/);
});
