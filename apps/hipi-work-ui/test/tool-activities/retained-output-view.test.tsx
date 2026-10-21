// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type AppClient, type Method, type Params, parseResult, type ToolActivity } from "@hipi/work-runtime/contracts";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ActivityOutputSession, type ActivityOutputSlot } from "../../src/features/tool-activities/output-session.ts";
import { RetainedOutputView, retainedOutputWindow } from "../../src/features/tool-activities/retained-output-view.tsx";

let visible = true;
let pageVisible = true;
vi.mock("framer-motion", () => ({ useInView: () => visible, usePageInView: () => pageVisible }));
const activity: ToolActivity = {
	activityId: "task:1",
	callId: "1",
	toolName: "read",
	source: "task",
	inherited: false,
	phase: "terminal",
	toolResult: "success",
	abortRequested: false,
	receiptIds: [],
	textAvailable: true,
	outputTruncated: false,
};
let root: Root;
let host: HTMLDivElement;
let session: ActivityOutputSession;
let failed = false;
const calls: number[] = [];
let notify: (slots: ReadonlyMap<string, ActivityOutputSlot>) => void = () => {};
const client: AppClient = {
	async call<M extends Method>(method: M, params: Params<M>) {
		assert.equal(method, "getToolActivityText");
		const input = params as Params<"getToolActivityText">;
		const index = input.cursor === undefined ? 0 : Number(input.cursor);
		calls.push(index);
		if (failed) throw new Error("read unavailable");
		return parseResult(method, {
			activityId: input.activityId,
			text: `part-${index}`,
			nextCursor: index === 5 ? null : String(index + 1),
			retainedOutputOnly: true,
		});
	},
	observe: async () => ({ dispose: async () => {} }),
};
function View({ disabled = false }: { disabled?: boolean }) {
	const [slots, setSlots] = useState(session.snapshot());
	useEffect(() => {
		notify = setSlots;
		setSlots(session.snapshot());
		return () => {
			notify = () => {};
		};
	}, []);
	return (
		<RetainedOutputView
			activityId="task:1"
			session={session}
			slot={slots.get("task:1")}
			disabled={disabled}
			locale="en"
		/>
	);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	visible = true;
	pageVisible = true;
	failed = false;
	calls.length = 0;
	host = document.createElement("div");
	host.className = "conversation-panel";
	document.body.append(host);
	root = createRoot(host);
	session = new ActivityOutputSession(client, { workspaceId: "w", conversationId: "c" }, (slots) => notify(slots));
	session.activate();
	session.validate([activity]);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.classList.contains("retained-output-viewport")) return new DOMRect(0, 0, 400, 192);
		if (this.dataset.outputChunk !== undefined) {
			const viewport = this.closest<HTMLElement>(".retained-output-viewport");
			const first = viewport?.querySelector<HTMLElement>("[data-output-chunk]");
			const top =
				(Number(this.dataset.outputChunk) - Number(first?.dataset.outputChunk ?? 0)) * 1000 -
				(viewport?.scrollTop ?? 0);
			return new DOMRect(0, top, 400, 1000);
		}
		return new DOMRect(0, 0, 400, 192);
	});
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("retained-output-viewport") ? 192 : 0;
	});
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.querySelectorAll("[data-output-chunk]").length * 1000;
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	session.dispose();
	host.remove();
	document.getSelection()?.removeAllRanges();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render(disabled = false) {
	await act(async () => root.render(<View disabled={disabled} />));
}
async function scroll(top: number) {
	const viewport = host.querySelector<HTMLElement>(".retained-output-viewport");
	assert.ok(viewport);
	await act(async () => {
		viewport.scrollTop = top;
		viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	return viewport;
}
test("one initial chunk, no transport buttons, scroll appends exact text without replacing old content", async () => {
	await render();
	assert.deepEqual(calls, [0]);
	const first = host.querySelector('[data-output-chunk="0"]');
	assert.ok(first);
	assert.equal(host.querySelector("button"), null);
	await scroll(900);
	assert.deepEqual(calls, [0, 1]);
	assert.equal(host.querySelector('[data-output-chunk="0"]'), first);
	assert.equal(host.querySelector("pre")?.textContent, "part-0part-1");
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
	assert.deepEqual(calls, [0, 1], "successful output must not drain unseen history");
});
test("forward eviction and backward prepend preserve the visible chunk anchor", async () => {
	await render();
	await scroll(900);
	await scroll(1800);
	const anchor = host.querySelector('[data-output-chunk="2"]');
	assert.ok(anchor);
	const viewport = await scroll(2800);
	assert.deepEqual(calls, [0, 1, 2, 3]);
	assert.equal(host.querySelector('[data-output-chunk="0"]'), null);
	assert.equal(host.querySelector('[data-output-chunk="2"]'), anchor);
	assert.equal(viewport.scrollTop, 1800, "subtract precisely the evicted offscreen extent");
	await act(async () => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
	await scroll(0);
	assert.equal(calls.at(-1), 0);
	assert.equal(viewport.scrollTop, 1000, "prepend restores the same visible point");
	assert.equal(host.querySelectorAll("[data-output-chunk]").length, 3);
});
test("selected text does not move or trigger another read until selection is released", async () => {
	await render();
	const first = host.querySelector('[data-output-chunk="0"]');
	assert.ok(first);
	const range = document.createRange();
	range.selectNodeContents(first);
	await act(async () => {
		document.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	await scroll(900);
	assert.deepEqual(calls, [0]);
	assert.equal(host.querySelector('[data-output-chunk="0"]'), first);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	await scroll(901);
	assert.deepEqual(calls, [0, 1]);
});
test("disconnect and hidden pages stop demand; only real failures expose a retry action", async () => {
	await render();
	await render(true);
	await scroll(900);
	assert.deepEqual(calls, [0]);
	await render();
	pageVisible = false;
	await render();
	await scroll(901);
	assert.deepEqual(calls, [0]);
	pageVisible = true;
	await render();
	failed = true;
	await scroll(902);
	assert.equal(
		host.querySelector('[role="alert"]')?.textContent,
		"Records could not be read. Existing evidence may be out of date. Retry the read.",
	);
	assert.equal(host.querySelector("pre")?.textContent, "part-0");
	const retry = host.querySelector<HTMLButtonElement>("button");
	assert.equal(retry?.textContent, "Retry read");
	failed = false;
	await act(async () => retry?.click());
	assert.equal(host.querySelector("pre")?.textContent, "part-0part-1");
	assert.equal(host.querySelector("button"), null);
});
test("non-adjacent cached chunks are not joined into a fabricated continuous result", () => {
	const chunks = [0, 4, 5].map((index) => ({
		index,
		bytes: 100,
		page: {
			activityId: "task:1",
			text: `part-${index}`,
			nextCursor: String(index + 1),
			retainedOutputOnly: true as const,
		},
	}));
	assert.deepEqual(
		retainedOutputWindow(chunks, 0).map((chunk) => chunk.index),
		[0],
	);
	assert.deepEqual(
		retainedOutputWindow(chunks, 4).map((chunk) => chunk.index),
		[4, 5],
	);
	assert.deepEqual(retainedOutputWindow(chunks, 3), []);
});

test("leaving the viewport releases payload slots and coming back restores the reader's position", async () => {
	await render();
	await scroll(900);
	await scroll(1800);
	await scroll(2800);
	visible = false;
	await render();
	assert.equal(session.snapshot().size, 0);
	const count = calls.length;
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
	assert.equal(calls.length, count);
	visible = true;
	await render();
	assert.ok(host.querySelector('[data-output-chunk="2"]'));
	assert.equal(host.querySelector<HTMLElement>(".retained-output-viewport")?.scrollTop, 800);
});

test("evicting a partial soft line retains its measured horizontal origin without adding text", async () => {
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
		const index = this.dataset.outputChunk;
		const rectangles = index === undefined ? [] : [new DOMRect(Number(index) * 25, 0, 100, 20)];
		return {
			...rectangles,
			length: rectangles.length,
			item: (position: number) => rectangles[position] ?? null,
			[Symbol.iterator]: () => rectangles[Symbol.iterator](),
		};
	});
	await render();
	await scroll(900);
	await scroll(1800);
	await scroll(2800);
	const origin = host.querySelector<HTMLElement>(".retained-output-line-origin");
	assert.equal(origin?.style.width, "25px");
	assert.equal(host.querySelector("pre")?.textContent, "part-1part-2part-3");
	assert.equal(origin?.getAttribute("aria-hidden"), "true");
});
