import assert from "node:assert/strict";
import type { Conversation, SidebarView } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ActionMenuContent, ActionMenuItem, ActionMenuRadioGroup } from "../../../src/components/ui/action-menu.tsx";
import { Button } from "../../../src/components/ui/button.tsx";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { SidebarPreviewRow } from "../../../src/features/workbench/sidebar/preview-row.tsx";
import { WorkspaceTree } from "../../../src/features/workbench/sidebar/workspace-tree.tsx";

type ListOptions = {
	view: SidebarView;
	filter: string;
	enabled: boolean;
};
const fixture = vi.hoisted(() => ({
	filter: "active",
	options: undefined as ListOptions | undefined,
	call: vi.fn(),
	refs: [] as { current: unknown }[],
	refIndex: 0,
	effects: [] as (() => void)[],
}));
// Invokes the production branch and menu callbacks, without a DOM renderer.
// Browser focus/hover and native layout are intentionally separate acceptance checks.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useContext: () => null,
		useId: () => "branch-id",
		useRef: (value: unknown) => {
			const index = fixture.refIndex++;
			if (!fixture.refs[index]) fixture.refs[index] = { current: value };
			return fixture.refs[index];
		},
		useLayoutEffect: (effect: () => void) => fixture.effects.push(effect),
		useState: () => [
			fixture.filter,
			(value: string) => {
				fixture.filter = value;
			},
		],
	};
});
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => ({ call: fixture.call }) }));
vi.mock("../../../src/features/workbench/sidebar/use-navigation.ts", () => ({
	useNavigation: (view: SidebarView, filter: string, enabled: boolean) => {
		fixture.options = { view, filter, enabled };
		return { items: [] as Conversation[], hasData: true, isSuccess: true, isFetching: false, isPending: false };
	},
}));

function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function only<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const found = elements(node, type);
	assert.equal(found.length, 1);
	assert.ok(found[0]);
	return found[0];
}
function invoke(node: React.ReactNode): React.ReactNode {
	assert.ok(isValidElement(node));
	assert.equal(typeof node.type, "function");
	return Reflect.apply(node.type as (props: unknown) => React.ReactNode, undefined, [node.props]);
}
function fixtureTree(defaultWorkspaceId?: string, extra: Partial<React.ComponentProps<typeof WorkspaceTree>> = {}) {
	const client = { call: fixture.call, observe: vi.fn() };
	const session = new CatalogSession(client, new LocalState());
	const toggle = vi.fn();
	const open = vi.fn();
	const draft = vi.fn();
	const manage = vi.fn();
	const props = {
		catalog: session,
		guard: (action: () => void) => action(),
		workspaces: [{ workspaceId: "project", name: "Named project" }],
		defaultWorkspaceId,
		selectedWorkspace: "",
		selectedConversation: "",
		isExpanded: () => false,
		onToggle: toggle,
		onOpenProject: open,
		onSelect: vi.fn(),
		onNewConversation: draft,
		onManageProjectFolder: manage,
		...extra,
	};
	const render = (index = 0) => {
		const children = only(WorkspaceTree(props), "ul").props.children;
		assert.ok(Array.isArray(children));
		fixture.refIndex = 0;
		const result = invoke(children.flat().filter(isValidElement)[index]);
		for (const effect of fixture.effects.splice(0)) effect();
		return result;
	};
	return { render, toggle, open, draft, manage, session };
}
beforeEach(() => {
	fixture.filter = "active";
	fixture.options = undefined;
	fixture.refs = [];
	fixture.effects = [];
	vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

test("removing a focused conversation after a delayed refresh restores the surviving list only at actual removal", () => {
	const ui = fixtureTree();
	const region = only(ui.render(), "section");
	assert.ok(region.props.ref && typeof region.props.ref === "object");
	const focus = vi.fn();
	Object.assign(region.props.ref, { current: { focus } });
	const rowAction = { isConnected: true, closest: () => ({}) };
	const body = {};
	const document = { body, activeElement: rowAction as unknown };
	vi.stubGlobal("document", document);
	assert.ok(region.props.onFocusCapture);
	Reflect.apply(region.props.onFocusCapture, undefined, [
		{ target: rowAction, currentTarget: { contains: () => true } },
	]);
	ui.render();
	ui.render();
	assert.equal(focus.mock.calls.length, 0, "No timer can guess when an asynchronous catalog refresh removes its row");
	rowAction.isConnected = false;
	document.activeElement = body;
	ui.render();
	assert.deepEqual(focus.mock.calls, [[{ preventScroll: true }]]);
	ui.render();
	assert.equal(focus.mock.calls.length, 1);
});

test("disclosure, project navigation and direct draft entry are three independent exact-target callbacks", () => {
	const ui = fixtureTree();
	const row = only(ui.render(), SidebarPreviewRow);
	const children =
		typeof row.props.children === "function" ? row.props.children({ hovered: false }) : row.props.children;
	const disclosure = elements(children, "button").find((entry) => entry.props.className === "project-toggle");
	const project = elements(children, "button").find((entry) => entry.props.className === "project-open");
	assert.ok(disclosure?.props.onClick);
	assert.ok(project?.props.onClick);
	Reflect.apply(disclosure.props.onClick, undefined, []);
	assert.deepEqual(ui.toggle.mock.calls, [["project"]]);
	assert.equal(ui.open.mock.calls.length, 0);
	assert.equal(ui.draft.mock.calls.length, 0);
	Reflect.apply(project.props.onClick, undefined, []);
	assert.deepEqual(ui.open.mock.calls, [["project"]]);
	const actions = row.props.renderActions?.({
		previewContent: null,
		menuPosition: { sideOffset: 40, alignOffset: -4 },
		triggerRef: { current: null },
		onMenuOpen: vi.fn(),
		onOverlayChange: vi.fn(),
		onReturnFocus: vi.fn(),
		active: false,
		inlineActions: true,
		hidden: false,
	});
	const draft = only(actions, Button);
	assert.equal(draft.props.className, "project-new-conversation");
	assert.ok(draft.props.onClick);
	Reflect.apply(draft.props.onClick, undefined, []);
	assert.deepEqual(ui.draft.mock.calls, [["project"]]);
	assert.deepEqual(ui.toggle.mock.calls, [["project"]]);
	assert.equal(fixture.call.mock.calls.length, 0);
	assert.equal(ui.session.getSnapshot().pending, null, "Navigation cannot create a backing object");
});

test("archive visibility is changed by the project menu and opens only that collapsed branch", async () => {
	const ui = fixtureTree();
	const row = only(ui.render(), SidebarPreviewRow);
	const actions = row.props.renderActions?.({
		previewContent: null,
		menuPosition: { sideOffset: 40, alignOffset: -4 },
		triggerRef: { current: null },
		onMenuOpen: vi.fn(),
		onOverlayChange: vi.fn(),
		onReturnFocus: vi.fn(),
		active: false,
		inlineActions: true,
		hidden: false,
	});
	const children = only(actions, "div").props.children;
	assert.ok(Array.isArray(children));
	const menu = invoke(children[0]);
	const content = only(menu, ActionMenuContent);
	assert.equal(content.props.side, "right");
	assert.equal(content.props.align, "start");
	assert.equal(content.props.sideOffset, 40);
	assert.equal(content.props.alignOffset, -4);
	assert.equal(content.props.collisionPadding, 12);
	only(menu, ActionMenuRadioGroup).props.onValueChange?.("archived");
	ui.render();
	assert.deepEqual(fixture.options?.view, { kind: "workspace", workspaceId: "project" });
	assert.equal(fixture.options?.filter, "archived");
	assert.deepEqual(ui.toggle.mock.calls, [["project"]]);
	assert.equal(ui.open.mock.calls.length, 0);
	assert.equal(ui.draft.mock.calls.length, 0);
	assert.equal(fixture.call.mock.calls.length, 0, "Filter selection does not execute a command");
});

test("global Recent is readable without a default workspace and has no project navigation", () => {
	const ui = fixtureTree();
	const recent = ui.render(1);
	assert.equal(elements(recent, SidebarPreviewRow).length, 0);
	assert.equal(elements(recent, "button").length, 0);
	assert.deepEqual(fixture.options?.view, { kind: "recent" });
	assert.equal(fixture.options?.filter, "active");
	assert.equal(fixture.options?.enabled, true);
	assert.equal(ui.toggle.mock.calls.length, 0);
	assert.equal(fixture.call.mock.calls.length, 0);
});

test("project folder dialog returns through the explicit dialog owner, not a hidden row-menu callback", () => {
	const ui = fixtureTree();
	const row = only(ui.render(), SidebarPreviewRow);
	const returned = vi.fn();
	const actions = row.props.renderActions?.({
		previewContent: null,
		menuPosition: { sideOffset: 40, alignOffset: -4 },
		triggerRef: { current: null },
		onMenuOpen: vi.fn(),
		onOverlayChange: vi.fn(),
		onReturnFocus: returned,
		active: false,
		inlineActions: true,
		hidden: true,
	});
	const children = only(actions, "div").props.children;
	assert.ok(Array.isArray(children));
	const menu = invoke(children[0]);
	only(menu, ActionMenuItem).props.onSelect?.(new Event("select"));
	assert.equal(ui.manage.mock.calls.length, 1);
	assert.equal(ui.manage.mock.calls[0]?.[0].workspaceId, "project");
	const restore: unknown = ui.manage.mock.calls[0]?.[1];
	assert.ok(typeof restore === "function");
	restore();
	assert.deepEqual(returned.mock.calls, [["dialog"]]);
});

const logicalItem = {
	project: { projectId: "logical", name: "Logical", revision: 2, homeWorkspaceId: "home-adapter" },
	presentation: { projectId: "logical", pinned: false, revision: 3 },
};
test("logical branch identity and callbacks never substitute its home workspace", () => {
	const ui = fixtureTree(undefined, { projects: [logicalItem] });
	const tree = ui.render();
	const branch = only(tree, "li");
	assert.equal(branch.props["data-project-id" as keyof typeof branch.props], "logical");
	assert.equal(branch.props["data-workspace-id" as keyof typeof branch.props], "home-adapter");
	assert.deepEqual(fixture.options?.view, { kind: "project", projectId: "logical" });
	const row = only(tree, SidebarPreviewRow);
	const children =
		typeof row.props.children === "function" ? row.props.children({ hovered: false }) : row.props.children;
	const open = elements(children, "button").find((entry) => entry.props.className === "project-open");
	assert.ok(open?.props.onClick);
	Reflect.apply(open.props.onClick, undefined, []);
	assert.deepEqual(ui.open.mock.calls, [["logical"]]);
	ui.render(1);
	assert.deepEqual(fixture.options?.view, { kind: "project_recent" });
	assert.equal(fixture.call.mock.calls.length, 0);
});

test("logical catalog recovery fences project membership and retains only legacy Recent history", () => {
	const ui = fixtureTree(undefined, { projects: [logicalItem], logicalReady: false });
	const row = only(ui.render(), SidebarPreviewRow);
	assert.deepEqual(fixture.options?.view, { kind: "project", projectId: "logical" });
	assert.equal(fixture.options?.enabled, false);
	assert.equal(row.props.renderActions, undefined);
	assert.equal(row.props.preview({ close: vi.fn(), returnFocus: vi.fn() }), null);
	ui.render(1);
	assert.deepEqual(fixture.options?.view, { kind: "recent" });
});
