import assert from "node:assert/strict";
import { TextDocument } from "@pierre/diffs/edit";
import type * as React from "react";
import { isValidElement } from "react";
import { beforeEach, test, vi } from "vitest";
import { defaultConfig } from "../src/app/theme/config.ts";
import { Input } from "../src/components/ui/input.tsx";
import { DEFAULT_EDITOR_KEYBINDINGS } from "../src/features/files/editor-keybindings.ts";
import {
	type FileLineNavigationTarget,
	parseFileLinePosition,
	useFileLineNavigation,
} from "../src/features/files/file-line-navigation.tsx";
import { PierreCodeEditor } from "../src/features/files/pierre-editor.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	pending: [] as (() => void)[],
	changed: false,
	locale: "en",
}));
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const changed = (left: React.DependencyList | undefined, right: React.DependencyList) =>
		!left || left.length !== right.length || right.some((value, index) => !Object.is(value, left[index]));
	return {
		...actual,
		useState: (initial: unknown) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: typeof initial === "function" ? initial() : initial };
			hooks.cells[index] = cell;
			return [
				cell.value,
				(value: unknown) => {
					const next = typeof value === "function" ? value(cell.value) : value;
					hooks.changed ||= !Object.is(cell.value, next);
					cell.value = next;
				},
			];
		},
		useRef: (initial: unknown) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: { current: initial } };
			return hooks.cells[index]?.value;
		},
		useMemo: (create: () => unknown, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			if (changed(hooks.cells[index]?.deps, deps)) hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useEffect: (effect: () => (() => void) | undefined, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			if (changed(hooks.cells[index]?.deps, deps)) {
				const old = hooks.cells[index];
				const cell: Cell = { value: undefined, deps };
				hooks.cells[index] = cell;
				hooks.pending.push(() => {
					old?.cleanup?.();
					cell.cleanup = effect();
				});
			}
		},
	};
});
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: hooks.locale }) }));
vi.mock("../src/app/theme/index.ts", () => ({ useThemeSettings: () => ({ config: defaultConfig }) }));
beforeEach(() => {
	for (const cell of hooks.cells) cell.cleanup?.();
	hooks.cells = [];
	hooks.cursor = 0;
	hooks.pending = [];
	hooks.changed = false;
	hooks.locale = "en";
});
function drive<T>(render: () => T): T {
	for (let count = 0; count < 10; count++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const value = render();
		for (const commit of hooks.pending.splice(0)) commit();
		if (!hooks.changed) return value;
	}
	throw new Error("Render did not settle");
}
function element(
	node: React.ReactNode,
	predicate: (value: React.ReactElement<Record<string, unknown>>) => boolean,
): React.ReactElement<Record<string, unknown>> {
	if (isValidElement<Record<string, unknown>>(node)) {
		if (predicate(node)) return node;
		const children = node.props.children;
		for (const child of (Array.isArray(children) ? children.flat(Infinity) : [children]) as React.ReactNode[]) {
			try {
				return element(child, predicate);
			} catch {
				/* Continue through siblings. */
			}
		}
	}
	throw new Error("Element missing");
}
function key(key: string, composing = false, code = 0, ctrl = false, alt = false) {
	return {
		key,
		shiftKey: false,
		ctrlKey: ctrl,
		metaKey: false,
		altKey: alt,
		nativeEvent: { key, code: key, isComposing: composing, keyCode: code },
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as React.KeyboardEvent;
}
function callback(node: React.ReactElement<Record<string, unknown>>, name: string) {
	return node.props[name] as (event?: unknown) => void;
}
function fixture() {
	let document = new TextDocument("file", "first\r\nsecond line\r\nlast", "text");
	let identity: object = {};
	const original = { selection: [2, 4], scrollTop: 40, scrollLeft: 18 };
	const capture = vi.fn(() => ({ offset: 2, state: original }));
	const preview = vi.fn();
	const restore = vi.fn();
	const focus = vi.fn();
	const render = () =>
		useFileLineNavigation({
			bindings: DEFAULT_EDITOR_KEYBINDINGS,
			getTarget: (): FileLineNavigationTarget<typeof original> => ({
				identity,
				document,
				generation: document.version,
				capture,
				preview,
				restore,
				focus,
			}),
		});
	let view = drive(render);
	const refresh = () => {
		view = drive(render);
		return view;
	};
	return {
		original,
		capture,
		preview,
		restore,
		focus,
		document,
		refresh,
		open: () => {
			view.open();
			refresh();
		},
		input: () => element(view.panel, (item) => item.type === Input),
		change: (value: string, isComposing = false) => {
			callback(
				element(view.panel, (item) => item.type === Input),
				"onChange",
			)({
				currentTarget: { value },
				nativeEvent: { isComposing },
			});
			refresh();
		},
		press: (event: React.KeyboardEvent) =>
			callback(
				element(view.panel, (item) => item.type === Input),
				"onKeyDown",
			)(event),
		cancel: () =>
			callback(
				element(view.panel, (item) => item.type === "fieldset"),
				"onKeyDown",
			)(key("Escape")),
		replaceEditor: () => {
			identity = {};
		},
		replaceDocument: () => {
			document = new TextDocument("file", document.getText(), "text");
		},
	};
}

test("line parsing validates whole numeric coordinates and clamps lines and UTF-16 columns with CRLF and empty files", () => {
	const document = new TextDocument("file", "ab\r\n😀x\r\n");
	for (const [value, position] of [
		["1", { line: 0, character: 0 }],
		[" 2 : 3 ", { line: 1, character: 2 }],
		["0:0", { line: 0, character: 0 }],
		["2:999", { line: 1, character: 3 }],
		["999:999", { line: 2, character: 0 }],
	] as const)
		assert.deepEqual(parseFileLinePosition(value, document), position);
	for (const value of ["", " ", "1:", ":2", "1.5", "1e3", "1:2:3", "-1", "Infinity", "9007199254740992", "中文"])
		assert.equal(parseFileLinePosition(value, document), undefined);
	assert.deepEqual(parseFileLinePosition("8:8", new TextDocument("empty", "")), { line: 0, character: 0 });
});

test("production hook previews without focus and Escape restores exactly the one captured view without changing text", () => {
	const editor = fixture();
	editor.open();
	assert.equal(editor.input().props.value, "1:3");
	editor.change("2:4");
	editor.change("3:99");
	editor.refresh().open();
	assert.equal(editor.capture.mock.calls.length, 1);
	assert.deepEqual(editor.preview.mock.calls, [[{ line: 1, character: 3 }], [{ line: 2, character: 4 }]]);
	assert.equal(editor.focus.mock.calls.length, 0);
	assert.equal(editor.restore.mock.calls.length, 0);
	editor.cancel();
	assert.deepEqual(editor.restore.mock.lastCall, [editor.original]);
	assert.equal(editor.focus.mock.calls.length, 1);
	assert.equal(editor.document.getText(), "first\r\nsecond line\r\nlast");
	assert.equal(editor.document.canUndo, false);
	assert.throws(() => element(editor.refresh().panel, (item) => item.type === Input));
});

test("invalid input and IME never navigate or commit; Enter commits the valid destination without restoration", () => {
	const editor = fixture();
	editor.open();
	editor.change("2.4");
	assert.equal(editor.input().props["aria-invalid"], true);
	editor.press(key("Enter"));
	assert.equal(editor.preview.mock.calls.length, 0);
	assert.equal(editor.focus.mock.calls.length, 0);
	callback(editor.input(), "onCompositionStart")();
	editor.change("2");
	editor.press(key("Enter"));
	editor.cancel();
	assert.equal(editor.preview.mock.calls.length, 0);
	callback(editor.input(), "onCompositionEnd")({ currentTarget: { value: "2" } });
	editor.refresh();
	assert.equal(editor.preview.mock.calls.length, 1);
	editor.change("3", true);
	editor.press(key("Enter", true));
	editor.press(key("Enter", false, 229));
	assert.equal(editor.preview.mock.calls.length, 1);
	editor.change("2:3");
	editor.press(key("Enter"));
	assert.deepEqual(editor.preview.mock.lastCall, [{ line: 1, character: 2 }]);
	assert.equal(editor.restore.mock.calls.length, 0);
	assert.equal(editor.focus.mock.calls.length, 1);
	assert.throws(() => element(editor.refresh().panel, (item) => item.type === Input));
});

test.each(["edit", "editor", "document"] as const)(
	"stale %s invalidates preview and cancellation instead of restoring an old selection or scroll",
	(change) => {
		const editor = fixture();
		editor.open();
		editor.change("2");
		if (change === "edit") {
			editor.document.applyResolvedEdits([{ start: 0, end: 0, text: "new\n" }]);
		} else if (change === "editor") editor.replaceEditor();
		else editor.replaceDocument();
		editor.press(key("Enter"));
		assert.equal(editor.preview.mock.calls.length, 1);
		assert.equal(editor.focus.mock.calls.length, 0);
		editor.refresh();
		assert.equal(
			element(editor.refresh().panel, (item) => item.props.role === "alert").props.children,
			"The document changed. Reopen Go to line to continue.",
		);
		editor.cancel();
		assert.equal(editor.restore.mock.calls.length, 0);
		assert.equal(editor.focus.mock.calls.length, 0);
	},
);

test("closing an untouched preview and unmounting never restore or act on a stale editor", () => {
	const editor = fixture();
	editor.open();
	editor.cancel();
	assert.equal(editor.restore.mock.calls.length, 0);
	editor.refresh();
	editor.open();
	editor.change("2");
	const retained = editor.refresh();
	for (const cell of hooks.cells) cell.cleanup?.();
	retained.open();
	editor.press(key("Enter"));
	editor.cancel();
	assert.equal(editor.capture.mock.calls.length, 2);
	assert.equal(editor.preview.mock.calls.length, 1);
	assert.equal(editor.restore.mock.calls.length, 0);
});

test("configurable navigation shortcuts do not claim Find again, composing keys, or unrelated keys; labels follow locale", () => {
	hooks.locale = "zh-CN";
	const document = new TextDocument("file", "text");
	const render = () =>
		useFileLineNavigation({
			bindings: { ...DEFAULT_EDITOR_KEYBINDINGS, goToLine: "Ctrl-Shift-l" },
			getTarget: () => ({
				identity: document,
				document,
				generation: document.version,
				capture: () => ({ offset: 0, state: undefined }),
				preview: vi.fn(),
				restore: vi.fn(),
				focus: vi.fn(),
			}),
		});
	const view = drive(render);
	for (const event of [key("g", false, 0, true), key("l", true, 0, true), key("l", false, 229, true), key("x")]) {
		assert.equal(view.onKeyDown(event), false);
		assert.equal(vi.mocked(event.preventDefault).mock.calls.length, 0);
	}
	assert.equal(view.onKeyDown({ ...key("l", false, 0, true), shiftKey: true }), true);
	const panel = drive(render).panel;
	assert.ok(element(panel, (item) => item.props["aria-label"] === "跳转到行"));
	assert.ok(element(panel, (item) => item.type === Input && item.props["aria-label"] === "行与列"));
});

test("Pierre production capture uses public state and centered reveal APIs, never text writes or saves", () => {
	const onChange = vi.fn();
	const onSave = vi.fn();
	const props = { text: "first\nsecond", name: "file.txt", label: "Editor", readOnly: false, onChange, onSave };
	const snapshot = {
		selections: [{ start: { line: 0, character: 1 }, end: { line: 0, character: 3 }, direction: -1 }],
		view: { scrollTop: 80, scrollLeft: 12 },
	};
	const editor = {
		getViewState: vi.fn(() => snapshot),
		setViewState: vi.fn(),
		setSelections: vi.fn(),
		focus: vi.fn(),
	};
	const controller = { getEditor: () => editor, getSelectedLines: () => null, scrollTo: vi.fn() };
	const render = () => {
		const surface = PierreCodeEditor(props);
		return (surface.type as (props: typeof surface.props) => React.ReactNode)(surface.props);
	};
	let tree = drive(render);
	const code = element(tree, (item) => Array.isArray(item.props.initialItems));
	(code.props.ref as React.RefObject<unknown>).current = controller;
	(code.props.containerRef as React.RefObject<unknown>).current = { scrollTop: 80, scrollLeft: 0 };
	const capture = callback(
		element(tree, (item) => item.type === "section" && item.props["data-readonly"] === false),
		"onKeyDownCapture",
	);
	capture(key("g", true, 0, true, true));
	capture(key("g", false, 229, true, true));
	assert.equal(editor.getViewState.mock.calls.length, 0);
	capture(key("g", false, 0, true, true));
	tree = drive(render);
	callback(
		element(tree, (item) => item.type === Input),
		"onChange",
	)({
		currentTarget: { value: "2:4" },
		nativeEvent: {},
	});
	tree = drive(render);
	assert.deepEqual(editor.setSelections.mock.lastCall, [
		[{ start: { line: 1, character: 3 }, end: { line: 1, character: 3 }, direction: "none" }],
	]);
	assert.deepEqual(controller.scrollTo.mock.lastCall, [
		{ type: "line", id: "document", lineNumber: 2, align: "center", behavior: "instant" },
	]);
	assert.equal(editor.focus.mock.calls.length, 0);
	callback(
		element(tree, (item) => item.type === "fieldset"),
		"onKeyDown",
	)(key("Escape"));
	assert.deepEqual(editor.setViewState.mock.lastCall, [snapshot]);
	assert.deepEqual(editor.focus.mock.lastCall, [{ preventScroll: true }]);
	assert.equal(onChange.mock.calls.length, 0);
	assert.equal(onSave.mock.calls.length, 0);
	// Pierre versions rewind on undo. The real change callback must still invalidate the preview.
	tree = drive(render);
	capture(key("g", false, 0, true, true));
	tree = drive(render);
	callback(
		element(tree, (item) => item.type === Input),
		"onChange",
	)({
		currentTarget: { value: "2" },
		nativeEvent: {},
	});
	const document = (code.props.editorOptions as { initialState: { document: TextDocument } }).initialState.document;
	const version = document.version;
	document.applyResolvedEdits([{ start: 0, end: 0, text: "new\n" }]);
	callback(code, "onItemEditChange")({ file: { contents: document.getText() } });
	document.undo();
	callback(code, "onItemEditChange")({ file: { contents: document.getText() } });
	assert.equal(document.version, version);
	tree = drive(render);
	callback(
		element(tree, (item) => item.type === "fieldset"),
		"onKeyDown",
	)(key("Escape"));
	assert.equal(editor.setViewState.mock.calls.length, 1);
	assert.equal(editor.focus.mock.calls.length, 1);
	assert.equal(onSave.mock.calls.length, 0);
});

test("read-only Pierre reveals a whole line through public selection and restores the original viewport without editing", () => {
	const onChange = vi.fn();
	const onSave = vi.fn();
	const props = { text: "first\nsecond", name: "file.txt", label: "Editor", readOnly: true, onChange, onSave };
	const original = { id: "document", range: { start: 1, end: 1 } };
	const controller = {
		getEditor: () => undefined,
		getSelectedLines: () => original,
		setSelectedLines: vi.fn(),
		scrollTo: vi.fn(),
	};
	const render = () => {
		const surface = PierreCodeEditor(props);
		return (surface.type as (props: typeof surface.props) => React.ReactNode)(surface.props);
	};
	let tree = drive(render);
	const code = element(tree, (item) => Array.isArray(item.props.initialItems));
	(code.props.ref as React.RefObject<unknown>).current = controller;
	const scroll = { scrollTop: 60, scrollLeft: 10 };
	(code.props.containerRef as React.RefObject<unknown>).current = scroll;
	const section = element(tree, (item) => item.type === "section" && item.props["data-readonly"] === true);
	const focus = vi.fn();
	(section.props.ref as React.RefObject<unknown>).current = { focus };
	assert.equal(section.props.tabIndex, 0);
	callback(section, "onKeyDownCapture")(key("g", false, 0, true, true));
	tree = drive(render);
	callback(
		element(tree, (item) => item.type === Input),
		"onChange",
	)({
		currentTarget: { value: "9" },
		nativeEvent: {},
	});
	assert.deepEqual(controller.setSelectedLines.mock.lastCall, [{ id: "document", range: { start: 2, end: 2 } }]);
	scroll.scrollTop = 90;
	scroll.scrollLeft = 20;
	tree = drive(render);
	callback(
		element(tree, (item) => item.type === "fieldset"),
		"onKeyDown",
	)(key("Escape"));
	assert.deepEqual(controller.setSelectedLines.mock.lastCall, [original]);
	assert.deepEqual(controller.scrollTo.mock.lastCall, [{ type: "position", position: 60, behavior: "instant" }]);
	assert.deepEqual(scroll, { scrollTop: 60, scrollLeft: 10 });
	assert.deepEqual(focus.mock.lastCall, [{ preventScroll: true }]);
	assert.equal(onChange.mock.calls.length, 0);
	assert.equal(onSave.mock.calls.length, 0);
});
