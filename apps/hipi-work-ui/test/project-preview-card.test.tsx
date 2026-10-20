import assert from "node:assert/strict";
import type { ProjectFolder } from "@hipi/work-runtime/files";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { ProjectPreviewCard } from "../src/features/workbench/project-preview-card.tsx";

const state = vi.hoisted(() => ({
	locale: "en",
	more: false,
	error: false,
	folderError: false,
	folder: undefined as ProjectFolder | undefined,
	options: [] as { queryKey: string[]; queryFn: (context: { signal: AbortSignal }) => Promise<unknown> }[],
	call: vi.fn(async () => ({ items: [], nextCursor: null })),
	getProject: vi.fn(async () => undefined),
}));
vi.mock("../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: state.locale, t: (key: string) => key }),
}));
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call: state.call }),
	useFiles: () => ({ fileAuthority: { getProject: state.getProject } }),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: (typeof state.options)[number]) => {
		state.options.push(options);
		return options.queryKey[0] === "projectFolder"
			? { data: state.folder, isError: state.folderError }
			: {
					data: { items: [{ workspaceId: "project" }], nextCursor: state.more ? "next" : null },
					isError: state.error,
					isPending: false,
				};
	},
}));
beforeEach(() => {
	state.options = [];
	state.locale = "en";
	state.more = false;
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
