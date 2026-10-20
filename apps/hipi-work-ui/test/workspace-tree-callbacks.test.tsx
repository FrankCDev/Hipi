import assert from "node:assert/strict";
import type { Conversation } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { DropdownMenuContent, DropdownMenuRadioGroup } from "../src/components/ui/dropdown-menu.tsx";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { SidebarPreviewRow } from "../src/features/workbench/sidebar-preview-row.tsx";
import { WorkspaceTree } from "../src/features/workbench/workspace-tree.tsx";

type ListOptions = {
	queryKey: string[];
	enabled: boolean;
	queryPage: (cursor: string | undefined, signal: AbortSignal) => Promise<unknown>;
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
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("../src/app/client-provider.tsx", () => ({ useAppClient: () => ({ call: fixture.call }) }));
vi.mock("../src/features/workbench/use-catalog-pages.ts", () => ({
	useCatalogPages: (options: ListOptions) => {
		fixture.options = options;
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
function fixtureTree(defaultWorkspaceId?: string) {
	const client = { call: fixture.call, observe: vi.fn() };
	const session = new CatalogSession(client, new LocalState());
	const toggle = vi.fn();
	const open = vi.fn();
	const draft = vi.fn();
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
	};
	const render = (index = 0) => {
		const children = only(WorkspaceTree(props), "ul").props.children;
		assert.ok(Array.isArray(children));
		fixture.refIndex = 0;
		const result = invoke(children.flat().filter(isValidElement)[index]);
		for (const effect of fixture.effects.splice(0)) effect();
		return result;
	};
	return { render, toggle, open, draft, session };
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
	});
	const children = only(actions, "div").props.children;
	assert.ok(Array.isArray(children));
	const menu = invoke(children[0]);
	const content = only(menu, DropdownMenuContent);
	assert.equal(content.props.side, "right");
	assert.equal(content.props.align, "start");
	assert.equal(content.props.sideOffset, 40);
	assert.equal(content.props.alignOffset, -4);
	assert.equal(content.props.collisionPadding, 12);
	only(menu, DropdownMenuRadioGroup).props.onValueChange?.("archived");
	ui.render();
	assert.deepEqual(fixture.options?.queryKey, ["conversations", "project", "archived"]);
	assert.deepEqual(ui.toggle.mock.calls, [["project"]]);
	assert.equal(ui.open.mock.calls.length, 0);
	assert.equal(ui.draft.mock.calls.length, 0);
	const signal = new AbortController().signal;
	await fixture.options?.queryPage("page-two", signal);
	assert.deepEqual(fixture.call.mock.calls, [
		["listConversations", { workspaceId: "project", filter: "archived", cursor: "page-two" }, signal],
	]);
});

test("verified Recent is always readable, has no project navigation, and preserves exact identity outside loaded workspaces", () => {
	const ui = fixtureTree("verified-default");
	const recent = ui.render(1);
	assert.equal(elements(recent, SidebarPreviewRow).length, 0);
	assert.equal(elements(recent, "button").length, 0);
	assert.deepEqual(fixture.options?.queryKey, ["conversations", "verified-default", "active"]);
	assert.equal(fixture.options?.enabled, true);
	assert.equal(ui.toggle.mock.calls.length, 0);
	assert.equal(fixture.call.mock.calls.length, 0);
});
