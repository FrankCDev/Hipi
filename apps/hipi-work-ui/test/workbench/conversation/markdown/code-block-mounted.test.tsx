// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { presentationStorageKey } from "../../../../src/app/presentation/store.ts";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	localStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	document.getSelection()?.removeAllRanges();
	host.remove();
	localStorage.clear();
	vi.unstubAllGlobals();
});
async function render(source: string, streaming = false, tone: "assistant" | "user" = "assistant") {
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<MessageMarkdown source={source} streaming={streaming} tone={tone} />
			</PreferencesProvider>,
		),
	);
}
function copy(code: HTMLElement, setData: (type: string, text: string) => void) {
	const event = new Event("copy", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", { value: { setData } });
	code.dispatchEvent(event);
	return event;
}

test("wrapping synchronizes all code blocks, preserves code DOM/selection and survives provider reload", async () => {
	const source = "```ts\nconst a = '<script>';\n```\n\n```\nsecond\n```";
	await render(source);
	const code = host.querySelector<HTMLElement>("code");
	assert.ok(code);
	const range = document.createRange();
	range.selectNodeContents(code);
	document.getSelection()?.addRange(range);
	const text = document.getSelection()?.toString();
	const toggle = host.querySelector<HTMLButtonElement>('[aria-label="启用自动换行"]');
	assert.ok(toggle);
	await act(async () => toggle.click());
	assert.equal(host.querySelector("code"), code);
	assert.equal(document.getSelection()?.toString(), text);
	assert.equal(host.querySelectorAll('[data-wrapped="true"]').length, 2);
	assert.equal(host.querySelectorAll('[aria-pressed="true"]').length, 2);
	assert.equal(JSON.parse(localStorage.getItem(presentationStorageKey) ?? "").codeBlockWordWrap, true);
	await act(async () => root.unmount());
	root = createRoot(host);
	await render(source);
	assert.equal(host.querySelectorAll('[data-wrapped="true"]').length, 2);
	assert.equal(host.querySelector("script"), null);
});

test("code selection copies only exact selected plain text; failed clipboard events keep native behavior", async () => {
	await render("```text\n  <&>\t中\n\n```\n\nOutside");
	const code = host.querySelector<HTMLElement>("code");
	assert.ok(code);
	const range = document.createRange();
	range.selectNodeContents(code);
	document.getSelection()?.addRange(range);
	const values: [string, string][] = [];
	assert.equal(copy(code, (type, value) => values.push([type, value])).defaultPrevented, true);
	assert.deepEqual(values, [["text/plain", "  <&>\t中\n\n"]]);
	assert.equal(
		copy(code, () => {
			throw new Error("unsupported");
		}).defaultPrevented,
		false,
	);
	const paragraph = host.querySelector("p");
	assert.ok(paragraph);
	range.setEndAfter(paragraph);
	assert.equal(copy(code, () => assert.fail("cross-block selection must stay native")).defaultPrevented, false);
});

test("open fence omits copy until stream completion; user code remains simple and untouched", async () => {
	await render("```ts\nunfinished", true);
	assert.equal(host.querySelector('[aria-label="复制代码"]'), null);
	assert.ok(host.querySelector('[aria-label="启用自动换行"]'));
	await render("```ts\nfinished\n```", false);
	assert.ok(host.querySelector('[aria-label="复制代码"]'));
	await render("```text\nuser code\n```", false, "user");
	assert.equal(host.querySelector(".markdown-code-header"), null);
	const code = host.querySelector<HTMLElement>("code");
	assert.ok(code);
	const range = document.createRange();
	range.selectNodeContents(code);
	document.getSelection()?.removeAllRanges();
	document.getSelection()?.addRange(range);
	assert.equal(copy(code, () => assert.fail("user copy stays native")).defaultPrevented, false);
});
