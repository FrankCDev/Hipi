// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { ClipboardCopy } from "../../../../src/features/workbench/conversation/markdown/clipboard-copy.tsx";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const render = async (text = "Final answer", disabled = false) => {
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<ClipboardCopy text={text} label="Copy answer" disabled={disabled} iconOnly />
			</PreferencesProvider>,
		),
	);
};
const button = () => {
	const result = host.querySelector("button");
	assert.ok(result);
	return result;
};
const hover = async (target: HTMLElement) => {
	await act(async () => target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
	await act(async () => vi.advanceTimersByTimeAsync(200));
};
test("copy uses the shared tooltip, closes on click and retains pending and copied feedback", async () => {
	let finish: (() => void) | undefined;
	const write = vi.fn(
		(_text: string) =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
	await render();
	const target = button();
	assert.equal(target.getAttribute("title"), null);
	await hover(target);
	assert.equal(document.querySelector('[role="tooltip"]')?.textContent, "Copy answer");
	await act(async () => target.click());
	assert.equal(write.mock.calls[0]?.[0], "Final answer");
	assert.equal(target.disabled, true);
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	assert.ok(finish);
	await act(async () => finish?.());
	assert.equal(button(), target);
	assert.equal(target.disabled, false);
	assert.equal(target.getAttribute("aria-label"), "已复制");
	await act(async () => vi.advanceTimersByTimeAsync(1500));
	assert.equal(target.getAttribute("aria-label"), "Copy answer");
});
test("a late clipboard result cannot mark a different message copied", async () => {
	let finish: (() => void) | undefined;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: () =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		},
	});
	await render("Old answer");
	await act(async () => button().click());
	await render("New answer");
	assert.ok(finish);
	await act(async () => finish?.());
	assert.equal(button().getAttribute("aria-label"), "Copy answer");
	assert.equal(button().disabled, false);
});
test("copy rejection remains actionable and disabled actions do not open tooltips", async () => {
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: () => Promise.reject(new Error("Denied")) },
	});
	await render();
	await act(async () => button().click());
	assert.ok(host.querySelector('[role="alert"]'));
	assert.equal(button().disabled, false);
	await render("Disabled answer", true);
	await hover(button());
	assert.equal(document.querySelector('[role="tooltip"]'), null);
});
