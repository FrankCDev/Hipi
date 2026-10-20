import assert from "node:assert/strict";
import { TextDocument } from "@pierre/diffs/edit";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { defaultConfig } from "../src/app/theme/config.ts";
import { Input } from "../src/components/ui/input.tsx";
import { DEFAULT_EDITOR_KEYBINDINGS } from "../src/features/files/editor-keybindings.ts";
import { useFileSearch } from "../src/features/files/file-search.tsx";
import { PierreCodeEditor } from "../src/features/files/pierre-editor.tsx";

// Pin the browser platform rather than inheriting Node's host-dependent navigator.
const shortcutPlatforms = [
	{ platform: "MacIntel", ctrl: false, meta: true },
	{ platform: "Win32", ctrl: true, meta: false },
	{ platform: "Linux x86_64", ctrl: true, meta: false },
];
afterEach(() => vi.unstubAllGlobals());

type Cell = { value: unknown; deps?: React.DependencyList };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, pending: [] as (() => void)[], changed: false }));
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
		useEffect: (effect: () => void, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			if (changed(hooks.cells[index]?.deps, deps)) {
				hooks.cells[index] = { value: undefined, deps };
				hooks.pending.push(effect);
			}
		},
	};
});
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../src/app/theme/index.ts", () => ({ useThemeSettings: () => ({ config: defaultConfig }) }));
beforeEach(() => {
	hooks.cells = [];
	hooks.cursor = 0;
	hooks.pending = [];
	hooks.changed = false;
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
		for (const child of ReactChildren(node.props.children)) {
			try {
				return element(child, predicate);
			} catch {
				/* Continue through siblings. */
			}
		}
	}
	throw new Error("Element missing");
}
function ReactChildren(value: unknown): React.ReactNode[] {
	return (Array.isArray(value) ? value.flat(Infinity) : [value]) as React.ReactNode[];
}
function key(key: string, composing = false, code = 0, ctrl = false, meta = false) {
	return {
		key,
		shiftKey: false,
		ctrlKey: ctrl,
		metaKey: meta,
		altKey: false,
		nativeEvent: {
			key,
			code: key,
			isComposing: composing,
			keyCode: code,
			shiftKey: false,
			ctrlKey: ctrl,
			metaKey: meta,
			altKey: false,
		},
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	};
}
test("shared search uses public matching options, selects the first result, wraps, and preserves exact tab preferences", () => {
	const text = "Cat cat scatter\ncat";
	const document = new TextDocument("file", text, "text");
	const selection = vi.fn();
	const focus = vi.fn();
	const memory = {};
	const render = () =>
		useFileSearch({ document, text, bindings: DEFAULT_EDITOR_KEYBINDINGS, select: selection, focus, memory });
	let view = drive(render);
	view.open();
	view = drive(render);
	const input = () => element(view.panel, (item) => item.type === Input).props;
	(input().onChange as (event: unknown) => void)({ currentTarget: { value: "cat" } });
	view = drive(render);
	assert.equal(element(view.panel, (item) => item.type === "output").props.children, "4 matches");
	(input().onKeyDown as (event: unknown) => void)(key("Enter", true));
	(input().onKeyDown as (event: unknown) => void)(key("Enter", false, 229));
	assert.equal(selection.mock.calls.length, 0);
	(input().onKeyDown as (event: unknown) => void)(key("Enter"));
	assert.deepEqual(selection.mock.lastCall, [[0, 3]]);
	view = drive(render);
	const click = (label: string) =>
		(element(view.panel, (item) => item.props["aria-label"] === label).props.onClick as () => void)();
	click("Previous match");
	assert.deepEqual(selection.mock.lastCall, [[16, 19]]);
	click("Whole word");
	view = drive(render);
	assert.equal(element(view.panel, (item) => item.type === "output").props.children, "3 matches");
	click("Match case");
	view = drive(render);
	assert.equal(element(view.panel, (item) => item.type === "output").props.children, "2 matches");
	click("Regular expression");
	view = drive(render);
	(input().onChange as (event: unknown) => void)({ currentTarget: { value: "[" } });
	view = drive(render);
	assert.equal(input()["aria-invalid"], true);
	assert.equal(element(view.panel, (item) => item.type === "output").props.children, "Invalid search expression");
	click("Close find");
	assert.equal(focus.mock.calls.length, 1);
	assert.deepEqual(memory, { search: { query: "[", caseSensitive: true, wholeWord: true, regex: true } });
});

test.each(shortcutPlatforms)(
	"Pierre production capture never saves or opens Find during IME and passes the real filename to the accessible editor on $platform",
	({ platform, ctrl, meta }) => {
		vi.stubGlobal("navigator", { platform });
		const save = vi.fn();
		const props = {
			text: "untouched",
			name: "notes.txt",
			label: "File text editor",
			readOnly: false,
			onChange: vi.fn(),
			onSave: save,
		};
		const render = () => {
			const surface = PierreCodeEditor(props);
			assert.equal(typeof surface.type, "function");
			return (surface.type as (props: typeof surface.props) => React.ReactNode)(surface.props);
		};
		let tree = drive(render);
		const section = () => element(tree, (item) => item.type === "section" && item.props["data-readonly"] === false);
		const capture = section().props.onKeyDownCapture as (event: unknown) => void;
		for (const event of [
			key("s", false, 0, !ctrl, !meta),
			key("f", false, 0, !ctrl, !meta),
			key("s", true, 0, ctrl, meta),
			key("s", false, 229, ctrl, meta),
			key("f", true, 0, ctrl, meta),
			key("f", false, 229, ctrl, meta),
		])
			capture(event);
		tree = drive(render);
		assert.equal(save.mock.calls.length, 0);
		assert.throws(() => element(tree, (item) => item.type === "search"));
		capture(key("s", false, 0, ctrl, meta));
		assert.equal(save.mock.calls.length, 1);
		capture(key("f", false, 0, ctrl, meta));
		tree = drive(render);
		assert.ok(element(tree, (item) => item.type === "search"));
		const code = element(tree, (item) => Array.isArray(item.props.initialItems));
		assert.deepEqual(
			(code.props.initialItems as { file: { name: string } }[]).map((item) => item.file.name),
			["notes.txt"],
		);
		assert.equal(section().props["aria-label"], "File text editor");
	},
);

test("replacement callbacks preserve IME and read-only boundaries and reject a stale document projection", () => {
	const document = new TextDocument("file", "one one");
	const replace = vi.fn();
	let readOnly = false;
	let text = document.getText();
	const render = () =>
		useFileSearch({
			document,
			text,
			bindings: DEFAULT_EDITOR_KEYBINDINGS,
			select: vi.fn(),
			focus: vi.fn(),
			replace,
			readOnly,
		});
	let view = drive(render);
	view.open();
	view = drive(render);
	const query = element(view.panel, (item) => item.type === Input && item.props["aria-label"] === "Find in file");
	(query.props.onChange as (event: unknown) => void)({ currentTarget: { value: "one" } });
	view = drive(render);
	(element(view.panel, (item) => item.props["aria-expanded"] === false).props.onClick as () => void)();
	view = drive(render);
	const replacement = () =>
		element(view.panel, (item) => item.type === Input && item.props["aria-label"] === "Replace");
	(replacement().props.onChange as (event: unknown) => void)({ currentTarget: { value: "two" } });
	view = drive(render);
	(replacement().props.onKeyDown as (event: unknown) => void)(key("Enter", true));
	assert.equal(replace.mock.calls.length, 0);
	(replacement().props.onKeyDown as (event: unknown) => void)(key("Enter"));
	assert.deepEqual(replace.mock.lastCall?.[0], [{ from: 0, to: 3, text: "two" }]);
	readOnly = true;
	view = drive(render);
	const all = () => element(view.panel, (item) => item.props["aria-label"] === "Replace all");
	assert.equal(all().props.disabled, true);
	(all().props.onClick as () => void)();
	assert.equal(replace.mock.calls.length, 1);
	readOnly = false;
	view = drive(render);
	document.applyResolvedEdits([{ start: 0, end: 0, text: "new " }]);
	(all().props.onClick as () => void)();
	assert.equal(replace.mock.calls.length, 1);
	text = document.getText();
	view = drive(render);
	(all().props.onClick as () => void)();
	assert.deepEqual(replace.mock.lastCall?.[0], [
		{ from: 4, to: 7, text: "two" },
		{ from: 8, to: 11, text: "two" },
	]);
});

test.each(shortcutPlatforms)(
	"replace-all allocation is bounded before a transaction and reports the existing localized editor limit on $platform",
	({ platform, ctrl, meta }) => {
		vi.stubGlobal("navigator", { platform });
		const text = "a".repeat(1000);
		const document = new TextDocument("file", text);
		const replace = vi.fn();
		const render = () =>
			useFileSearch({
				document,
				text,
				bindings: DEFAULT_EDITOR_KEYBINDINGS,
				select: vi.fn(),
				focus: vi.fn(),
				replace,
			});
		let view = drive(render);
		view.onKeyDown({ ...key("f", false, 0, ctrl, meta), altKey: true } as unknown as React.KeyboardEvent);
		view = drive(render);
		const input = (label: string) =>
			element(view.panel, (item) => item.type === Input && item.props["aria-label"] === label);
		(input("Find in file").props.onChange as (event: unknown) => void)({ currentTarget: { value: "a" } });
		(input("Replace").props.onChange as (event: unknown) => void)({ currentTarget: { value: "b".repeat(1024) } });
		view = drive(render);
		(element(view.panel, (item) => item.props["aria-label"] === "Replace all").props.onClick as () => void)();
		view = drive(render);
		assert.equal(replace.mock.calls.length, 0);
		assert.ok(element(view.panel, (item) => item.props.role === "alert"));
	},
);

test.each(shortcutPlatforms)(
	"typing replacement text retains the selected second match and recoverable stale transactions never escape on $platform",
	({ platform, ctrl, meta }) => {
		vi.stubGlobal("navigator", { platform });
		const document = new TextDocument("file", "one one");
		const replace = vi.fn();
		const render = () =>
			useFileSearch({
				document,
				text: document.getText(),
				bindings: DEFAULT_EDITOR_KEYBINDINGS,
				select: vi.fn(),
				focus: vi.fn(),
				replace,
			});
		let view = drive(render);
		view.onKeyDown({ ...key("f", false, 0, ctrl, meta), altKey: true } as unknown as React.KeyboardEvent);
		view = drive(render);
		const input = (label: string) =>
			element(view.panel, (item) => item.type === Input && item.props["aria-label"] === label);
		(input("Find in file").props.onChange as (event: unknown) => void)({ currentTarget: { value: "one" } });
		view = drive(render);
		for (let index = 0; index < 2; index++) {
			(input("Find in file").props.onKeyDown as (event: unknown) => void)(key("Enter"));
			view = drive(render);
		}
		assert.equal(element(view.panel, (item) => item.type === "output").props.children, "2 / 2");
		(input("Replace").props.onChange as (event: unknown) => void)({ currentTarget: { value: "two" } });
		view = drive(render);
		assert.equal(element(view.panel, (item) => item.type === "output").props.children, "2 / 2");
		(input("Replace").props.onKeyDown as (event: unknown) => void)(key("Enter"));
		assert.deepEqual(replace.mock.lastCall?.[0], [{ from: 4, to: 7, text: "two" }]);
		replace.mockImplementation(() => {
			throw new Error("Search document changed");
		});
		assert.doesNotThrow(() => (input("Replace").props.onKeyDown as (event: unknown) => void)(key("Enter")));
		view = drive(render);
		assert.equal(
			element(view.panel, (item) => item.props.role === "alert").props.children,
			"The document changed. Search again before replacing.",
		);
	},
);

test.each([false, true])(
	"Pierre Find cancellation returns focus without scrolling or editing when readOnly is %s",
	(readOnly) => {
		const editorFocus = vi.fn();
		const sectionFocus = vi.fn();
		const onChange = vi.fn();
		const onSave = vi.fn();
		const props = { text: "first\nsecond", name: "file.txt", label: "Editor", readOnly, onChange, onSave };
		const render = () => {
			const surface = PierreCodeEditor(props);
			return (surface.type as (props: typeof surface.props) => React.ReactNode)(surface.props);
		};
		let tree = drive(render);
		const code = element(tree, (item) => Array.isArray(item.props.initialItems));
		(code.props.ref as React.RefObject<unknown>).current = {
			getEditor: () => (readOnly ? undefined : { focus: editorFocus }),
		};
		const section = element(tree, (item) => item.type === "section");
		(section.props.ref as React.RefObject<unknown>).current = { focus: sectionFocus };
		(element(tree, (item) => item.props["aria-label"] === "Find in file").props.onClick as () => void)();
		tree = drive(render);
		(element(tree, (item) => item.type === "search").props.onKeyDown as (event: unknown) => void)(key("Escape"));
		assert.deepEqual((readOnly ? sectionFocus : editorFocus).mock.calls, [[{ preventScroll: true }]]);
		assert.equal((readOnly ? editorFocus : sectionFocus).mock.calls.length, 0);
		assert.throws(() => element(drive(render), (item) => item.type === "search"));
		assert.equal(onChange.mock.calls.length, 0);
		assert.equal(onSave.mock.calls.length, 0);
	},
);
