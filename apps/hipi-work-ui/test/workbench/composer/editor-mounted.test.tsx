// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ComposerEditor } from "../../../src/features/workbench/composer/editor.tsx";
import { composerDocument, composerDocumentText } from "../../../src/features/workbench/composer/editor-document.ts";

let root: Root;
let host: HTMLDivElement;
let reset: (text: string) => void;
const send = vi.fn();
function Fixture({
	owner = "a",
	readOnly = false,
	response = "",
}: {
	owner?: string;
	readOnly?: boolean;
	response?: string;
}) {
	const [value, setValue] = useState("");
	reset = setValue;
	return (
		<>
			<ComposerEditor
				key={owner}
				id="draft"
				label="Draft"
				placeholder="Message"
				value={value}
				onChange={setValue}
				onSubmit={send}
				maxLength={100}
				readOnly={readOnly}
			/>
			<output>{value}</output>
			<div data-response>{response}</div>
		</>
	);
}
function input() {
	const node = host.querySelector<HTMLElement>('[role="textbox"]');
	assert.ok(node);
	return node;
}
async function key(key: string, extra: KeyboardEventInit = {}) {
	await act(async () =>
		input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })),
	);
}
async function paste(text: string) {
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: { getData: (format: string) => (format === "text/plain" ? text : ""), files: [] },
	});
	await act(async () => input().dispatchEvent(event));
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
	Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	send.mockClear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	Reflect.deleteProperty(Range.prototype, "getClientRects");
	Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
test("plain-text schema preserves leading, repeated and trailing newlines exactly", () => {
	for (const text of ["", "\n", "\n\n", "a\n", "a\n\nb", " leading \n trailing ", "你好🌍\n"])
		assert.equal(composerDocumentText(composerDocument(text)), text);
});
test("real editor paste is text-only, normalizes CRLF, and public history handles undo/redo", async () => {
	await act(async () => root.render(<Fixture />));
	await paste("one\r\n\r\ntwo\n");
	assert.equal(host.querySelector("output")?.textContent, "one\n\ntwo\n");
	assert.equal(input().getAttribute("contenteditable"), "true");
	await key("z", { ctrlKey: true });
	assert.equal(host.querySelector("output")?.textContent, "");
	await key("y", { ctrlKey: true });
	assert.equal(host.querySelector("output")?.textContent, "one\n\ntwo\n");
});
test("Enter submits once, Shift+Enter edits, composition and repeat do not submit", async () => {
	await act(async () => root.render(<Fixture />));
	await paste("Hello");
	await key("Enter", { shiftKey: true });
	assert.equal(send.mock.calls.length, 0);
	assert.equal(host.querySelector("output")?.textContent, "Hello\n");
	await key("Enter", { isComposing: true, keyCode: 229 });
	assert.equal(send.mock.calls.length, 0);
	await key("Enter", { repeat: true });
	assert.equal(send.mock.calls.length, 0);
	await key("Enter");
	assert.equal(send.mock.calls.length, 1);
});
test("external send reset and restored drafts start clean history; owner changes never restore another draft", async () => {
	await act(async () => root.render(<Fixture />));
	await paste("Private old draft");
	await act(async () => reset(""));
	await key("z", { ctrlKey: true });
	assert.equal(host.querySelector("output")?.textContent, "");
	await act(async () => reset("Restored draft"));
	await key("z", { ctrlKey: true });
	assert.equal(host.querySelector("output")?.textContent, "Restored draft");
	await act(async () => root.render(<Fixture owner="b" />));
	await key("z", { ctrlKey: true });
	assert.equal(host.querySelector("output")?.textContent, "Restored draft");
	assert.equal(send.mock.calls.length, 0);
});
test("read-only editor cannot paste or submit", async () => {
	await act(async () => root.render(<Fixture readOnly />));
	await paste("Must not change");
	await key("Enter");
	assert.equal(input().getAttribute("aria-readonly"), "true");
	assert.equal(input().getAttribute("contenteditable"), "false");
	assert.equal(host.querySelector("output")?.textContent, "");
	assert.equal(send.mock.calls.length, 0);
});

test("streamed response renders retain editor node and browser text selection", async () => {
	await act(async () => root.render(<Fixture />));
	await paste("Select this draft");
	const editor = input();
	const text = editor.querySelector("p")?.firstChild;
	assert.ok(text);
	const range = document.createRange();
	range.setStart(text, 2);
	range.setEnd(text, 8);
	const selection = window.getSelection();
	assert.ok(selection);
	selection.removeAllRanges();
	selection.addRange(range);
	await act(async () => root.render(<Fixture response="A streamed response delta" />));
	assert.equal(input(), editor);
	assert.equal(selection.toString(), "lect t");
	assert.equal(host.querySelector("output")?.textContent, "Select this draft");
});
test("composition start/end and the confirming Enter do not submit; a new key gesture can", async () => {
	await act(async () => root.render(<Fixture />));
	await paste("你好");
	await act(async () => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
	await key("Enter", { keyCode: 229 });
	await act(async () => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
	await key("Enter");
	assert.equal(send.mock.calls.length, 0);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
	await act(async () => input().dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })));
	await key("Enter");
	assert.equal(send.mock.calls.length, 1);
});

test("oversized paste is rejected without a DOM/state split and deleting remains available", async () => {
	await act(async () => root.render(<Fixture />));
	await paste("Accepted");
	await paste("x".repeat(101));
	assert.equal(host.querySelector("output")?.textContent, "Accepted");
	assert.equal(input().textContent, "Accepted");
	await key("z", { ctrlKey: true });
	assert.equal(host.querySelector("output")?.textContent, "");
});
