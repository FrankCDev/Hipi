// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type ConversationSearchHit,
	type ConversationSearchPage,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ConversationSearch } from "../../../src/features/workbench/search/search.tsx";

vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));

const index = { generation: "g", completedAt: 1, state: "ready", nextCursor: null } as const;
const hit = (number: number): ConversationSearchHit => ({
	workspaceId: "workspace",
	conversationId: `conversation-${number}`,
	title: `Result ${number}`,
	workspaceName: "Project",
	kind: "title",
	snippet: "needle",
	snippetOffset: 0,
	matchStart: 0,
	matchEnd: 6,
});
let search: (cursor: string | undefined, signal?: AbortSignal) => Promise<ConversationSearchPage>;
let reads: (string | undefined)[];
let refreshFails = false;
const client: AppClient = {
	async call(method, params, signal) {
		if (method === "refreshConversationSearch") {
			if (refreshFails) throw new Error("unavailable");
			return parseResult(method, index);
		}
		assert.equal(method, "searchConversations");
		const cursor = "cursor" in params && typeof params.cursor === "string" ? params.cursor : undefined;
		reads.push(cursor);
		return parseResult(method, await search(cursor, signal));
	},
	async observe() {
		throw new Error("Search cannot start execution");
	},
};
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
	reads = [];
	refreshFails = false;
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("short viewports fill automatically within budget and evicted rows do not shift the visible scroll anchor", async () => {
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.getAttribute("role") === "listbox" ? 100 : 0;
	});
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.getAttribute("role") === "listbox" ? this.querySelectorAll("button[role=option]").length * 50 : 0;
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const root = this.closest<HTMLElement>("[role=listbox]");
		const rows = Array.from(root?.querySelectorAll("button[role=option]") ?? []);
		const ordinal = rows.indexOf(this);
		return new DOMRect(0, ordinal < 0 ? 0 : ordinal * 50 - (root?.scrollTop ?? 0), 300, ordinal < 0 ? 100 : 50);
	});
	search = async (cursor) => {
		const number = Number(cursor ?? 0);
		return { items: [hit(number)], index, nextCursor: String(number + 1) };
	};
	const { list } = await mount();
	assert.equal(reads.length, 3, "Stop filling once the viewport can scroll");
	for (let n = 0; n < 6; n++) {
		list.scrollTop = list.scrollHeight - list.clientHeight;
		await wheel(list, 100);
	}
	assert.equal(reads.length, 9);
	list.scrollTop = list.scrollHeight - list.clientHeight;
	const before = list.scrollTop;
	const anchor = Array.from(list.querySelectorAll<HTMLButtonElement>("button[role=option]")).find(
		(row) => row.getBoundingClientRect().bottom > 0,
	);
	assert.ok(anchor);
	const title = anchor.textContent;
	const top = anchor.getBoundingClientRect().top;
	await wheel(list, 100);
	const retained = Array.from(list.querySelectorAll<HTMLButtonElement>("button[role=option]")).find(
		(row) => row.textContent === title,
	);
	assert.ok(retained);
	assert.equal(retained.getBoundingClientRect().top, top);
	assert.equal(list.scrollTop, before - 50);
	await act(async () => {
		list.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	assert.equal(reads.length, 10, "Anchor correction is not a new user loading demand");
});

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const activate = vi.fn(async (_hit: ConversationSearchHit, _signal: AbortSignal) => false);
	const close = vi.fn();
	const restore = vi.fn();
	const render = async (open: boolean) =>
		act(async () =>
			root.render(
				<ConversationSearch open={open} onActivate={activate} onOpenChange={close} onRestoreFocus={restore} />,
			),
		);
	await render(true);
	cleanups.push(async () => {
		await act(async () => root.unmount());
		host.remove();
	});
	const input = document.querySelector<HTMLInputElement>("[role=combobox]");
	const list = document.querySelector<HTMLDivElement>("[role=listbox]");
	assert.ok(input && list);
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "needle");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => vi.advanceTimersByTimeAsync(180));
	return { input, list, activate, render, close, restore };
}
async function key(input: HTMLInputElement, key: string) {
	await act(async () => {
		input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	});
}
async function wheel(list: HTMLDivElement, direction: number) {
	await act(async () => {
		list.dispatchEvent(new WheelEvent("wheel", { deltaY: direction, bubbles: true }));
	});
}

test("real modal loads at keyboard and scroll boundaries, keeps selected hit/focus through eviction, and backscroll restores it", async () => {
	search = async (cursor) => {
		const number = Number(cursor ?? 0);
		return { items: [hit(number)], index, nextCursor: number < 20 ? String(number + 1) : null };
	};
	const { input, list, activate } = await mount();
	assert.equal(document.activeElement, input);
	assert.doesNotMatch(document.body.textContent ?? "", /Load more|Refresh history|Continue searching|Next page/);
	await key(input, "ArrowDown");
	assert.deepEqual(reads, [undefined, "1"]);
	assert.equal(
		document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent?.startsWith("Result 1"),
		true,
	);
	await key(input, "Enter");
	assert.equal(activate.mock.calls[0]?.[0].conversationId, "conversation-1");
	for (let n = 0; n < 9; n++) await wheel(list, 100);
	assert.equal(list.querySelectorAll("button[role=option]").length, 8);
	assert.equal(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent, "Result 1");
	assert.equal(list.querySelectorAll('[aria-selected="true"]').length, 1);
	assert.equal(document.activeElement, input);
	const first = list.querySelector("button[role=option]")?.textContent;
	await wheel(list, -100);
	assert.notEqual(list.querySelector("button[role=option]")?.textContent, first);
	assert.equal(list.querySelector("button[role=option]")?.getAttribute("data-conversation-id"), "conversation-2");
});

test("empty scans yield without false empty or a polling loop and continue only on fresh input demand", async () => {
	search = async (cursor) => ({ items: [], index, nextCursor: String(Number(cursor ?? 0) + 1) });
	const { input, list } = await mount();
	assert.equal(reads.length, 16);
	assert.doesNotMatch(document.body.textContent ?? "", /No matching conversations/);
	await act(async () => vi.advanceTimersByTimeAsync(1000));
	assert.equal(reads.length, 16);
	await key(input, "ArrowDown");
	assert.equal(reads.length, 32);
	await wheel(list, 100);
	assert.equal(reads.length, 48);
});

test("real failures retain retry, index failures have recovery, and closing aborts a pending scroll request", async () => {
	refreshFails = true;
	const pending = Promise.withResolvers<ConversationSearchPage>();
	let signal: AbortSignal | undefined;
	search = async (cursor, incoming) => {
		if (!cursor) return { items: [hit(0)], index, nextCursor: "1" };
		signal = incoming;
		return pending.promise;
	};
	const { list, render } = await mount();
	assert.match(document.body.textContent ?? "", /History indexing stopped/);
	assert.ok(Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Retry"));
	await wheel(list, 100);
	assert.ok(signal && !signal.aborted);
	await render(false);
	assert.equal(signal.aborted, true);
	await act(async () => pending.resolve({ items: [hit(99)], index, nextCursor: null }));
	assert.equal(document.querySelector("[role=listbox]"), null);
});
