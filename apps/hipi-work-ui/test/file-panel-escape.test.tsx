import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TextDocument } from "@pierre/diffs/edit";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { DialogContent } from "../src/components/ui/dialog.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { DEFAULT_EDITOR_KEYBINDINGS } from "../src/features/files/editor-keybindings.ts";
import { useFileLineNavigation } from "../src/features/files/file-line-navigation.tsx";
import { useFileSearch } from "../src/features/files/file-search.tsx";
import { FilePanel } from "../src/features/workbench/file-panel.tsx";
import { FilePanelController } from "../src/features/workbench/file-panel-controller.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
type HookScope = { cells: Cell[]; cursor: number; pending: (() => void)[]; changed: boolean };
const hooks = vi.hoisted(() => ({
	scope: undefined as HookScope | undefined,
}));

// Run the production outer capture guard before the production inner callbacks.
// DOM dispatch, portals and native focus still require the desktop interaction suite.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const scope = () => {
		assert.ok(hooks.scope);
		return hooks.scope;
	};
	const changed = (left: React.DependencyList | undefined, right: React.DependencyList | undefined) =>
		!left || !right || left.length !== right.length || right.some((value, index) => !Object.is(value, left[index]));
	const effect = (create: React.EffectCallback, deps?: React.DependencyList) => {
		const state = scope();
		const index = state.cursor++;
		const old = state.cells[index];
		if (!old || changed(old.deps, deps)) {
			const cell: Cell = { value: undefined, deps };
			state.cells[index] = cell;
			state.pending.push(() => {
				old?.cleanup?.();
				const cleanup = create();
				cell.cleanup = typeof cleanup === "function" ? cleanup : undefined;
			});
		}
	};
	const memo = (create: () => unknown, deps?: React.DependencyList) => {
		const state = scope();
		const index = state.cursor++;
		if (changed(state.cells[index]?.deps, deps)) state.cells[index] = { value: create(), deps };
		return state.cells[index]?.value;
	};
	return {
		...actual,
		useState: (initial: unknown) => {
			const state = scope();
			const index = state.cursor++;
			state.cells[index] ??= {
				value: typeof initial === "function" ? initial() : initial,
			};
			const cell = state.cells[index];
			return [
				cell.value,
				(value: unknown) => {
					const next = typeof value === "function" ? value(cell.value) : value;
					state.changed ||= !Object.is(cell.value, next);
					cell.value = next;
				},
			];
		},
		useRef: (initial: unknown) => {
			const state = scope();
			const index = state.cursor++;
			state.cells[index] ??= { value: { current: initial } };
			return state.cells[index].value;
		},
		useMemo: memo,
		useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
		useEffect: effect,
	};
});
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));

const scopes: HookScope[] = [];
function component<T>(render: () => T) {
	const scope: HookScope = { cells: [], cursor: 0, pending: [], changed: false };
	scopes.push(scope);
	return () => {
		for (let count = 0; count < 10; count++) {
			hooks.scope = scope;
			scope.cursor = 0;
			scope.changed = false;
			const view = render();
			for (const commit of scope.pending.splice(0)) commit();
			if (!scope.changed) return view;
		}
		throw new Error("Effects did not settle");
	};
}
function element<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
	predicate: (props: React.ComponentProps<C>) => boolean = () => true,
): React.ReactElement<React.ComponentProps<C>> {
	if (isValidElement<React.ComponentProps<C>>(node)) {
		if (node.type === type && predicate(node.props)) return node;
		const children: React.ReactNode = node.props.children;
		for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
			try {
				return element(child, type, predicate);
			} catch {
				/* Continue through siblings. */
			}
		}
	}
	throw new Error("Element missing");
}

class Surface extends EventTarget {
	marker: unknown;
	constructor(marker?: unknown) {
		super();
		this.marker = marker;
	}
	hasAttribute(name: string) {
		return name === "data-file-editor-cancel" && typeof this.marker === "string";
	}
}
class EscapeEvent extends Event {
	key = "Escape";
	isComposing = false;
	keyCode = 0;
	path: EventTarget[];
	constructor(path: EventTarget[]) {
		super("keydown", { cancelable: true, bubbles: true });
		this.path = path;
	}
	composedPath() {
		return this.path;
	}
}

beforeEach(() => {
	vi.stubGlobal("Element", Surface);
});
afterEach(() => {
	for (const scope of scopes.splice(0)) for (const cell of scope.cells) cell?.cleanup?.();
	vi.unstubAllGlobals();
});

function narrowPanel() {
	const controller = new FilePanelController(new LocalState());
	controller.setOpen(true);
	const panel = component(() =>
		FilePanel({
			controller,
			available: 600,
			workspaceId: "workspace",
			guard: (action) => action(),
			trigger: { current: null },
			id: "files",
		}),
	);
	const content = element(panel(), DialogContent);
	assert.ok(content.props.onEscapeKeyDown);
	return { onEscapeKeyDown: content.props.onEscapeKeyDown, controller, node: new Surface() };
}
function dispatchEscape(
	outer: ReturnType<typeof narrowPanel>,
	surface: React.ReactElement<React.HTMLAttributes<HTMLElement> & { "data-file-editor-cancel"?: string }>,
	options: { composing?: boolean; keyCode?: number; retargeted?: boolean; target?: { onKeyDown?: unknown } } = {},
) {
	const marker = new Surface(surface.props["data-file-editor-cancel"]);
	const leaf = new Surface();
	// A retargeted host is outside the marked surface; composedPath still contains it.
	const event = new EscapeEvent([leaf, marker, outer.node]);
	event.isComposing = options.composing ?? false;
	event.keyCode = options.keyCode ?? 0;
	if (options.retargeted) Object.defineProperty(event, "target", { value: outer.node });
	Reflect.apply(outer.onEscapeKeyDown, undefined, [event]);
	assert.equal(event.defaultPrevented, true);
	assert.equal(outer.controller.snapshot().open, true);
	const stopPropagation = vi.fn();
	const innerEvent = {
		key: event.key,
		nativeEvent: event,
		preventDefault: () => event.preventDefault(),
		stopPropagation,
	};
	if (typeof options.target?.onKeyDown === "function") Reflect.apply(options.target.onKeyDown, undefined, [innerEvent]);
	assert.ok(surface.props.onKeyDown);
	if (!stopPropagation.mock.calls.length) Reflect.apply(surface.props.onKeyDown, undefined, [innerEvent]);
	return stopPropagation;
}

test("installed Radix requires default prevention in the outer document capture callback, before inner bubbling", () => {
	const source = readFileSync(
		new URL("../../../node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs", import.meta.url),
		"utf8",
	);
	assert.match(source, /ownerDocument\.addEventListener\("keydown", handleKeyDown, \{ capture: true \}\)/);
	assert.match(source, /onEscapeKeyDown\?\.\(event\);\s*if \(!event\.defaultPrevented && onDismiss\)/);
});

test.each([
	"query",
	"replacement",
	"expand",
	"Match case",
	"Whole word",
	"Regular expression",
	"Previous match",
	"Next match",
	"Close find",
	"Replace",
	"Replace all",
])("Find Escape from %s is claimed before outer dismissal, cancels only Find, and restores editor focus", (control) => {
	const outer = narrowPanel();
	const document = new TextDocument("file", "one one");
	const focus = vi.fn();
	const render = component(() =>
		useFileSearch({
			document,
			text: document.getText(),
			bindings: DEFAULT_EDITOR_KEYBINDINGS,
			select: vi.fn(),
			focus,
		}),
	);
	render().open();
	let view = render();
	element(view.panel, Button, (props) => props["aria-expanded"] === false).props.onClick?.(
		{} as React.MouseEvent<HTMLButtonElement>,
	);
	view = render();
	element(view.panel, Input, (props) => props["aria-label"] === "Find in file").props.onChange?.({
		currentTarget: { value: "one" },
	} as React.ChangeEvent<HTMLInputElement>);
	view = render();
	const target =
		control === "query" || control === "replacement"
			? element(
					view.panel,
					Input,
					(props) => props["aria-label"] === (control === "query" ? "Find in file" : "Replace"),
				)
			: element(view.panel, Button, (props) =>
					control === "expand"
						? props["aria-expanded"] === true
						: props["aria-label"] === control && props["aria-expanded"] === undefined,
				);
	assert.notEqual(target.props.disabled, true);
	const surface = element(view.panel, "search");
	const stopPropagation = dispatchEscape(outer, surface, { retargeted: true, target: target.props });
	assert.equal(stopPropagation.mock.calls.length, 1);
	assert.equal(focus.mock.calls.length, 1);
	assert.throws(() => element(render().panel, "search"));
	// Once focus returns to the editor, the next Escape remains unclaimed for Radix.
	const editorEscape = new EscapeEvent([new Surface(), outer.node]);
	Reflect.apply(outer.onEscapeKeyDown, undefined, [editorEscape]);
	assert.equal(editorEscape.defaultPrevented, false);
});

test.each(["Line and column", "Go", "Cancel line navigation"])(
	"Go-to-line Escape from %s restores the captured view, returns focus, and leaves the narrow file panel open",
	(control) => {
		const outer = narrowPanel();
		const document = new TextDocument("file", "first\nsecond");
		const focus = vi.fn();
		const restore = vi.fn();
		const preview = vi.fn();
		const render = component(() =>
			useFileLineNavigation({
				bindings: DEFAULT_EDITOR_KEYBINDINGS,
				getTarget: () => ({
					identity: document,
					document,
					generation: document.version,
					capture: () => ({ offset: 0, state: "original selection and scroll" }),
					preview,
					restore,
					focus,
				}),
			}),
		);
		render().open();
		const input = element(render().panel, Input);
		assert.ok(input.props.onChange);
		Reflect.apply(input.props.onChange, undefined, [{ currentTarget: { value: "2" }, nativeEvent: {} }]);
		assert.deepEqual(preview.mock.lastCall, [{ line: 1, character: 0 }]);
		const target =
			control === "Line and column"
				? element(render().panel, Input)
				: element(render().panel, Button, (props) => props["aria-label"] === control);
		assert.equal(
			dispatchEscape(outer, element(render().panel, "fieldset"), { target: target.props }).mock.calls.length,
			1,
		);
		assert.deepEqual(restore.mock.lastCall, ["original selection and scroll"]);
		assert.equal(focus.mock.calls.length, 1);
		assert.throws(() => element(render().panel, "fieldset"));
		assert.equal(document.getText(), "first\nsecond");
		assert.equal(document.canUndo, false);
	},
);

test("closing Find by button retires its composition session before reopening", () => {
	const outer = narrowPanel();
	const document = new TextDocument("file", "text");
	const focus = vi.fn();
	const render = component(() =>
		useFileSearch({ document, text: document.getText(), bindings: DEFAULT_EDITOR_KEYBINDINGS, select: vi.fn(), focus }),
	);
	render().open();
	const surface = element(render().panel, "search");
	assert.ok(surface.props.onCompositionStart);
	Reflect.apply(surface.props.onCompositionStart, undefined, [{}]);
	const close = element(render().panel, Button, (props) => props["aria-label"] === "Close find");
	assert.ok(close.props.onClick);
	Reflect.apply(close.props.onClick, undefined, [{}]);
	assert.throws(() => element(render().panel, "search"));
	render().open();
	assert.equal(dispatchEscape(outer, element(render().panel, "search")).mock.calls.length, 1);
	assert.throws(() => element(render().panel, "search"));
	assert.equal(focus.mock.calls.length, 2);
});

test.each(["find", "go-to-line"] as const)(
	"%s composition Escape (native flag, legacy 229, or composition session) never closes either surface",
	(kind) => {
		const outer = narrowPanel();
		const document = new TextDocument("file", "first\nsecond");
		const focus = vi.fn();
		const restore = vi.fn();
		const render =
			kind === "find"
				? component(() =>
						useFileSearch({
							document,
							text: document.getText(),
							bindings: DEFAULT_EDITOR_KEYBINDINGS,
							select: vi.fn(),
							focus,
						}),
					)
				: component(() =>
						useFileLineNavigation({
							bindings: DEFAULT_EDITOR_KEYBINDINGS,
							getTarget: () => ({
								identity: document,
								document,
								generation: document.version,
								capture: () => ({ offset: 0, state: "original" }),
								preview: vi.fn(),
								restore,
								focus,
							}),
						}),
					);
		render().open();
		const surface = () => element(render().panel, kind === "find" ? "search" : "fieldset");
		for (const options of [{ composing: true }, { keyCode: 229 }]) {
			assert.equal(dispatchEscape(outer, surface(), options).mock.calls.length, 0);
			assert.ok(surface());
		}
		const composition = kind === "find" ? surface() : element(render().panel, Input);
		assert.ok(composition.props.onCompositionStart);
		Reflect.apply(composition.props.onCompositionStart, undefined, [{}]);
		assert.equal(dispatchEscape(outer, surface()).mock.calls.length, 0);
		assert.ok(surface());
		assert.equal(focus.mock.calls.length, 0);
		assert.equal(restore.mock.calls.length, 0);
		assert.ok(composition.props.onCompositionEnd);
		Reflect.apply(composition.props.onCompositionEnd, undefined, [{ currentTarget: { value: "2" } }]);
		assert.equal(dispatchEscape(outer, surface()).mock.calls.length, 1);
		assert.equal(focus.mock.calls.length, 1);
		assert.equal(restore.mock.calls.length, kind === "go-to-line" ? 1 : 0);
		assert.throws(surface);
	},
);
