// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, createRef, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../src/components/ui/dialog.tsx";
import { FilePanelSurface } from "../src/features/workbench/files/surface.tsx";

function present<T>(value: T | null | undefined): T {
	assert.ok(value != null);
	return value;
}

test("stable passive surface, nested modality, ancestor isolation and cleanup", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	const outside = document.createElement("button");
	document.body.append(host, outside);
	const root = createRoot(host);
	const trigger = createRef<HTMLButtonElement>();
	let outerClosed = 0;
	let nestedClosed = 0;
	function Fixture({ open, overlay, nested = false }: { open: boolean; overlay: boolean; nested?: boolean }) {
		const [child, setChild] = useState(false);
		return (
			<>
				<button type="button" ref={trigger}>
					Open
				</button>
				<FilePanelSurface id="surface" open={open} overlay={overlay} trigger={trigger} onClose={() => outerClosed++}>
					<h2 id="surface-title">Files</h2>
					<p id="surface-description">Files editor</p>
					<button type="button" className="file-panel-close">
						Close
					</button>
					<input aria-label="Editor" />
					<button type="button" onClick={() => setChild(true)}>
						Child
					</button>
					<Dialog
						open={nested || child}
						onOpenChange={() => {
							nestedClosed++;
							setChild(false);
						}}
					>
						<DialogContent closeLabel="Close child" aria-describedby={undefined}>
							<DialogTitle>Child review</DialogTitle>
							<button type="button">Child action</button>
						</DialogContent>
					</Dialog>
				</FilePanelSurface>
			</>
		);
	}
	const render = async (open: boolean, overlay: boolean, nested = false) => {
		await act(async () =>
			root.render(
				<StrictMode>
					<Fixture open={open} overlay={overlay} nested={nested} />
				</StrictMode>,
			),
		);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
	};
	const pressEscape = async () =>
		act(async () =>
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true }),
			),
		);
	try {
		await render(false, false);
		outside.focus();
		await pressEscape();
		assert.equal(outerClosed, 0);
		assert.equal(document.body.style.pointerEvents, "");
		await render(true, false);
		const editor = present(host.querySelector("input"));
		editor.focus();
		await render(true, true);
		assert.ok(document.activeElement === editor, "resize must not steal editor focus");
		await act(async () => outside.focus());
		assert.ok(document.activeElement === editor, "first outside focus after activation is trapped");
		assert.equal(outside.getAttribute("aria-hidden"), "true");
		editor.setAttribute("data-file-editor-cancel", "");
		await pressEscape();
		assert.equal(outerClosed, 0, "nested editor cancel wins Escape");
		editor.removeAttribute("data-file-editor-cancel");
		await act(async () =>
			editor.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true, isComposing: true }),
			),
		);
		assert.equal(outerClosed, 0, "composition Escape is not dismissal");
		await render(true, false);
		assert.ok(document.activeElement === editor, "editor retains focus on dock");
		assert.equal(outside.hasAttribute("aria-hidden"), false);
		await act(async () => present(host.querySelectorAll("button")[2]).click());
		await render(true, true);
		assert.ok(document.querySelector('[role="dialog"] button'));
		assert.equal(host.querySelector('[aria-modal="true"]'), null, "outer must yield to existing child modal");
		await pressEscape();
		assert.equal(nestedClosed, 1);
		assert.equal(outerClosed, 0);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
		assert.ok(host.querySelector('[aria-modal="true"]'), "outer resumes after child closes");
		await render(true, false);
		host.setAttribute("inert", "");
		await render(true, true);
		assert.equal(host.querySelector('[role="dialog"]'), null, "suspended background panel has no active dialog role");
		assert.equal(document.body.style.pointerEvents, "");
		assert.equal(outside.hasAttribute("aria-hidden"), false);
		await act(async () => host.removeAttribute("inert"));
		assert.ok(host.querySelector('[role="dialog"]'), "dialog role returns with modality");
		assert.ok(host.querySelector('[aria-modal="true"]'));
		const backdrop = present(host.querySelector(".file-panel-backdrop"));
		await act(async () => backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
		await act(async () => backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
		assert.equal(outerClosed, 1, "backdrop click requests close");
		await render(false, true);
		assert.ok(document.activeElement === trigger.current, "close restores trigger");
		assert.equal(document.body.style.pointerEvents, "");
		assert.equal(outside.hasAttribute("aria-hidden"), false);
		outside.focus();
		await pressEscape();
		await act(async () => outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
		await act(async () => outside.click());
		assert.equal(outerClosed, 1, "inactive layer has no dismissal handlers");
	} finally {
		await act(async () => root.unmount());
		await new Promise((resolve) => setTimeout(resolve, 10));
		host.remove();
		outside.remove();
		vi.unstubAllGlobals();
	}
	assert.equal(document.querySelector("[data-radix-focus-guard]"), null);
	assert.equal(document.body.style.pointerEvents, "");
	assert.equal(document.body.hasAttribute("data-scroll-locked"), false);
});

test("file and standard dialogs share the unchanged modal layer token", () => {
	const read = (path: string) => readFileSync(new NodeURL(path, import.meta.url), "utf8");
	const tokens = read("../src/components/ui/tokens.css");
	const theme = read("../src/theme.css");
	const dialog = read("../src/components/ui/dialog.tsx");
	assert.match(tokens, /--ui-modal-layer:\s*50;/);
	const filePresentation = theme.slice(theme.indexOf("/* File presentation changes position"));
	assert.equal((filePresentation.match(/z-index: var\(--ui-modal-layer\);/g) ?? []).length, 2);
	assert.equal((dialog.match(/z-\[var\(--ui-modal-layer\)\]/g) ?? []).length, 2);
	assert.doesNotMatch(dialog, /z-50/);
	assert.match(filePresentation, /border: 1px solid var\(--line\);/);
});
