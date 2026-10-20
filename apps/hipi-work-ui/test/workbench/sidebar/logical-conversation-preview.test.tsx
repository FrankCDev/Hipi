import assert from "node:assert/strict";
import type * as React from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { ConversationPreview } from "../../../src/features/workbench/sidebar/conversation-preview.tsx";

const state = vi.hoisted(() => ({
	options: [] as { queryKey: string[]; queryFn: (context: { signal: AbortSignal }) => Promise<unknown> }[],
	call: vi.fn(),
	data: { projectId: "logical", name: "Latest name", revision: 4, homeWorkspaceId: "adapter" },
	error: false,
}));
vi.mock("react", async () => ({ ...(await vi.importActual<typeof React>("react")), useId: () => "title" }));
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => ({ call: state.call }) }));
vi.mock("../../../src/features/workbench/sidebar/selection-provider.tsx", () => ({
	useSidebarAlias: () => ({ active: false, ref: { current: null } }),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: (typeof state.options)[number]) => {
		state.options.push(options);
		return { data: state.data, isError: state.error };
	},
}));
const conversation = {
	workspaceId: "canonical",
	conversationId: "chat",
	title: "Chat",
	revision: 1,
	createdAt: null,
	archivedAt: null,
};
function nodes(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
	if (Array.isArray(node)) return node.flatMap(nodes);
	if (!isValidElement<Record<string, unknown>>(node)) return [];
	return [node, ...nodes(node.props.children as React.ReactNode)];
}
beforeEach(() => {
	state.options = [];
	state.error = false;
	state.data = { projectId: "logical", name: "Latest name", revision: 4, homeWorkspaceId: "adapter" };
	vi.clearAllMocks();
});
test("logical membership resolves renamed project only when preview mounts, never physical workspace name", async () => {
	const row = ConversationPreview({
		conversation,
		location: { kind: "pinned" },
		onSelect: vi.fn(),
		projectId: "logical",
		resolveWorkspace: true,
	});
	assert.equal(state.options.length, 0);
	const preview = row.props.preview({ close: vi.fn(), returnFocus: vi.fn() });
	const child = nodes(preview).find((node) => node.props.projectId === "logical");
	assert.ok(child);
	assert.equal(typeof child.type, "function");
	const rendered = Reflect.apply(child.type as (props: unknown) => React.ReactNode, undefined, [child.props]);
	assert.match(renderToStaticMarkup(rendered), /Latest name/);
	const signal = new AbortController().signal;
	await state.options[0]?.queryFn({ signal });
	assert.deepEqual(state.options[0]?.queryKey, ["project", "logical"]);
	assert.deepEqual(state.call.mock.calls, [["getProject", { projectId: "logical" }, signal]]);
});
test("authoritatively projectless pin does not call its physical Chats workspace a project", () => {
	const row = ConversationPreview({
		conversation,
		location: { kind: "pinned" },
		onSelect: vi.fn(),
		projectId: null,
		resolveWorkspace: true,
		workspaceName: "Chats",
	});
	const preview = row.props.preview({ close: vi.fn(), returnFocus: vi.fn() });
	assert.doesNotMatch(renderToStaticMarkup(preview), /Chats|preview-workspace/);
	assert.equal(state.options.length, 0);
});
test("mismatched or failed project lookup cannot show stale logical metadata", () => {
	for (const mismatch of [false, true]) {
		state.error = !mismatch;
		state.data.projectId = mismatch ? "other" : "logical";
		const row = ConversationPreview({
			conversation,
			location: { kind: "recent" },
			onSelect: vi.fn(),
			projectId: "logical",
		});
		const child = nodes(row.props.preview({ close: vi.fn(), returnFocus: vi.fn() })).find(
			(node) => node.props.projectId === "logical",
		);
		assert.ok(child);
		assert.equal(Reflect.apply(child.type as (props: unknown) => React.ReactNode, undefined, [child.props]), null);
	}
});
