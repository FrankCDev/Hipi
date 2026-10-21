// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { DraftInventory } from "../../../src/features/workbench/composer/draft.ts";
import { DraftRecovery } from "../../../src/features/workbench/composer/draft-recovery.tsx";

vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
let root: Root;
let host: HTMLDivElement;
const recover = vi.fn();
const reload = vi.fn();
const sources = Array.from({ length: 1000 }, (_, index) => ({
	kind: "value" as const,
	key: `task-draft.${index}`,
	value: `Retained draft ${index}`,
	revision: `rev${index}`,
}));
const inventory: DraftInventory = {
	active: null,
	activeSource: null,
	retainedSources: sources,
	recoverable: sources.slice(1),
	claimedSource: sources[0].key,
	blocked: false,
};
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	recover.mockClear();
	reload.mockClear();
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
		return this.classList.contains("draft-recovery-viewport") ? 320 : this.offsetHeight;
	});
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
		return this instanceof HTMLDetailsElement && this.open ? 160 : 32;
	});
	Object.defineProperty(HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value(this: HTMLElement, options: ScrollToOptions) {
			this.scrollTop = options.top ?? 0;
			this.dispatchEvent(new Event("scroll"));
		},
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	document.getSelection()?.removeAllRanges();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
async function render(value: DraftInventory | null = inventory, busy = false, failed = false) {
	await act(async () =>
		root.render(
			<DraftRecovery
				inventory={value}
				busy={busy}
				failed={failed}
				onRecover={recover}
				onReload={reload}
				projectName={(id) => `Project ${id}`}
			/>,
		),
	);
}
function row(index: number) {
	const element = host.querySelector<HTMLDetailsElement>(`[data-index="${index}"]`);
	assert.ok(element, `Missing row ${index}`);
	return element;
}
async function scroll(index: number) {
	await act(async () => {
		const viewport = host.querySelector<HTMLElement>(".draft-recovery-viewport");
		assert.ok(viewport);
		viewport.scrollTop = index * 32;
		viewport.dispatchEvent(new Event("scroll"));
	});
}
async function expand(index: number) {
	await act(async () => {
		const element = row(index);
		element.open = true;
		element.dispatchEvent(new Event("toggle"));
	});
}

test("continuous inventory reaches beyond ten and back with bounded mounted rows and retained disclosure", async () => {
	await render();
	assert.ok(host.querySelectorAll("details").length < 25);
	assert.equal(host.textContent?.includes("Next drafts"), false);
	assert.equal(host.textContent?.includes("Previous drafts"), false);
	await expand(1);
	await scroll(600);
	assert.ok(row(600).textContent?.includes("Retained draft 600"));
	assert.equal(host.querySelector('[data-index="1"]'), null);
	assert.ok(host.querySelectorAll("details").length < 25);
	await scroll(0);
	assert.equal(row(1).open, true);
	assert.equal(recover.mock.calls.length, 0);
	assert.equal(reload.mock.calls.length, 0);
});
test("explicit recovery uses exact source, claimed remains read-only and busy disables recovery", async () => {
	await render();
	assert.equal(row(0).querySelector("button"), null);
	assert.ok(row(0).textContent?.includes("unresolved first Send"));
	await expand(1);
	await act(async () => row(1).querySelector("button")?.click());
	assert.equal(recover.mock.calls[0][0], sources[1]);
	await render(inventory, true);
	assert.equal(row(1).querySelector("button")?.disabled, true);
	await act(async () => row(1).querySelector("button")?.click());
	assert.equal(recover.mock.calls.length, 1);
});
test("keyboard crosses virtual windows and focused row survives unrelated scrolling", async () => {
	await render();
	await act(async () => row(0).querySelector("summary")?.focus());
	for (let index = 1; index <= 30; index++) {
		await act(async () =>
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
			),
		);
		assert.equal(document.activeElement, row(index).querySelector("summary"));
	}
	const focused = document.activeElement;
	await scroll(600);
	assert.equal(document.activeElement, focused);
	assert.equal(focused?.isConnected, true);
	assert.ok(host.querySelectorAll("details").length < 25);
});
test("selected text is retained while scrolling and released when selection clears", async () => {
	await render();
	await expand(1);
	const text = row(1).querySelector("pre");
	assert.ok(text);
	await act(async () => {
		const range = document.createRange();
		range.selectNodeContents(text);
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	await scroll(600);
	assert.equal(text.isConnected, true);
	assert.equal(document.getSelection()?.toString(), "Retained draft 1");
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(text.isConnected, false);
});
test("normal new chat stays empty; storage failure alone exposes a real busy-aware retry", async () => {
	await render(null);
	assert.equal(host.innerHTML, "");
	await render(null, false, true);
	assert.ok(host.querySelector('[role="alert"]'));
	await act(async () => host.querySelector("button")?.click());
	assert.equal(reload.mock.calls.length, 1);
	await render(null, true, true);
	assert.equal(host.querySelector("button")?.disabled, true);
});

test("reverse keyboard navigation restores an expanded predecessor and inventory shrink does not strand the viewport", async () => {
	await render();
	await expand(1);
	await act(async () => row(2).querySelector("summary")?.focus());
	await act(async () =>
		document.activeElement?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
		),
	);
	assert.equal(document.activeElement, row(1).querySelector("button"));
	await scroll(600);
	await render({ ...inventory, retainedSources: sources.slice(0, 2), recoverable: sources.slice(1, 2) });
	assert.ok(host.querySelectorAll("details").length > 0);
	assert.equal(row(1).open, true);
	assert.equal(recover.mock.calls.length, 0);
});
