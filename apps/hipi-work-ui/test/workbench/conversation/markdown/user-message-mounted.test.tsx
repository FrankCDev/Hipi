// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import {
	USER_MESSAGE_COLLAPSED_UNITS,
	UserMessageContent,
} from "../../../../src/features/workbench/conversation/markdown/user-message-content.tsx";

let host: HTMLDivElement;
let root: Root;
let contentHeight: number;
let lineHeight: number;
let scale: number;
const observers = new Set<() => void>();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				this.callback = callback;
			}
			callback: () => void;
			observe() {
				observers.add(this.callback);
			}
			disconnect() {
				observers.delete(this.callback);
			}
		},
	);
	contentHeight = 600;
	lineHeight = 20;
	scale = 1;
	const computed = window.getComputedStyle.bind(window);
	vi.stubGlobal("getComputedStyle", (node: Element) => {
		const style = computed(node);
		if (node.classList.contains("user-message-body"))
			Object.defineProperty(style, "lineHeight", { value: `${lineHeight}px` });
		return style;
	});
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("user-message-body") ? contentHeight : 0;
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const top = Number(this.dataset.testTop ?? 0) * scale;
		const height =
			(this.classList.contains("user-message-body") ? contentHeight : Number(this.dataset.testHeight ?? 0)) * scale;
		return new DOMRect(0, top, 200 * scale, height);
	});
	localStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	assert.equal(observers.size, 0);
	document.getSelection()?.removeAllRanges();
	host.remove();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render(source: string) {
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<UserMessageContent source={source} />
			</PreferencesProvider>,
		),
	);
}
function fold() {
	const node = host.querySelector<HTMLElement>(".user-message-fold");
	assert.ok(node);
	return node;
}
async function resize() {
	await act(async () => {
		for (const callback of observers) callback();
	});
}
async function toggle() {
	const button = host.querySelector<HTMLButtonElement>(".user-message-expand");
	assert.ok(button);
	await act(async () => button.click());
}

test("mounted overflow reserves the twentieth line for ellipsis and preserves selection on expansion", async () => {
	await render("A selectable paragraph.");
	assert.equal(fold().style.maxHeight, "19lh");
	assert.equal(fold().dataset.collapsed, "true");
	assert.equal(host.querySelector(".user-message-ellipsis")?.textContent, "…");
	assert.equal(host.querySelector(".user-message-ellipsis")?.getAttribute("aria-hidden"), "true");
	assert.ok(host.querySelector(".user-message-expand-icon"));
	const paragraph = host.querySelector("p");
	assert.ok(paragraph);
	const range = document.createRange();
	range.selectNodeContents(paragraph);
	document.getSelection()?.addRange(range);
	await toggle();
	assert.equal(fold().style.maxHeight, "");
	assert.equal(host.querySelector(".user-message-ellipsis"), null);
	assert.equal(host.querySelector("p"), paragraph);
	assert.equal(document.getSelection()?.toString(), "A selectable paragraph.");
	await render("A selectable paragraph. Appended content.");
	assert.equal(fold().dataset.collapsed, "false");
	assert.equal(host.querySelector(".user-message-expand")?.getAttribute("aria-expanded"), "true");
	await toggle();
	assert.equal(fold().style.maxHeight, "19lh");
});

test("twenty lines do not collapse; resize and font metrics recompute without resetting expansion", async () => {
	contentHeight = 400;
	await render("Text");
	assert.equal(host.querySelector(".user-message-expand"), null);
	assert.equal(fold().style.maxHeight, "");
	contentHeight = 500;
	await resize();
	assert.equal(fold().style.maxHeight, "19lh");
	lineHeight = 24;
	await resize();
	assert.equal(fold().style.maxHeight, "19lh");
	await toggle();
	lineHeight = 18;
	await resize();
	assert.equal(fold().style.maxHeight, "");
	assert.equal(fold().dataset.collapsed, "false");
});

test("card insertion extends the crossing card in unscaled coordinates and restores clipped controls", async () => {
	scale = 2;
	await render("Text");
	const body = host.querySelector<HTMLElement>(".user-message-body");
	assert.ok(body);
	const card = document.createElement("div");
	card.dataset.markdownCopy = "code-block";
	card.dataset.testTop = "350";
	card.dataset.testHeight = "100";
	const visible = document.createElement("button");
	visible.dataset.testTop = "410";
	visible.dataset.testHeight = "20";
	card.append(visible);
	const hidden = document.createElement("button");
	hidden.dataset.testTop = "470";
	hidden.dataset.testHeight = "20";
	hidden.setAttribute("aria-hidden", "false");
	await act(async () => body.append(card, hidden));
	assert.equal(fold().style.maxHeight, "450px");
	assert.notEqual(visible.inert, true);
	assert.equal(hidden.inert, true);
	assert.equal(hidden.getAttribute("aria-hidden"), "true");
	await toggle();
	assert.notEqual(hidden.inert, true);
	assert.equal(hidden.getAttribute("aria-hidden"), "false");
	await toggle();
	assert.equal(hidden.inert, true);
	await act(async () => card.remove());
	assert.equal(fold().style.maxHeight, "19lh");
});

test("source-sliced previews retain the 20 by 512 bound and do not extend cards", async () => {
	const source = "x".repeat(USER_MESSAGE_COLLAPSED_UNITS + 50);
	await render(source);
	assert.equal(host.querySelector(".markdown-body")?.textContent?.length, USER_MESSAGE_COLLAPSED_UNITS);
	const card = document.createElement("div");
	card.dataset.markdownCopy = "code-block";
	card.dataset.testTop = "350";
	card.dataset.testHeight = "100";
	await act(async () => host.querySelector(".user-message-body")?.append(card));
	assert.equal(fold().style.maxHeight, "19lh");
	await toggle();
	assert.equal(host.querySelector(".markdown-body")?.textContent, source);
});

test("plain user pre blocks remain clipped rather than mistaken for interactive code cards", async () => {
	await render("```text\nplain user code\n```");
	const pre = host.querySelector("pre");
	assert.ok(pre);
	pre.dataset.markdownCopy = "code-block";
	pre.dataset.testTop = "350";
	pre.dataset.testHeight = "100";
	await resize();
	assert.equal(fold().style.maxHeight, "19lh");
	assert.equal(host.querySelector(".markdown-code-header"), null);
});
