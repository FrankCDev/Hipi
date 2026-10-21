import assert from "node:assert/strict";
import { ContextMenu, DropdownMenu } from "radix-ui";
import type * as React from "react";
import { isValidElement } from "react";
import { beforeEach, test, vi } from "vitest";
import {
	ActionMenu,
	ActionMenuBoundary,
	ActionMenuContent,
	ActionMenuItem,
	ActionMenuLabel,
	ActionMenuRadioGroup,
	ActionMenuRadioItem,
	type ActionMenuState,
} from "../src/components/ui/action-menu.tsx";
import * as Dropdown from "../src/components/ui/dropdown-menu.tsx";

const fixture = vi.hoisted(() => ({ state: null as ActionMenuState | null }));
vi.mock("react", async () => ({
	...(await vi.importActual<typeof React>("react")),
	useContext: () => fixture.state,
	useRef: <T,>(initial: T) => ({ current: initial }),
}));
beforeEach(() => {
	fixture.state = null;
});
function only<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>> {
	assert.ok(isValidElement<{ children?: React.ReactNode }>(node));
	if (node.type === type && isValidElement<React.ComponentProps<C>>(node)) return node;
	return only(node.props.children, type);
}

for (const entry of ["ellipsis", "context"] as const) {
	test(`${entry} is the only active root and owns one unchanged action subtree`, () => {
		const changed = vi.fn();
		const child = <span>One action body</span>;
		const state: ActionMenuState = { entry, open: true, onOpenChange: changed };
		const boundary = ActionMenuBoundary({ state, children: child });
		assert.equal(only(boundary, ContextMenu.Root).props.open, entry === "context");
		assert.equal(only(boundary, DropdownMenu.Root).props.open, entry === "ellipsis");
		assert.equal(only(boundary, DropdownMenu.Root).props.children, child);
		assert.equal(ActionMenu({ boundary: state, children: child }), child);
		assert.equal(changed.mock.calls.length, 0, "Rendering must never open a context menu or execute an action");
	});
}

test("standalone action menus retain the shared dropdown root and item behavior", () => {
	const change = vi.fn();
	const body = ActionMenu({ open: false, onOpenChange: change, children: "Body" });
	assert.equal(only(body, Dropdown.DropdownMenu).props.onOpenChange, change);
	const select = vi.fn();
	const item = ActionMenuItem({ onSelect: select, disabled: true, children: "Action" });
	assert.equal(only(item, Dropdown.DropdownMenuItem).props.onSelect, select);
	assert.equal(only(item, Dropdown.DropdownMenuItem).props.disabled, true);
});

test("context content uses public collision geometry and the exact same command and focus callbacks", () => {
	fixture.state = {
		entry: "context",
		open: true,
		contextPosition: { sideOffset: 16, alignOffset: 116 },
		onOpenChange: vi.fn(),
	};
	const close = vi.fn();
	const content = ActionMenuContent({
		side: "bottom",
		align: "end",
		sideOffset: 40,
		alignOffset: -4,
		collisionPadding: 12,
		className: "conversation-action-menu",
		onCloseAutoFocus: close,
	});
	const primitive = only(content, ContextMenu.Content);
	assert.equal(primitive.props.side, "right");
	assert.equal(primitive.props.align, "start");
	assert.equal(primitive.props.sideOffset, 16);
	assert.equal(primitive.props.alignOffset, 116);
	assert.equal(primitive.props.collisionPadding, 12);
	primitive.props.onCloseAutoFocus?.(new Event("close", { cancelable: true }));
	assert.equal(close.mock.calls.length, 1);
	assert.match(primitive.props.className ?? "", /ui-menu-surface.*ui-context-menu-surface.*conversation-action-menu/);
	const label = only(ActionMenuLabel({ className: "sidebar-menu-preview", children: "Preview" }), ContextMenu.Label);
	assert.equal(Reflect.get(label.props, "data-slot"), "context-menu-label");
	assert.match(label.props.className ?? "", /sidebar-menu-preview/);
	const select = vi.fn();
	const item = only(
		ActionMenuItem({ onSelect: select, disabled: true, variant: "destructive", children: "Action" }),
		ContextMenu.Item,
	);
	assert.equal(item.props.onSelect, select);
	assert.equal(item.props.disabled, true);
	assert.match(item.props.className ?? "", /data-\[variant=destructive\]/);
	assert.equal(select.mock.calls.length, 0);
	const filter = vi.fn();
	assert.equal(
		only(ActionMenuRadioGroup({ value: "active", onValueChange: filter }), ContextMenu.RadioGroup).props.onValueChange,
		filter,
	);
	assert.equal(
		only(ActionMenuRadioItem({ value: "archived", children: "Archived" }), ContextMenu.RadioItem).props.value,
		"archived",
	);
});

test("portalled menu context events do not reopen the source row or suppress the native default", () => {
	fixture.state = { entry: "context", open: true, onOpenChange: vi.fn() };
	const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
	const content = only(ActionMenuContent({}), ContextMenu.Content);
	assert.ok(content.props.onContextMenu);
	Reflect.apply(content.props.onContextMenu, undefined, [event]);
	assert.equal(event.stopPropagation.mock.calls.length, 1);
	assert.equal(event.preventDefault.mock.calls.length, 0);
});

for (const entry of ["ellipsis", "context"] as const) {
	test(`${entry} dismissal preserves a newer outside pointer or focus intent`, () => {
		fixture.state = { entry, open: true, onOpenChange: vi.fn() };
		const restore = vi.fn();
		const view = ActionMenuContent({ onCloseAutoFocus: restore });
		const content = entry === "context" ? only(view, ContextMenu.Content) : only(view, Dropdown.DropdownMenuContent);
		const outside = new Event("outside", { cancelable: true });
		assert.ok(content.props.onInteractOutside);
		Reflect.apply(content.props.onInteractOutside, undefined, [outside]);
		const close = new Event("close", { cancelable: true });
		content.props.onCloseAutoFocus?.(close);
		assert.equal(close.defaultPrevented, true);
		assert.equal(restore.mock.calls.length, 0);
		content.props.onCloseAutoFocus?.(new Event("later-close", { cancelable: true }));
		assert.equal(restore.mock.calls.length, 1, "The old outside intent is consumed, not retained for later menu use");
	});
}
