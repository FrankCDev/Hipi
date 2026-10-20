import assert from "node:assert/strict";
import { undo } from "@codemirror/commands";
import type { EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import type * as CodeMirror from "@codemirror/view";
import { FILE_LIMITS, FileServiceError } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../../../../src/components/ui/button.tsx";
import { Input } from "../../../../src/components/ui/input.tsx";
import { CodeDiff, CodeEditor } from "../../../../src/features/files/code-editor.tsx";
import type { EditorViewMemory } from "../../../../src/features/files/editor-view-memory.ts";
import { FileBuffer } from "../../../../src/features/files/file-buffer.tsx";
import { FileWorkspaceSession } from "../../../../src/features/files/file-workspace-session.ts";
import { MarkdownEditor } from "../../../../src/features/files/markdown-editor.tsx";
import { markdownFileText } from "../../../../src/features/files/markdown-line-endings.ts";
import { MarkdownPreview } from "../../../../src/features/files/markdown-preview.tsx";
import { ClipboardCopy } from "../../../../src/features/workbench/conversation/markdown/clipboard-copy.tsx";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
type View = {
	state: EditorState;
	scrollDOM: { scrollTop: number; scrollLeft: number };
	dispatch: (value: TransactionSpec | Transaction) => void;
	destroyed: boolean;
};
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
const views = vi.hoisted(() => [] as View[]);
// Production callbacks/effects, with a minimal host adapter around real CM state,
// parser and history. This is not a browser layout, focus or IME acceptance test.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const changed = (old: React.DependencyList | undefined, next: React.DependencyList) =>
		!old || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
	return {
		...actual,
		useId: () => `test-${hooks.cursor++}`,
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = cell;
			return [
				cell.value,
				(next: T | ((value: T) => T)) => {
					const value = typeof next === "function" ? (next as (value: T) => T)(cell.value as T) : next;
					hooks.changed ||= !Object.is(cell.value, value);
					cell.value = value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: { current: initial } };
			return hooks.cells[index]?.value;
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			if (changed(hooks.cells[index]?.deps, deps)) hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const old = hooks.cells[index];
			if (changed(old?.deps, deps))
				hooks.commits.push(() => {
					old?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
});
vi.mock("@codemirror/view", async () => {
	const actual = await vi.importActual<typeof CodeMirror>("@codemirror/view");
	class HostView implements View {
		static theme = actual.EditorView.theme;
		static updateListener = actual.EditorView.updateListener;
		static editable = actual.EditorView.editable;
		static contentAttributes = actual.EditorView.contentAttributes;
		static lineWrapping = actual.EditorView.lineWrapping;
		static scrollIntoView = actual.EditorView.scrollIntoView;
		state: EditorState;
		scrollDOM = { scrollTop: 0, scrollLeft: 0 };
		destroyed = false;
		contentDOM = { focus: vi.fn() };
		constructor(config: CodeMirror.EditorViewConfig) {
			assert.ok(config.state);
			this.state = config.state;
			views.push(this);
		}
		dispatch = (spec: TransactionSpec | Transaction) => {
			const transaction = "startState" in spec ? spec : this.state.update(spec);
			this.state = transaction.state;
			for (const listener of this.state.facet(actual.EditorView.updateListener))
				listener({
					docChanged: transaction.docChanged,
					state: this.state,
					transactions: [transaction],
				} as CodeMirror.ViewUpdate);
		};
		focus() {}
		scrollSnapshot() {
			return actual.EditorView.scrollIntoView(this.state.selection.main);
		}
		destroy() {
			this.destroyed = true;
		}
	}
	return { ...actual, EditorView: HostView };
});
let locale = "en";
vi.mock("../../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale }) }));
const saves = vi.fn<FileClient["saveText"]>();
const files: FileClient = {
	listRoots: async () => [],
	list: async () => ({ entries: [], nextCursor: null }),
	readText: async () => ({ text: "# Original", revision: "a".repeat(64), bytes: 10, encoding: "utf-8" }),
	saveText: saves,
	preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
};
let session: FileWorkspaceSession;
function resetHooks() {
	for (const cell of hooks.cells) cell.cleanup?.();
	hooks.cells = [];
	hooks.commits = [];
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
function drive(render: () => React.ReactNode, attach?: (tree: React.ReactNode) => void) {
	for (let attempt = 0; attempt < 10; attempt++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const tree = render();
		attach?.(tree);
		for (const commit of hooks.commits.splice(0)) commit();
		if (!hooks.changed) return tree;
	}
	throw new Error("Effects did not settle");
}
function press(tree: React.ReactNode, label: string) {
	const button = elements(tree, Button).find((item) => item.props.children === label);
	assert.ok(button?.props.onClick, `Missing production action: ${label}`);
	Reflect.apply(button.props.onClick, undefined, []);
}
async function open(path = "notes.md") {
	await session.open({ workspaceId: "w", rootId: "r", path }, true, { pinned: true });
	const tab = session.snapshot().tabs.at(-1);
	assert.ok(tab?.kind === "editor");
	return tab;
}
beforeEach(() => {
	vi.useFakeTimers();
	saves.mockReset();
	saves.mockRejectedValue(new FileServiceError("VERSION_CONFLICT"));
	session = new FileWorkspaceSession(files);
	session.setWorkspace("w");
	locale = "en";
});
afterEach(() => {
	resetHooks();
	views.length = 0;
	session.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test("same-tab source/preview/diff switches retain the live draft without saving, reading or replacing its owner", async () => {
	const tab = await open();
	tab.editor.edit("# Current draft");
	const snapshot = tab.editor.snapshot();
	const render = () => FileBuffer({ tab, guard: (action) => action(), retry: () => void session.retry(tab.id) });
	let tree = drive(render);
	assert.equal(elements(tree, CodeEditor)[0]?.props.text, "# Current draft");
	assert.equal(elements(tree, ClipboardCopy)[0]?.props.text, "# Current draft");
	press(tree, "Preview");
	tree = drive(render);
	assert.equal(elements(tree, MarkdownPreview)[0]?.props.text, "# Current draft");
	assert.equal(elements(tree, ClipboardCopy)[0]?.props.text, "# Current draft");
	assert.equal(elements(tree, CodeEditor).length, 0);
	assert.equal(tab.view.mode, "preview");
	assert.equal(tab.editor.snapshot(), snapshot);
	assert.equal(saves.mock.calls.length, 0);
	press(tree, "Compare changes");
	tree = drive(render);
	assert.equal(elements(tree, CodeDiff)[0]?.props.after, "# Current draft");
	press(tree, "Source");
	tree = drive(render);
	assert.equal(elements(tree, CodeEditor)[0]?.props.text, "# Current draft");
	assert.equal(tab.editor.snapshot(), snapshot);
	assert.equal(session.snapshot().tabs.length, 1);
	assert.equal(saves.mock.calls.length, 0);
});

test("preview choice survives tab/workspace hiding and does not retry conflict recovery", async () => {
	const tab = await open();
	tab.editor.edit("protected");
	await tab.editor.save();
	const snapshot = tab.editor.snapshot();
	let tree = drive(() => FileBuffer({ tab, guard: (action) => action(), retry: () => void session.retry(tab.id) }));
	press(tree, "Preview");
	drive(() => FileBuffer({ tab, guard: (action) => action(), retry: () => void session.retry(tab.id) }));
	resetHooks();
	session.setWorkspace("other");
	await vi.advanceTimersByTimeAsync(10000);
	session.setWorkspace("w");
	locale = "zh-CN";
	tree = drive(() => FileBuffer({ tab, guard: (action) => action(), retry: () => void session.retry(tab.id) }));
	assert.equal(elements(tree, MarkdownPreview)[0]?.props.text, "protected");
	assert.equal(elements(tree, Button).find((item) => item.props.children === "预览")?.props["aria-pressed"], true);
	press(tree, "源码");
	assert.equal(tab.view.mode, "source");
	assert.equal(tab.editor.snapshot(), snapshot);
	assert.equal(saves.mock.calls.length, 1);
});

test("ordinary text never exposes Markdown preview or treats a retained preview mode as an editor replacement", async () => {
	const tab = await open("notes.txt");
	tab.view.mode = "preview";
	const tree = drive(() => FileBuffer({ tab, guard: (action) => action(), retry: () => void session.retry(tab.id) }));
	assert.equal(elements(tree, MarkdownPreview).length, 0);
	assert.equal(elements(tree, CodeEditor).length, 1);
	assert.equal(
		elements(tree, Button).some((item) => item.props.children === "Preview"),
		false,
	);
});

test("preview effects retain independent scroll without touching source state or draft", () => {
	const memory: EditorViewMemory = {
		scrollTop: 73,
		scrollLeft: 11,
		markdownPreview: { scrollTop: 192, scrollLeft: 9 },
	};
	const viewport = { scrollTop: 0, scrollLeft: 0 };
	const render = () => MarkdownPreview({ text: "# Current", memory });
	const tree = drive(render, (node) => {
		const section = elements(node, "section")[0];
		assert.ok(section);
		(section.props.ref as React.RefObject<unknown>).current = viewport;
	});
	assert.deepEqual(viewport, { scrollTop: 192, scrollLeft: 9 });
	assert.equal(elements(tree, MessageMarkdown)[0]?.props.source, "# Current");
	viewport.scrollTop = 340;
	resetHooks();
	assert.deepEqual(memory.markdownPreview, { scrollTop: 340, scrollLeft: 9 });
	assert.equal(memory.scrollTop, 73);
	assert.equal(memory.scrollLeft, 11);
});

test("actual Markdown editor effects preserve undo, selection and source scroll across preview unmount/remount", () => {
	const memory: EditorViewMemory = {};
	let text = "# Original";
	const changes = vi.fn((next: string) => {
		text = next;
	});
	const render = () => MarkdownEditor({ text, onChange: changes, label: "Source", readOnly: false, memory });
	const mount = () =>
		drive(render, (tree) => {
			const host = elements(tree, "div").find((item) => item.props.className === "file-markdown-host");
			assert.ok(host);
			(host.props.ref as React.RefObject<unknown>).current = {};
		});
	mount();
	const first = views.at(-1);
	assert.ok(first);
	first.dispatch({ changes: { from: text.length, insert: "\n**draft**" }, selection: { anchor: 13 } });
	mount();
	first.scrollDOM.scrollTop = 242;
	first.scrollDOM.scrollLeft = 7;
	resetHooks();
	assert.equal(first.destroyed, true);
	assert.equal(memory.state?.selection.main.anchor, 13);
	mount();
	const restored = views.at(-1);
	assert.ok(restored && restored !== first);
	assert.equal(restored.state.doc.toString(), "# Original\n**draft**");
	assert.deepEqual(restored.scrollDOM, { scrollTop: 242, scrollLeft: 7 });
	assert.equal(restored.state.selection.main.anchor, 13);
	assert.equal(undo({ state: restored.state, dispatch: restored.dispatch }), true);
	assert.equal(text, "# Original");
	assert.equal(changes.mock.calls.length, 2);
});

test("Markdown line navigation previews and restores exact selection/scroll without editing the draft", () => {
	const text = "# one\n\nthree";
	const changes = vi.fn();
	const render = () => MarkdownEditor({ text, onChange: changes, label: "Source", readOnly: false });
	const mount = () =>
		drive(render, (tree) => {
			const host = elements(tree, "div").find((item) => item.props.className === "file-markdown-host");
			assert.ok(host);
			(host.props.ref as React.RefObject<unknown>).current = {};
		});
	let tree = mount();
	const editor = views.at(-1);
	assert.ok(editor);
	editor.dispatch({ selection: { anchor: 2, head: 4 } });
	editor.scrollDOM.scrollTop = 99;
	const open = elements(tree, Button).find((item) => item.props["aria-label"] === "Go to line");
	assert.ok(open?.props.onClick);
	Reflect.apply(open.props.onClick, undefined, []);
	tree = mount();
	const input = elements(tree, Input).find((item) => item.props["aria-label"] === "Line and column");
	assert.ok(input?.props.onChange);
	Reflect.apply(input.props.onChange, undefined, [{ currentTarget: { value: "3:2" }, nativeEvent: {} }]);
	assert.equal(editor.state.selection.main.anchor, 8);
	editor.scrollDOM.scrollTop = 400;
	tree = mount();
	const cancel = elements(tree, Button).find((item) => item.props["aria-label"] === "Cancel line navigation");
	assert.ok(cancel?.props.onClick);
	Reflect.apply(cancel.props.onClick, undefined, []);
	assert.equal(editor.state.selection.main.anchor, 2);
	assert.equal(editor.state.selection.main.head, 4);
	assert.equal(editor.scrollDOM.scrollTop, 99);
	assert.equal(changes.mock.calls.length, 0);
});

function mountMarkdown(render: () => React.ReactNode) {
	return drive(render, (tree) => {
		const host = elements(tree, "div").find((item) => item.props.className === "file-markdown-host");
		assert.ok(host);
		(host.props.ref as React.RefObject<unknown>).current = {};
	});
}

test.each([
	["CRLF", "# heading\r\nbody\r\nend\r\n"],
	["CR", "# heading\rbody\rend\r"],
	["mixed", "# heading\r\nbody\rend\n"],
])("%s open, preview, remount and reload never emit an edit or autosave", async (_name, raw) => {
	const read = vi.spyOn(files, "readText").mockResolvedValue({
		text: raw,
		revision: "a".repeat(64),
		bytes: new TextEncoder().encode(raw).length,
		encoding: "utf-8",
	});
	const tab = await open();
	const changes = vi.fn((value: string) => tab.editor.edit(value));
	let readOnly = false;
	const render = () =>
		MarkdownEditor({
			text: tab.editor.snapshot().document?.text ?? "",
			onChange: changes,
			label: "Source",
			readOnly,
			memory: tab.view,
		});
	mountMarkdown(render);
	const first = views.at(-1);
	assert.ok(first);
	assert.equal(markdownFileText(first.state), raw);
	first.dispatch({ selection: { anchor: first.state.doc.line(2).from + 2 } });
	first.scrollDOM.scrollTop = 57;
	resetHooks();
	let buffer = drive(() => FileBuffer({ tab, guard: (action) => action(), retry: () => void session.retry(tab.id) }));
	press(buffer, "Preview");
	buffer = drive(() => FileBuffer({ tab, guard: (action) => action(), retry: () => void session.retry(tab.id) }));
	assert.equal(elements(buffer, MarkdownPreview)[0]?.props.text, raw);
	resetHooks();
	drive(() => MarkdownPreview({ text: raw, memory: tab.view }));
	resetHooks();
	readOnly = true;
	mountMarkdown(render);
	const restored = views.at(-1);
	assert.ok(restored);
	assert.equal(markdownFileText(restored.state), raw);
	assert.equal(restored.state.selection.main.anchor, first.state.selection.main.anchor);
	assert.equal(restored.scrollDOM.scrollTop, 57);
	assert.equal(restored.state.readOnly, true);
	await vi.advanceTimersByTimeAsync(10000);
	assert.equal(tab.editor.protected, false);
	assert.equal(tab.editor.snapshot().document?.text, raw);
	assert.equal(changes.mock.calls.length, 0);
	assert.equal(saves.mock.calls.length, 0);
	const reloaded = "# heading\rbody\nend\r\n";
	read.mockResolvedValue({
		text: reloaded,
		revision: "b".repeat(64),
		bytes: new TextEncoder().encode(reloaded).length,
		encoding: "utf-8",
	});
	tab.editor.reload();
	await Promise.resolve();
	mountMarkdown(render);
	assert.equal(markdownFileText(restored.state), reloaded);
	await vi.advanceTimersByTimeAsync(10000);
	assert.equal(tab.editor.protected, false);
	assert.equal(changes.mock.calls.length, 0);
	assert.equal(saves.mock.calls.length, 0);
});

test.each(["# heading\r\nbody\r\nend\r\n", "# heading\rbody\rend\r", "# heading\r\nbody\rend\n"])(
	"actual typed Markdown edits save exact untouched separators and retain undo across remount: %j",
	async (raw) => {
		vi.spyOn(files, "readText").mockResolvedValue({
			text: raw,
			revision: "a".repeat(64),
			bytes: new TextEncoder().encode(raw).length,
			encoding: "utf-8",
		});
		saves.mockImplementation(async (_target, text) => ({
			text,
			revision: "b".repeat(64),
			bytes: new TextEncoder().encode(text).length,
			encoding: "utf-8",
		}));
		const tab = await open();
		const changes = vi.fn((value: string) => tab.editor.edit(value));
		const render = () =>
			MarkdownEditor({
				text: tab.editor.snapshot().document?.text ?? "",
				onChange: changes,
				label: "Source",
				readOnly: false,
				memory: tab.view,
			});
		mountMarkdown(render);
		const view = views.at(-1);
		assert.ok(view);
		view.dispatch({ changes: { from: view.state.doc.line(2).from + 1, insert: "X" }, userEvent: "input.type" });
		mountMarkdown(render);
		assert.equal(tab.editor.snapshot().document?.text, raw.replace("body", "bXody"));
		assert.equal(changes.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(3000);
		assert.equal(saves.mock.calls.length, 1);
		assert.equal(saves.mock.calls[0]?.[1], raw.replace("body", "bXody"));
		resetHooks();
		mountMarkdown(render);
		const remounted = views.at(-1);
		assert.ok(remounted);
		assert.equal(undo({ state: remounted.state, dispatch: remounted.dispatch }), true);
		mountMarkdown(render);
		assert.equal(tab.editor.snapshot().document?.text, raw);
		assert.equal(changes.mock.calls.length, 2);
	},
);

test.each(["# heading\r\nbody\r\nend", "# heading\rbody\rend", "# heading\r\nbody\rend\n"])(
	"Markdown search, replace and line navigation use normalized CM coordinates without losing raw separators: %j",
	(raw) => {
		let text = raw;
		const change = vi.fn((next: string) => {
			text = next;
		});
		const render = () => MarkdownEditor({ text, onChange: change, label: "Source", readOnly: false });
		let tree = mountMarkdown(render);
		const editor = views.at(-1);
		assert.ok(editor);
		const click = (label: string) => {
			const button = elements(tree, Button).find((item) => item.props["aria-label"] === label);
			assert.ok(button?.props.onClick);
			Reflect.apply(button.props.onClick, undefined, []);
			tree = mountMarkdown(render);
		};
		const input = (label: string, value: string) => {
			const field = elements(tree, Input).find((item) => item.props["aria-label"] === label);
			assert.ok(field?.props.onChange);
			Reflect.apply(field.props.onChange, undefined, [{ currentTarget: { value }, nativeEvent: {} }]);
			tree = mountMarkdown(render);
		};
		click("Go to line");
		input("Line and column", "3:2");
		assert.equal(editor.state.selection.main.anchor, editor.state.doc.line(3).from + 1);
		click("Cancel line navigation");
		click("Find in file");
		input("Find in file", "body");
		click("Next match");
		assert.equal(editor.state.selection.main.anchor, editor.state.doc.line(2).from);
		assert.equal(editor.state.selection.main.head, editor.state.doc.line(2).to);
		assert.equal(change.mock.calls.length, 0);
		click("Replace");
		input("Replace", "changed\nrow");
		click("Replace all");
		const separator = raw.includes("\r\n") ? "\r\n" : "\r";
		assert.equal(text, raw.replace("body", `changed${separator}row`));
		assert.equal(change.mock.calls.length, 1);
		assert.equal(undo({ state: editor.state, dispatch: editor.dispatch }), true);
		assert.equal(text, raw);
	},
);

test("production Markdown limit rejection cannot edit or schedule a save when only serialized CRLF bytes exceed the limit", async () => {
	const raw = `a\r\n${"x".repeat(FILE_LIMITS.bytes - 3)}`;
	vi.spyOn(files, "readText").mockResolvedValue({
		text: raw,
		revision: "a".repeat(64),
		bytes: FILE_LIMITS.bytes,
		encoding: "utf-8",
	});
	const tab = await open();
	const changes = vi.fn((value: string) => tab.editor.edit(value));
	const render = () =>
		MarkdownEditor({
			text: tab.editor.snapshot().document?.text ?? "",
			onChange: changes,
			label: "Source",
			readOnly: false,
			memory: tab.view,
		});
	mountMarkdown(render);
	const editor = views.at(-1);
	assert.ok(editor);
	editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\n" }, userEvent: "input.type" });
	const tree = mountMarkdown(render);
	assert.equal(
		elements(tree, "p").some((item) => item.props.role === "alert"),
		true,
	);
	assert.equal(markdownFileText(editor.state), raw);
	assert.equal(tab.editor.snapshot().document?.text, raw);
	assert.equal(tab.editor.protected, false);
	assert.equal(changes.mock.calls.length, 0);
	await vi.advanceTimersByTimeAsync(10000);
	assert.equal(saves.mock.calls.length, 0);
});

test.each([false, true])(
	"reopen focuses the actual Markdown content after commit and captures live scroll (readonly=%s)",
	(readOnly) => {
		const frames = new Map<number, () => void>();
		let sequence = 0;
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
			frames.set(++sequence, callback);
			return sequence;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		const memory: EditorViewMemory = {};
		const handled = vi.fn();
		let focusRequest: number | undefined;
		const render = () =>
			MarkdownEditor({
				text: "# disk",
				onChange: vi.fn(),
				label: "Source",
				readOnly,
				memory,
				focusRequest,
				onFocusHandled: handled,
			});
		mountMarkdown(render);
		assert.equal(frames.size, 0);
		const editor = views.at(-1);
		assert.ok(editor);
		const content = (editor as View & { contentDOM: { focus: ReturnType<typeof vi.fn> } }).contentDOM;
		editor.scrollDOM.scrollTop = 180;
		editor.scrollDOM.scrollLeft = 7;
		assert.deepEqual(memory.captureView?.(), { scrollTop: 180, scrollLeft: 7 });
		focusRequest = 1;
		mountMarkdown(render);
		assert.equal(content.focus.mock.calls.length, 0);
		for (const callback of frames.values()) callback();
		frames.clear();
		assert.deepEqual(content.focus.mock.calls, [[{ preventScroll: true }]]);
		assert.deepEqual(handled.mock.calls, [[1]]);
		focusRequest = 2;
		mountMarkdown(render);
		focusRequest = undefined;
		mountMarkdown(render);
		assert.equal(frames.size, 0);
		resetHooks();
		assert.equal(memory.captureView, undefined);
		vi.unstubAllGlobals();
	},
);

test.each(["preview", "diff"] as const)(
	"reopen %s focuses the visible surface, not an absent source editor",
	async (mode) => {
		const frames = new Map<number, () => void>();
		let sequence = 0;
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
			frames.set(++sequence, callback);
			return sequence;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		const tab = await open();
		tab.view.mode = mode;
		const focus = vi.fn();
		const handled = vi.fn();
		const tree = drive(
			() => FileBuffer({ tab, guard: (action) => action(), retry: vi.fn(), focusRequest: 3, onFocusHandled: handled }),
			(node) => {
				const surface = elements(node, "div").find((item) => item.props.className === "file-editor-surface");
				assert.ok(surface);
				assert.equal(surface.props.tabIndex, -1);
				(surface.props.ref as React.RefObject<unknown>).current = { focus };
			},
		);
		assert.equal(elements(tree, CodeEditor).length, 0);
		assert.equal(focus.mock.calls.length, 0);
		for (const callback of frames.values()) callback();
		assert.deepEqual(focus.mock.calls, [[{ preventScroll: true }]]);
		assert.deepEqual(handled.mock.calls, [[3]]);
		resetHooks();
		vi.unstubAllGlobals();
	},
);
