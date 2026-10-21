// @vitest-environment jsdom
// Real React and editor lifecycles; shims below supply only unsupported layout/canvas APIs.
import assert from "node:assert/strict";
import { undo, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { Editor } from "@pierre/diffs/edit";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { AppClientProvider } from "../src/app/client-provider.tsx";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { FileWorkspaceSession } from "../src/features/files/file-workspace-session.ts";
import { FilePanel } from "../src/features/workbench/files/panel.tsx";
import { FilePanelController } from "../src/features/workbench/files/panel-controller.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

function deepActive() {
	let element = document.activeElement;
	while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
	return element;
}
function present<T>(value: T | null | undefined): T {
	assert.ok(value != null);
	return value;
}

test.each(["md", "txt"])("real mounted FilePanel %s across 673px boundary", async (extension) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	if (!CSSStyleSheet.prototype.replaceSync) CSSStyleSheet.prototype.replaceSync = () => {};
	HTMLElement.prototype.scrollIntoView = () => {};
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
		font: "",
		measureText: (text: string) => ({ width: text.length * 8 }),
	}));
	Range.prototype.getClientRects = () => [];
	Range.prototype.getBoundingClientRect = () => ({
		x: 0,
		y: 0,
		width: 100,
		height: 20,
		top: 0,
		left: 0,
		right: 100,
		bottom: 20,
		toJSON() {},
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
		x: 0,
		y: 0,
		width: 800,
		height: 600,
		top: 0,
		left: 0,
		right: 800,
		bottom: 600,
		toJSON() {},
	}));
	const seen: Editor[] = [];
	const original = Editor.prototype.edit;
	vi.spyOn(Editor.prototype, "edit").mockImplementation(function (...args) {
		seen.push(this);
		return original.apply(this, args);
	});
	const baseline = "line one\nline two\nline three";
	const files = {
		listRoots: async () => [{ workspaceId: "w", rootId: "r", displayName: "root", writable: true }],
		list: async () => ({ entries: [] }),
		readText: async () => ({ text: baseline, bytes: baseline.length, revision: "a".repeat(64), encoding: "utf-8" }),
		saveText: async () => {
			throw new Error("unexpected save during short audit");
		},
	};
	const session = new FileWorkspaceSession(files);
	session.setWorkspace("w");
	session.layout.treeOpen = false;
	await session.open({ workspaceId: "w", rootId: "r", path: `audit.${extension}` }, true);
	const tab = session.snapshot().tabs[0];
	assert.equal(tab.kind, "editor");
	const controller = new FilePanelController(new LocalState());
	controller.setOpen(true);
	const trigger = createRef<HTMLButtonElement>();
	const client = {
		call: async () => {
			throw new Error("unexpected app call");
		},
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async (available: number, ownerSession = session, ownerController = controller) => {
		await act(async () =>
			root.render(
				<AppClientProvider client={client} files={files}>
					<PreferencesProvider>
						<FilePanel
							controller={ownerController}
							available={available}
							workspaceId="w"
							session={ownerSession}
							guard={(action) => action()}
							trigger={trigger}
							id="audit-files"
						/>
					</PreferencesProvider>
				</AppClientProvider>,
			),
		);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
	};
	try {
		await render(extension === "txt" ? 672 : 900);
		const oldNode = document.querySelector(".file-workbench");
		assert.ok(oldNode);
		if (extension === "md") {
			const oldView = EditorView.findFromDOM(present(document.querySelector(".cm-content")));
			assert.ok(oldView);
			await act(async () =>
				oldView.dispatch({ changes: { from: 0, insert: "EDIT " }, selection: { anchor: 8, head: 10 } }),
			);
			oldView.scrollDOM.scrollTop = 123;
			oldView.scrollDOM.scrollLeft = 17;
			const before = {
				text: tab.editor.snapshot().document.text,
				selection: oldView.state.selection.main.toJSON(),
				undo: undoDepth(oldView.state),
			};
			await act(async () => present(document.querySelector<HTMLButtonElement>(".file-find-trigger")).click());
			assert.ok(document.querySelector(".file-find"));
			await render(672);
			await render(900);
			await render(672);
			const next = EditorView.findFromDOM(present(document.querySelector(".cm-content")));
			assert.ok(next);
			const after = {
				text: tab.editor.snapshot().document.text,
				selection: next.state.selection.main.toJSON(),
				undo: undoDepth(next.state),
			};
			assert.equal(oldNode, document.querySelector(".file-workbench"));
			assert.deepEqual([next.scrollDOM.scrollTop, next.scrollDOM.scrollLeft], [123, 17]);
			assert.deepEqual(after, before);
			assert.equal(next, oldView);
			assert.ok(document.querySelector(".file-find"), "find stays open");
			await act(async () => undo(next));
			assert.equal(tab.editor.snapshot().document.text, baseline);
		} else {
			assert.ok(seen.length, "Pierre editor mounted");
			const first = present(seen.at(-1));
			await act(async () =>
				first.applyEdits([
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "EDIT " },
				]),
			);
			await act(async () =>
				first.setSelections([
					{ start: { line: 1, character: 1 }, end: { line: 1, character: 3 }, direction: "forward" },
				]),
			);
			const before = { text: tab.editor.snapshot().document.text, selection: first.getViewState().selections };
			const oldModel = present(first.getEditState()).document;
			assert.equal(oldModel.canUndo, true);
			await act(async () => present(document.querySelector<HTMLButtonElement>(".file-find-trigger")).click());
			assert.ok(document.querySelector(".file-find"));
			await render(900);
			await render(672);
			await render(900);
			const next = present(seen.at(-1));
			assert.equal(first, next);
			const after = { text: tab.editor.snapshot().document.text, selection: next.getViewState().selections };
			assert.equal(after.text, before.text);
			assert.deepEqual(after.selection, before.selection);
			assert.equal(present(next.getEditState()).document.canUndo, true);
			assert.equal(present(next.getEditState()).document, oldModel);
			assert.ok(document.querySelector(".file-find"), "find stays open");
			await act(async () => next.focus({ preventScroll: true }));
			const editorFocus = deepActive();
			assert.ok(editorFocus && editorFocus !== document.body);
			await render(672);
			assert.ok(deepActive() === editorFocus, "overlay activation preserves Pierre shadow focus");
			const outside = document.createElement("button");
			document.body.append(outside);
			await act(async () => outside.focus());
			assert.ok(deepActive() === editorFocus, "outside focus restores the actual Pierre editor input");
			outside.remove();
			await act(async () => next.undo());
			assert.equal(tab.editor.snapshot().document.text, baseline);
			assert.equal(session.protected, false);
			assert.equal(oldNode, document.querySelector(".file-workbench"));
			await act(async () => controller.setOpen(false));
			assert.equal(document.querySelector(".file-workbench"), null);
		}
		// A new owner is intentionally not presentation continuity: local review/find state resets.
		await act(async () => controller.setOpen(true));
		await render(900);
		if (!document.querySelector(".file-find"))
			await act(async () => present(document.querySelector<HTMLButtonElement>(".file-find-trigger")).click());
		const previousHost = document.querySelector(".file-workbench");
		const replacement = new FileWorkspaceSession(files);
		replacement.setWorkspace("w");
		replacement.layout.treeOpen = false;
		await replacement.open({ workspaceId: "w", rootId: "r", path: `audit.${extension}` }, true);
		try {
			await render(900, replacement);
			assert.notEqual(document.querySelector(".file-workbench"), previousHost);
			assert.equal(document.querySelector(".file-find"), null);
			await act(async () => present(document.querySelector<HTMLButtonElement>(".file-find-trigger")).click());
			const localReplacement = new FilePanelController(new LocalState());
			localReplacement.setOpen(true);
			const previousLocalHost = document.querySelector(".file-workbench");
			await render(900, replacement, localReplacement);
			assert.notEqual(document.querySelector(".file-workbench"), previousLocalHost);
			assert.equal(document.querySelector(".file-find"), null);
		} finally {
			replacement.dispose();
		}
	} finally {
		await act(async () => root.unmount());
		session.dispose();
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
