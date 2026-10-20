import assert from "node:assert/strict";
import { capture, click, evaluate, pressKey, until } from "./gui-flow.mjs";

/** DOM-only evidence: never inspect editor controllers or write renderer state. */
export function narrowEditorNodes(document) {
	const selectors = [
		'.file-panel-dialog[role="dialog"]',
		'.file-panel-dialog .file-tabs [role="tab"][aria-selected="true"]',
		".file-panel-dialog .file-code.pierre-code",
		".file-panel-dialog .pierre-editor-viewport diffs-container",
	];
	const nodes = selectors.map((selector) => document.querySelectorAll(selector));
	if (nodes.some((matches) => matches.length !== 1 || !matches[0].isConnected)) return null;
	return nodes.map((matches) => matches[0]);
}

export function narrowEditorRestored(document, before, readNodes = narrowEditorNodes) {
	const current = readNodes(document);
	if (!before || !current || current.some((node, index) => node !== before[index])) return false;
	if (document.querySelector("[data-file-editor-cancel]")) return false;
	const host = current[3];
	const input = host.shadowRoot?.activeElement;
	return (
		document.activeElement === host &&
		input?.getAttribute("role") === "textbox" &&
		input.getAttribute("contenteditable") === "true"
	);
}

export async function tabToEditorControl(cdp, selector) {
	for (let count = 0; count <= 12; count++) {
		if (
			await evaluate(
				cdp,
				`(() => {
					const controls = document.querySelectorAll(${JSON.stringify(selector)});
					return controls.length === 1 && !controls[0].disabled &&
						controls[0].getClientRects().length > 0 && document.activeElement === controls[0];
				})()`,
			)
		)
			return;
		if (count === 12) break;
		for (const type of ["keyDown", "keyUp"])
			await cdp.request("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
	}
	assert.fail(`Native Tab did not reach the exact editor control: ${selector}`);
}

/** Run inside the existing dirty narrow-dialog fixture, before its outer Escape gate. */
export async function exerciseNarrowEditorEscape(cdp, directory) {
	assert.equal(
		await evaluate(
			cdp,
			`(() => {
				const nodes = (${narrowEditorNodes.toString()})(document);
				if (!nodes) return false;
				window.__hipiEditorEscapeNodes = nodes;
				return true;
			})()`,
		),
		true,
		"Capture actual narrow dialog, selected tab and editor nodes",
	);
	try {
		for (const label of ["Match case", "Next match", "Close find"]) {
			await click(cdp, '.file-panel-dialog .file-find-trigger[aria-label="Find in file"]');
			await until(
				() =>
					evaluate(
						cdp,
						`document.activeElement === document.querySelector('search.file-find input[aria-label="Find in file"]')`,
					),
				"Find query receives actual focus",
			);
			if (label === "Match case") await cdp.request("Input.insertText", { text: "Protected" });
			await tabToEditorControl(cdp, `search.file-find button[aria-label="${label}"]`);
			await capture(cdp, directory, `file-narrow-find-${label.toLowerCase().replaceAll(" ", "-")}`);
			await pressKey(cdp, "Escape");
			await until(
				() =>
					evaluate(
						cdp,
						`(${narrowEditorRestored.toString()})(document, window.__hipiEditorEscapeNodes, ${narrowEditorNodes.toString()})`,
					),
				"Find Escape preserves exact outer dialog and restores shadow editor focus",
			);
		}
		for (const label of ["Go", "Cancel line navigation"]) {
			await click(cdp, ".file-panel-dialog .file-line-navigation-trigger");
			await until(
				() =>
					evaluate(
						cdp,
						`document.activeElement === document.querySelector('.file-line-navigation input[aria-label="Line and column"]')`,
					),
				"Go-to-line receives actual focus",
			);
			await tabToEditorControl(cdp, `.file-line-navigation button[aria-label="${label}"]`);
			await capture(cdp, directory, `file-narrow-line-${label === "Go" ? "go" : "cancel"}`);
			await pressKey(cdp, "Escape");
			await until(
				() =>
					evaluate(
						cdp,
						`(${narrowEditorRestored.toString()})(document, window.__hipiEditorEscapeNodes, ${narrowEditorNodes.toString()})`,
					),
				"Go-to-line Escape preserves exact outer dialog and restores shadow editor focus",
			);
		}
	} finally {
		await evaluate(cdp, "delete window.__hipiEditorEscapeNodes");
	}
}
