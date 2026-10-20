import assert from "node:assert/strict";
import type * as DndCore from "@dnd-kit/core";
import { type AppClient, type Conversation, type Method, parseResult } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog, DialogContent } from "../src/components/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
} from "../src/components/ui/dropdown-menu.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { Popover, PopoverContent } from "../src/components/ui/popover.tsx";
import { ConversationActions } from "../src/features/workbench/catalog-controls.tsx";
import { CatalogPagination } from "../src/features/workbench/catalog-pagination.tsx";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { PresentationSession } from "../src/features/workbench/presentation-session.ts";
import { type PreviewActions, SidebarPreviewRow } from "../src/features/workbench/sidebar-preview-row.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: new Map<string, Cell[]>(),
	scope: "",
	cursor: 0,
	commits: [] as (() => void)[],
	dragContext: { state: { source: false } },
}));
// Bounded production-callback adapter. It checks owner handoff and explicit
// focus callbacks, not browser focus order, portal mounting, or React DOM.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	function cell() {
		const cells = hooks.cells.get(hooks.scope) ?? [];
		hooks.cells.set(hooks.scope, cells);
		const index = hooks.cursor++;
		return { cells, index, previous: cells[index] };
	}
	return {
		...actual,
		useContext: () => hooks.dragContext,
		useLayoutEffect: () => {},
		useState: <T,>(initial: T | (() => T)) => {
			const { cells, index, previous } = cell();
			const current = previous ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			cells[index] = current;
			return [
				current.value,
				(value: T) => {
					current.value = value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const { cells, index, previous } = cell();
			const current = previous ?? { value: { current: initial } };
			cells[index] = current;
			return current.value;
		},
		useId: () => `${hooks.scope}-${hooks.cursor++}`,
		useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const { cells, index, previous } = cell();
			if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps?.[offset]))) {
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
			}
		},
	};
});
// Only adapt hooks used by the sortable boundary. These navigation tests do not
// simulate dnd-kit sensors, collision measurement, or the library components.
vi.mock("@dnd-kit/core", async () => {
	const actual = await vi.importActual<typeof DndCore>("@dnd-kit/core");
	return {
		...actual,
		useDraggable: () => ({
			attributes: {},
			listeners: undefined,
			setNodeRef: vi.fn(),
			setActivatorNodeRef: vi.fn(),
		}),
		useDroppable: () => ({ setNodeRef: vi.fn() }),
	};
});
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => cache,
}));
const cache = { setQueryData: vi.fn(), invalidateQueries: vi.fn() };

function drive<T>(scope: string, render: () => T) {
	hooks.scope = scope;
	hooks.cursor = 0;
	const output = render();
	for (const commit of hooks.commits.splice(0)) commit();
	return output;
}
function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function element<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const found = elements(node, type);
	assert.equal(found.length, 1);
	const only = found[0];
	assert.ok(only);
	return only;
}

beforeEach(() => {
	hooks.cells.clear();
	hooks.commits = [];
	hooks.dragContext = { state: { source: false } };
	vi.clearAllMocks();
	vi.useFakeTimers();
});
afterEach(() => {
	for (const cells of hooks.cells.values()) for (const entry of cells) entry?.cleanup?.();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const conversation: Conversation = {
	workspaceId: "project",
	conversationId: "task",
	title: "A task",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
function rowAndActions() {
	let controls: Parameters<PreviewActions>[0] | undefined;
	const renderRow = () =>
		drive("row", () =>
			SidebarPreviewRow({
				className: "conversation-preview-row",
				selected: true,
				titleId: "task-title",
				children: null,
				preview: () => <span>Actual title and project metadata</span>,
				renderActions: (value) => {
					controls = value;
					return null;
				},
			}),
		);
	const focus = () => {
		const row = element(renderRow(), "div");
		assert.ok(row.props.onFocusCapture);
		Reflect.apply(row.props.onFocusCapture, undefined, [
			{ currentTarget: { contains: () => true }, target: { matches: () => true } },
		]);
	};
	renderRow();
	assert.ok(controls);
	const owner = controls;
	const returned = vi.fn(focus);
	Object.assign(owner.triggerRef, { current: { focus: returned } });
	const session = new CatalogSession({ call: vi.fn(), observe: vi.fn() }, new LocalState());
	const renderActions = () =>
		drive("actions", () => ConversationActions({ conversation, session, guard: (action) => action(), ...controls }));
	return { renderRow, renderActions, focus, returned };
}

function renameActions(client: AppClient) {
	const local = new LocalState();
	const session = new CatalogSession(client, local);
	const returned = vi.fn();
	const source = { ...conversation };
	const render = () =>
		drive("rename", () =>
			ConversationActions({
				conversation: source,
				session,
				guard: (action) => action(),
				onReturnFocus: returned,
			}),
		);
	const open = () => {
		const rename = elements(render(), DropdownMenuItem).find((item) =>
			JSON.stringify(item.props.children).includes("Rename conversation"),
		);
		assert.ok(rename?.props.onSelect);
		rename.props.onSelect(new Event("select"));
	};
	const change = (value: string) => {
		const input = element(render(), Input);
		assert.ok(input.props.onChange);
		Reflect.apply(input.props.onChange, undefined, [{ target: { value } }]);
	};
	return { local, session, source, returned, render, open, change };
}

function renameButton(node: React.ReactNode, action: "save" | "cancel") {
	const button = elements(node, Button).find((item) => item.props.className === `conversation-rename-${action}`);
	assert.ok(button?.props.onClick);
	return button;
}

function renameEnter(node: React.ReactNode, overrides: Partial<KeyboardEvent> = {}) {
	const input = element(node, Input);
	assert.ok(input.props.onKeyDown);
	const preventDefault = vi.fn();
	Reflect.apply(input.props.onKeyDown, undefined, [
		{
			preventDefault,
			nativeEvent: {
				key: "Enter",
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				altKey: false,
				isComposing: false,
				keyCode: 13,
				repeat: false,
				timeStamp: 1000,
				...overrides,
			},
		},
	]);
	return preventDefault;
}

function catalogSettled(session: CatalogSession) {
	return new Promise<void>((resolve) => {
		const unsubscribe = session.subscribe(() => {
			if (!session.getSnapshot().busy) {
				unsubscribe();
				resolve();
			}
		});
	});
}

test("Rename focuses and selects the current title, Cancel sends nothing and returns to its exact trigger", () => {
	const call = vi.fn();
	const ui = renameActions({ call, observe: vi.fn() });
	ui.open();
	const input = element(ui.render(), Input);
	assert.equal(input.props.value, conversation.title);
	assert.ok(input.props.ref && typeof input.props.ref === "object");
	const focus = vi.fn();
	const select = vi.fn();
	Object.assign(input.props.ref, { current: { focus, select } });
	const event = new Event("open", { cancelable: true });
	element(ui.render(), DialogContent).props.onOpenAutoFocus?.(event);
	assert.equal(event.defaultPrevented, true);
	assert.equal(focus.mock.calls.length, 1);
	assert.equal(select.mock.calls.length, 1);
	ui.change("Uncommitted title");
	const cancel = renameButton(ui.render(), "cancel");
	assert.equal(cancel.props.children, "Cancel");
	assert.equal(renameButton(ui.render(), "save").props.children, "Save");
	Reflect.apply(cancel.props.onClick, undefined, []);
	assert.equal(element(ui.render(), Dialog).props.open, false);
	element(ui.render(), DialogContent).props.onCloseAutoFocus?.(new Event("close", { cancelable: true }));
	assert.equal(ui.returned.mock.calls.length, 1);
	assert.equal(call.mock.calls.length, 0);
	assert.equal(ui.local.read("command.catalog"), null);
	ui.source.title = "Latest current title";
	ui.open();
	assert.equal(element(ui.render(), Input).props.value, "Latest current title");
	ui.session.dispose();
});

test("Rename blocks empty titles, implicit form submission, repeated Enter and IME confirmation", () => {
	const call = vi.fn();
	const ui = renameActions({ call, observe: vi.fn() });
	ui.open();
	ui.change("   ");
	assert.equal(renameButton(ui.render(), "save").props.disabled, true);
	renameEnter(ui.render());
	ui.change("中文标题");
	let input = element(ui.render(), Input);
	assert.ok(input.props.onCompositionStart);
	Reflect.apply(input.props.onCompositionStart, undefined, []);
	assert.equal(renameEnter(ui.render()).mock.calls.length, 0, "IME keeps its native key behavior");
	input = element(ui.render(), Input);
	assert.ok(input.props.onCompositionEnd);
	Reflect.apply(input.props.onCompositionEnd, undefined, [{ timeStamp: 1000 }]);
	assert.equal(renameEnter(ui.render(), { timeStamp: 1050 }).mock.calls.length, 1);
	assert.ok(input.props.onKeyUp);
	Reflect.apply(input.props.onKeyUp, undefined, []);
	renameEnter(ui.render(), { isComposing: true });
	renameEnter(ui.render(), { keyCode: 229 });
	assert.equal(renameEnter(ui.render(), { repeat: true }).mock.calls.length, 1);
	renameEnter(ui.render(), { shiftKey: true });
	const form = element(ui.render(), "form");
	assert.ok(form.props.onSubmit);
	const preventDefault = vi.fn();
	Reflect.apply(form.props.onSubmit, undefined, [{ preventDefault }]);
	assert.equal(preventDefault.mock.calls.length, 1);
	const escapeEvent = new Event("keydown", { cancelable: true });
	Object.assign(escapeEvent, { isComposing: true, keyCode: 229 });
	Reflect.apply(element(ui.render(), DialogContent).props.onEscapeKeyDown, undefined, [escapeEvent]);
	assert.equal(escapeEvent.defaultPrevented, true);
	assert.equal(call.mock.calls.length, 0);
	assert.equal(ui.local.read("command.catalog"), null);
	assert.equal(element(ui.render(), Dialog).props.open, true);
	ui.session.dispose();
});

test("Rename Enter saves once with immutable title and revision, guards pending dismissal and closes after confirmation", async () => {
	const calls: { method: Method; params: unknown }[] = [];
	const result = { ...conversation, title: "New title", revision: 2 };
	let finishRename: ((value: Conversation) => void) | undefined;
	const response = new Promise<Conversation>((resolve) => {
		finishRename = resolve;
	});
	const ui = renameActions({
		call: async (method, params) => {
			calls.push({ method, params });
			return parseResult(method, method === "renameConversation" ? await response : result);
		},
		observe: vi.fn(),
	});
	ui.open();
	ui.change("  New title  ");
	const before = ui.render();
	const cancelBeforeDispatch = renameButton(before, "cancel");
	const saveBeforeDispatch = renameButton(before, "save");
	const finished = catalogSettled(ui.session);
	assert.equal(renameEnter(before).mock.calls.length, 1);
	renameEnter(before);
	Reflect.apply(saveBeforeDispatch.props.onClick, undefined, []);
	Reflect.apply(cancelBeforeDispatch.props.onClick, undefined, []);
	element(before, Dialog).props.onOpenChange?.(false);
	assert.equal(element(ui.render(), Dialog).props.open, true);
	assert.equal(element(ui.render(), DialogContent).props.closeDisabled, true);
	assert.equal(element(ui.render(), Input).props.disabled, true);
	assert.equal(renameButton(ui.render(), "cancel").props.disabled, true);
	assert.equal(renameButton(ui.render(), "save").props.disabled, true);
	const escapeEvent = new Event("keydown", { cancelable: true });
	Reflect.apply(element(ui.render(), DialogContent).props.onEscapeKeyDown, undefined, [escapeEvent]);
	assert.equal(escapeEvent.defaultPrevented, true);
	ui.source.title = "Later UI label";
	ui.source.revision = 9;
	finishRename?.(result);
	await finished;
	await Promise.resolve();
	assert.deepEqual(
		calls.map((call) => call.method),
		["renameConversation", "getConversation"],
	);
	assert.deepEqual(calls[0]?.params, {
		workspaceId: "project",
		conversationId: "task",
		requestId: (calls[0]?.params as { requestId: string }).requestId,
		expectedRevision: 1,
		title: "New title",
	});
	assert.equal(ui.session.getSnapshot().pending, null);
	assert.equal(element(ui.render(), Dialog).props.open, false);
	element(ui.render(), DialogContent).props.onCloseAutoFocus?.(new Event("close", { cancelable: true }));
	assert.equal(ui.returned.mock.calls.length, 1);
	assert.equal(cache.setQueryData.mock.calls.length, 1);
	ui.session.dispose();
});

test("unknown Rename keeps its original request and input, disables Save, and Close never cancels or replaces it", async () => {
	const calls: Method[] = [];
	const ui = renameActions({
		call: async (method) => {
			calls.push(method);
			if (method === "getConversationCommandResult") return parseResult(method, null);
			throw new Error("Lost rename response");
		},
		observe: vi.fn(),
	});
	ui.open();
	ui.change("Unconfirmed title");
	const before = ui.render();
	const save = renameButton(before, "save");
	const finished = catalogSettled(ui.session);
	Reflect.apply(save.props.onClick, undefined, []);
	await finished;
	await Promise.resolve();
	const saved = ui.local.read("command.catalog");
	assert.match(saved ?? "", /Unconfirmed title/);
	assert.equal(ui.session.getSnapshot().pending?.method, "renameConversation");
	assert.equal(element(ui.render(), Dialog).props.open, true);
	assert.equal(element(ui.render(), Input).props.value, "Unconfirmed title");
	assert.equal(element(ui.render(), Input).props.disabled, true);
	assert.equal(renameButton(ui.render(), "save").props.disabled, true);
	renameEnter(before);
	Reflect.apply(save.props.onClick, undefined, []);
	const close = renameButton(ui.render(), "cancel");
	assert.equal(close.props.children, "Close", "Closing an unknown request must not imply cancellation");
	assert.equal(close.props.disabled, false);
	Reflect.apply(close.props.onClick, undefined, []);
	assert.equal(element(ui.render(), Dialog).props.open, false);
	Reflect.apply(save.props.onClick, undefined, []);
	await Promise.resolve();
	assert.deepEqual(calls, ["renameConversation", "getConversationCommandResult"]);
	assert.equal(ui.local.read("command.catalog"), saved);
	assert.equal(cache.setQueryData.mock.calls.length, 0);
	assert.equal(cache.invalidateQueries.mock.calls.length, 0);
	ui.session.dispose();
});

test("sidebar action menus align to the full row's right edge and top, not the trailing button", () => {
	const ui = rowAndActions();
	const row = element(ui.renderRow(), "div");
	assert.ok(row.props.ref && typeof row.props.ref === "object");
	Object.assign(row.props.ref, {
		current: { getBoundingClientRect: () => ({ right: 275, top: 80 }) },
	});
	const trigger = elements(ui.renderActions(), Button).find(
		(button) => button.props.className === "conversation-actions-trigger",
	);
	assert.ok(trigger);
	assert.ok(trigger.props.ref && typeof trigger.props.ref === "object");
	Object.assign(trigger.props.ref, {
		current: { getBoundingClientRect: () => ({ right: 263, top: 84 }), focus: vi.fn() },
	});
	element(ui.renderActions(), DropdownMenu).props.onOpenChange?.(true);
	ui.renderRow();
	const content = element(ui.renderActions(), DropdownMenuContent);
	assert.equal(content.props.side, "right");
	assert.equal(content.props.align, "start");
	assert.equal(content.props.sideOffset, 14);
	assert.equal(content.props.alignOffset, -4);
	assert.equal(content.props.collisionPadding, 12);
	assert.equal(content.props.avoidCollisions, undefined, "Radix collision handling keeps its enabled default");
});

test("production menu-to-dialog callbacks exclude previews until dialog closes and suppress return-focus reopen", () => {
	const ui = rowAndActions();
	element(ui.renderActions(), DropdownMenu).props.onOpenChange?.(true);
	ui.focus();
	vi.advanceTimersByTime(400);
	assert.equal(element(ui.renderRow(), Popover).props.open, false);
	const rename = elements(ui.renderActions(), DropdownMenuItem).find((item) =>
		JSON.stringify(item.props.children).includes("Rename conversation"),
	);
	assert.ok(rename?.props.onSelect);
	rename.props.onSelect(new Event("select"));
	element(ui.renderActions(), DropdownMenu).props.onOpenChange?.(false);
	assert.equal(element(ui.renderActions(), Dialog).props.open, true);
	ui.focus();
	vi.advanceTimersByTime(400);
	assert.equal(element(ui.renderRow(), Popover).props.open, false);
	const menuClose = new Event("close", { cancelable: true });
	element(ui.renderActions(), DropdownMenuContent).props.onCloseAutoFocus?.(menuClose);
	assert.equal(menuClose.defaultPrevented, true);
	assert.equal(ui.returned.mock.calls.length, 0, "menu dismissal must not steal focus from the dialog");
	element(ui.renderActions(), Dialog).props.onOpenChange?.(false);
	element(ui.renderActions(), DialogContent).props.onCloseAutoFocus?.(new Event("close", { cancelable: true }));
	assert.equal(ui.returned.mock.calls.length, 1);
	vi.advanceTimersByTime(400);
	assert.equal(element(ui.renderRow(), Popover).props.open, false);
	ui.focus();
	vi.advanceTimersByTime(350);
	assert.equal(element(ui.renderRow(), Popover).props.open, true, "deliberate later keyboard focus can still preview");
});

test("touch menu exposes the same read-only preview with no duplicate View details action", () => {
	const ui = rowAndActions();
	element(ui.renderActions(), DropdownMenu).props.onOpenChange?.(true);
	const menu = ui.renderActions();
	assert.deepEqual(
		element(menu, DropdownMenuLabel).props.children,
		element(ui.renderRow(), PopoverContent).props.children,
	);
	assert.match(JSON.stringify(element(menu, DropdownMenuLabel).props.children), /Actual title and project metadata/);
	const preview = elements(menu, DropdownMenuItem).find((item) =>
		JSON.stringify(item.props.children).includes("View details"),
	);
	assert.equal(preview, undefined);
	assert.equal(elements(menu, DropdownMenuItem).length, 2);
	element(ui.renderActions(), DropdownMenu).props.onOpenChange?.(false);
	const close = new Event("close", { cancelable: true });
	element(ui.renderActions(), DropdownMenuContent).props.onCloseAutoFocus?.(close);
	assert.equal(close.defaultPrevented, true);
	assert.equal(ui.returned.mock.calls.length, 1);
	vi.advanceTimersByTime(400);
	assert.equal(element(ui.renderRow(), Popover).props.open, false);
});

test("keyboard Tab enters an interactive card and returns through its exact source and next row control", () => {
	vi.stubGlobal("HTMLElement", Object);
	vi.stubGlobal("Element", Object);
	const ui = rowAndActions();
	const row = element(ui.renderRow(), "div");
	const card = element(ui.renderRow(), PopoverContent);
	const source = {
		isConnected: true,
		matches: () => true,
		closest: () => null,
		getClientRects: () => [{}],
		focus: vi.fn(),
	};
	const next = { ...source, focus: vi.fn() };
	const control = { ...source, focus: vi.fn() };
	Object.assign(row.props.ref, { current: { contains: (node: unknown) => node === source || node === next } });
	Object.assign(card.props.ref, {
		current: { querySelectorAll: () => [control], contains: (node: unknown) => node === control },
	});
	vi.stubGlobal("document", {
		activeElement: source,
		body: {},
		querySelectorAll: () => [source, next, control],
	});
	ui.focus();
	let view = ui.renderRow();
	const tab = {
		key: "Tab",
		shiftKey: false,
		nativeEvent: { isComposing: false },
		target: source,
		currentTarget: { contains: () => true },
		preventDefault: vi.fn(),
	};
	for (const modifier of ["altKey", "ctrlKey", "metaKey"] as const)
		Reflect.apply(element(view, "div").props.onKeyDown, undefined, [{ ...tab, [modifier]: true }]);
	assert.equal(control.focus.mock.calls.length, 0);
	assert.equal(tab.preventDefault.mock.calls.length, 0, "OS and app Tab chords retain their native behavior");
	Reflect.apply(element(view, "div").props.onKeyDown, undefined, [tab]);
	assert.equal(tab.preventDefault.mock.calls.length, 1);
	assert.equal(control.focus.mock.calls.length, 1);
	view = ui.renderRow();
	const back = { ...tab, shiftKey: true, target: control, preventDefault: vi.fn() };
	Reflect.apply(element(view, PopoverContent).props.onKeyDown, undefined, [back]);
	assert.equal(back.preventDefault.mock.calls.length, 1);
	assert.equal(source.focus.mock.calls.length, 1);
	assert.equal(
		element(ui.renderRow(), Popover).props.open,
		true,
		"Reverse Tab returns to the source without dismissing its card",
	);
	ui.focus();
	view = ui.renderRow();
	Reflect.apply(element(view, "div").props.onKeyDown, undefined, [tab]);
	view = ui.renderRow();
	Reflect.apply(element(view, PopoverContent).props.onKeyDown, undefined, [{ ...tab, target: control }]);
	assert.equal(next.focus.mock.calls.length, 1);
	assert.equal(element(ui.renderRow(), Popover).props.open, false);
});

test("active dragging closes an open preview and action hover cannot reopen it or restart the title", () => {
	class Target {
		closest() {
			return this;
		}
		contains() {
			return true;
		}
	}
	vi.stubGlobal("Node", Target);
	vi.stubGlobal("Element", Target);
	const ui = rowAndActions();
	const target = new Target();
	const pointer = { pointerType: "mouse", target, currentTarget: target };
	Reflect.apply(element(ui.renderRow(), "div").props.onPointerEnter, undefined, [pointer]);
	vi.advanceTimersByTime(400);
	assert.equal(element(ui.renderRow(), Popover).props.open, true);
	hooks.dragContext.state.source = true;
	ui.renderRow();
	assert.equal(element(ui.renderRow(), Popover).props.open, false);
	Reflect.apply(element(ui.renderRow(), "div").props.onPointerMove, undefined, [pointer]);
	Reflect.apply(element(ui.renderRow(), "div").props.onPointerEnter, undefined, [pointer]);
	vi.advanceTimersByTime(500);
	assert.equal(element(ui.renderRow(), Popover).props.open, false);
	hooks.dragContext.state.source = false;
});

test("reverse pointer travel uses the row corridor and stopping in the gap retains a bounded close deadline", () => {
	class Target {
		nodes: unknown[] = [];
		contains(node: unknown) {
			return this.nodes.includes(node);
		}
		closest() {
			return null;
		}
		getBoundingClientRect() {
			return { left: 0, right: 275, top: 80, bottom: 116 };
		}
	}
	vi.stubGlobal("Node", Target);
	vi.stubGlobal("Element", Target);
	const events = new Map<string, (event: unknown) => void>();
	const ui = rowAndActions();
	const row = element(ui.renderRow(), "div");
	const card = element(ui.renderRow(), PopoverContent);
	const source = new Target();
	const rowNode = new Target();
	rowNode.nodes = [source];
	const cardNode = new Target();
	cardNode.getBoundingClientRect = () => ({ left: 277, right: 597, top: 80, bottom: 220 });
	Object.assign(row.props.ref, { current: rowNode });
	Object.assign(card.props.ref, { current: cardNode });
	vi.stubGlobal("document", {
		activeElement: null,
		body: {},
		addEventListener: (name: string, handler: (event: unknown) => void) => events.set(name, handler),
		removeEventListener: (name: string) => events.delete(name),
	});
	Reflect.apply(row.props.onPointerEnter, undefined, [
		{ pointerType: "mouse", target: source, currentTarget: rowNode },
	]);
	vi.advanceTimersByTime(200);
	let view = ui.renderRow();
	assert.equal(element(view, Popover).props.open, true);
	Reflect.apply(element(view, PopoverContent).props.onPointerLeave, undefined, [{ clientX: 277, clientY: 200 }]);
	view = ui.renderRow();
	assert.ok(events.get("pointermove"));
	events.get("pointermove")?.({ pointerType: "mouse", target: new Target(), clientX: 276, clientY: 155 });
	vi.advanceTimersByTime(99);
	assert.equal(element(ui.renderRow(), Popover).props.open, true);
	events.get("pointermove")?.({ pointerType: "mouse", target: new Target(), clientX: 276, clientY: 150 });
	vi.advanceTimersByTime(99);
	assert.equal(element(ui.renderRow(), Popover).props.open, true);
	vi.advanceTimersByTime(1);
	assert.equal(
		element(ui.renderRow(), Popover).props.open,
		false,
		"A stationary pointer in the gap cannot leave a permanent card",
	);
});

for (const method of ["archiveConversation", "restoreConversation"] as const) {
	test(`${method} is a direct immutable guarded command, without a second confirmation dialog`, async () => {
		const local = new LocalState();
		const calls: { method: Method; params: unknown }[] = [];
		const source = { ...conversation, archivedAt: method === "restoreConversation" ? 100 : null };
		const result = { ...source, revision: 2, archivedAt: method === "archiveConversation" ? 200 : null };
		const client: AppClient = {
			call: async (name, params) => {
				calls.push({ method: name, params });
				return parseResult(name, result);
			},
			observe: vi.fn(),
		};
		const session = new CatalogSession(client, local);
		const actions: (() => void)[] = [];
		const render = () =>
			drive(method, () =>
				ConversationActions({
					conversation: source,
					session,
					guard: (action) => actions.push(action),
				}),
			);
		const item = elements(render(), DropdownMenuItem).find((entry) =>
			JSON.stringify(entry.props.children).includes(
				method === "archiveConversation" ? "Archive conversation" : "Restore conversation",
			),
		);
		assert.ok(item?.props.onSelect);
		item.props.onSelect(new Event("select"));
		assert.equal(element(render(), Dialog).props.open, false);
		assert.equal(calls.length, 0, "Dirty file guard must settle before any command is admitted");
		assert.equal(local.read("command.catalog"), null);
		source.title = "Later UI label";
		source.revision = 9;
		const finished = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe(() => {
				if (!session.getSnapshot().busy) {
					unsubscribe();
					resolve();
				}
			});
		});
		actions[0]?.();
		await finished;
		await Promise.resolve();
		assert.deepEqual(
			calls.map((call) => call.method),
			[method, "getConversation"],
		);
		assert.deepEqual(calls[0]?.params, {
			workspaceId: "project",
			conversationId: "task",
			requestId: (calls[0]?.params as { requestId: string }).requestId,
			expectedRevision: 1,
		});
		assert.equal(session.getSnapshot().pending, null);
		assert.equal(cache.setQueryData.mock.calls.length, 1);
		session.dispose();
	});
}

test("an unknown archive keeps its original recovery record and never reports optimistic success", async () => {
	const calls: Method[] = [];
	const local = new LocalState();
	const session = new CatalogSession(
		{
			call: async (method) => {
				calls.push(method);
				if (method === "getConversationCommandResult") return parseResult(method, null);
				throw new Error("Lost archive response");
			},
			observe: vi.fn(),
		},
		local,
	);
	const render = () =>
		drive("unknown", () =>
			ConversationActions({
				conversation,
				session,
				guard: (action) => action(),
			}),
		);
	const archive = elements(render(), DropdownMenuItem).find((entry) =>
		JSON.stringify(entry.props.children).includes("Archive conversation"),
	);
	assert.ok(archive?.props.onSelect);
	const finished = new Promise<void>((resolve) => {
		const unsubscribe = session.subscribe(() => {
			if (!session.getSnapshot().busy) {
				unsubscribe();
				resolve();
			}
		});
	});
	archive.props.onSelect(new Event("select"));
	await finished;
	await Promise.resolve();
	assert.deepEqual(calls, ["archiveConversation", "getConversationCommandResult"]);
	assert.equal(session.getSnapshot().pending?.method, "archiveConversation");
	assert.match(local.read("command.catalog") ?? "", /archiveConversation/);
	assert.equal(cache.setQueryData.mock.calls.length, 0);
	assert.equal(cache.invalidateQueries.mock.calls.length, 0);
	assert.equal(element(render(), Dialog).props.open, false);
	assert.equal(
		elements(render(), DropdownMenuItem).every((item) => item.props.disabled),
		true,
	);
	archive.props.onSelect(new Event("select"));
	await Promise.resolve();
	assert.deepEqual(
		calls,
		["archiveConversation", "getConversationCommandResult"],
		"A stale callback cannot replace the unknown request",
	);
	session.dispose();
});

test("a cancelled dirty-file guard does not send or persist the archive", () => {
	const call = vi.fn();
	const local = new LocalState();
	const session = new CatalogSession({ call, observe: vi.fn() }, local);
	const output = drive("cancelled", () => ConversationActions({ conversation, session, guard: () => {} }));
	const archive = elements(output, DropdownMenuItem).find((entry) =>
		JSON.stringify(entry.props.children).includes("Archive conversation"),
	);
	assert.ok(archive?.props.onSelect);
	archive.props.onSelect(new Event("select"));
	assert.equal(call.mock.calls.length, 0);
	assert.equal(local.read("command.catalog"), null);
	assert.equal(session.getSnapshot().busy, false);
	session.dispose();
});

test("an unresolved order blocks archive mutations but leaves rename and navigation ownership independent", async () => {
	const local = new LocalState();
	const calls: Method[] = [];
	const client: AppClient = {
		call: async (method) => {
			calls.push(method);
			if (method === "getPresentationCommandResult") return parseResult(method, null);
			throw new Error("Unknown order");
		},
		observe: vi.fn(),
	};
	const presentation = new PresentationSession(client, local);
	const session = new CatalogSession(client, local);
	const render = () =>
		drive("archive-order", () =>
			ConversationActions({ conversation, session, presentation, inlineActions: true, guard: (action) => action() }),
		);
	const staleArchive = elements(render(), DropdownMenuItem).find((item) =>
		JSON.stringify(item.props.children).includes("Archive conversation"),
	);
	await presentation.reorder({
		requestId: "unknown-order",
		moved: { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId },
		before: null,
		expectedOrderGeneration: 0,
	});
	const view = render();
	const archive = elements(view, DropdownMenuItem).find((item) =>
		JSON.stringify(item.props.children).includes("Archive conversation"),
	);
	const rename = elements(view, DropdownMenuItem).find((item) =>
		JSON.stringify(item.props.children).includes("Rename conversation"),
	);
	assert.equal(archive?.props.disabled, true);
	assert.equal(rename?.props.disabled, false);
	assert.equal(
		elements(view, Button).find((item) => item.props["aria-label"] === "Archive conversation")?.props.disabled,
		true,
	);
	staleArchive?.props.onSelect?.(new Event("select"));
	assert.deepEqual(calls, ["reorderPinnedConversation", "getPresentationCommandResult"]);
	assert.equal(local.write("workspace", "elsewhere"), true);
	session.dispose();
	presentation.dispose();
});

test("direct Archive follows the same immutable guard and unknown-request owner as the menu", async () => {
	const local = new LocalState();
	const calls: { method: Method; params: unknown }[] = [];
	const source = { ...conversation };
	const session = new CatalogSession(
		{
			call: async (method, params) => {
				calls.push({ method, params });
				if (method === "getConversationCommandResult") return parseResult(method, null);
				throw new Error("Lost response");
			},
			observe: vi.fn(),
		},
		local,
	);
	let continueAction: (() => void) | undefined;
	const render = () =>
		drive("direct-archive", () =>
			ConversationActions({
				conversation: source,
				session,
				inlineActions: true,
				active: true,
				guard: (action) => {
					continueAction = action;
				},
			}),
		);
	const direct = elements(render(), Button).find((button) => button.props["aria-label"] === "Archive conversation");
	assert.ok(direct?.props.onClick);
	Reflect.apply(direct.props.onClick, undefined, []);
	assert.equal(calls.length, 0);
	source.revision = 8;
	const settled = catalogSettled(session);
	continueAction?.();
	await settled;
	assert.equal(session.getSnapshot().pending?.method, "archiveConversation");
	assert.equal((calls[0]?.params as { expectedRevision: number }).expectedRevision, 1);
	assert.equal(
		elements(render(), Button).find((button) => button.props["aria-label"] === "Archive conversation")?.props.disabled,
		true,
	);
	Reflect.apply(direct.props.onClick, undefined, []);
	continueAction?.();
	await Promise.resolve();
	assert.deepEqual(
		calls.map(({ method }) => method),
		["archiveConversation", "getConversationCommandResult"],
	);
	assert.equal(element(render(), Dialog).props.open, false);
	session.dispose();
});

test("a delayed dirty-file callback cannot mutate a disposed catalog or report old success", async () => {
	const call = vi.fn();
	const session = new CatalogSession({ call, observe: vi.fn() }, new LocalState());
	let continueAfterGuard: (() => void) | undefined;
	const output = drive("disposed", () =>
		ConversationActions({
			conversation,
			session,
			guard: (action) => {
				continueAfterGuard = action;
			},
		}),
	);
	const archive = elements(output, DropdownMenuItem).find((entry) =>
		JSON.stringify(entry.props.children).includes("Archive conversation"),
	);
	assert.ok(archive?.props.onSelect);
	archive.props.onSelect(new Event("select"));
	session.dispose();
	assert.ok(continueAfterGuard);
	continueAfterGuard();
	await Promise.resolve();
	assert.equal(call.mock.calls.length, 0);
	assert.equal(cache.setQueryData.mock.calls.length, 0);
	assert.equal(cache.invalidateQueries.mock.calls.length, 0);
});

test("First page retains origin focus while busy and restores list focus when the control disappears", () => {
	const body = {};
	const button = { isConnected: true };
	const document = { activeElement: button, body };
	vi.stubGlobal("document", document);
	const focus = vi.fn();
	const listRef: React.RefObject<HTMLElement | null> = { current: null };
	Object.assign(listRef, { current: { focus } });
	const pages = {
		hasMore: false,
		canRestart: true,
		isFetching: false,
		isLoadingMore: false,
		isError: false,
		windowed: true,
		atLimit: false,
		loadMore: vi.fn(async () => {}),
		restart: vi.fn(async () => {}),
	};
	const render = () => drive("pagination", () => CatalogPagination({ pages, listRef }));
	const first = element(render(), Button);
	assert.equal(first.props.children, "First page");
	assert.ok(first.props.onClick);
	Reflect.apply(first.props.onClick, undefined, [{ currentTarget: button }]);
	assert.equal(pages.restart.mock.calls.length, 1);
	pages.isFetching = true;
	const busy = element(render(), Button);
	assert.equal(busy.props["aria-disabled"], true);
	assert.equal(busy.props.disabled, undefined, "busy controls remain focusable");
	assert.ok(busy.props.onClick);
	Reflect.apply(busy.props.onClick, undefined, [{ currentTarget: button }]);
	assert.equal(pages.restart.mock.calls.length, 1);
	pages.canRestart = false;
	pages.windowed = false;
	assert.equal(render(), null);
	assert.equal(focus.mock.calls.length, 0);
	button.isConnected = false;
	Object.assign(document, { activeElement: body });
	pages.isFetching = false;
	assert.equal(render(), null);
	assert.deepEqual(focus.mock.calls, [[{ preventScroll: true }]]);
});

test("bounded pagination labels disclose eviction and an error blocks Load more without removing First page", () => {
	const pages = {
		hasMore: true,
		canRestart: true,
		isFetching: false,
		isLoadingMore: false,
		isError: false,
		windowed: false,
		atLimit: true,
		loadMore: vi.fn(async () => {}),
		restart: vi.fn(async () => {}),
	};
	const listRef: React.RefObject<HTMLElement | null> = { current: null };
	const render = () => drive("pagination", () => CatalogPagination({ pages, listRef }));
	assert.equal(
		element(render(), "p").props.children,
		"Up to 5 pages stay visible. Loading more replaces the earliest page.",
	);
	pages.windowed = true;
	pages.isError = true;
	assert.equal(element(render(), "p").props.children, "Earlier pages are no longer shown. Use First page to return.");
	const buttons = elements(render(), Button);
	assert.equal(buttons[0]?.props.children, "First page");
	const more = buttons.find((entry) => entry.props.children === "Load more");
	assert.ok(more?.props.onClick);
	assert.equal(more.props["aria-disabled"], true);
	Reflect.apply(more.props.onClick, undefined, []);
	assert.equal(pages.loadMore.mock.calls.length, 0);
});
