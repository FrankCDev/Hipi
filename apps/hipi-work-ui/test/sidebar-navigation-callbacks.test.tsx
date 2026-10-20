import assert from "node:assert/strict";
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
import { Popover, PopoverContent } from "../src/components/ui/popover.tsx";
import { ConversationActions } from "../src/features/workbench/catalog-controls.tsx";
import { CatalogPagination } from "../src/features/workbench/catalog-pagination.tsx";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { type PreviewActions, SidebarPreviewRow } from "../src/features/workbench/sidebar-preview-row.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: new Map<string, Cell[]>(),
	scope: "",
	cursor: 0,
	commits: [] as (() => void)[],
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
	assert.equal(content.props.sideOffset, 16);
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
