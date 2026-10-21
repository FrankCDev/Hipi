// @vitest-environment jsdom
import assert from "node:assert/strict";
import { Virtualizer } from "@tanstack/react-virtual";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, test, vi } from "vitest";
import { useHistoryViewport } from "../../../src/features/workbench/conversation/history/use-viewport.ts";
import { fitHistoryWindow, type HistoryViewport } from "../../../src/features/workbench/conversation/history/window.ts";
import type { TurnRow } from "../../../src/features/workbench/conversation/turns/contracts.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

test("one oversized virtual turn pins actual visible children, focus and selection rather than its whole membership", () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	let next = 0;
	const frames = new Map<number, FrameRequestCallback>();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++next, callback);
		return next;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	let observers = 0;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor() {
				observers++;
			}
			observe() {}
			disconnect() {
				observers--;
			}
		},
	);
	const messages = Array.from({ length: 2200 }, (_, index) => ({
		id: `m${index}`,
		role: "user" as const,
		text: `${index}`,
		textLength: `${index}`.length,
		truncated: false,
	}));
	const row: TurnRow = {
		key: "turn",
		runId: "run",
		kind: "turn",
		inputCoverage: "partial",
		children: messages.map((message) => ({ key: message.id, kind: "user-message", message })),
	};
	const reports: (HistoryViewport | null)[] = [];
	const report = (viewport: HistoryViewport | null) => reports.push(viewport);
	function View() {
		const node = useRef<HTMLElement>(null);
		const pending = useRef(false);
		const [virtualizer] = useState(
			() =>
				new Virtualizer<HTMLElement, HTMLDivElement>({
					count: 1,
					getScrollElement: () => node.current,
					estimateSize: () => 220_000,
					scrollToFn: () => {},
					observeElementRect: () => {},
					observeElementOffset: () => {},
					paddingEnd: 0,
				}),
		);
		useHistoryViewport(node, virtualizer, [row], pending, report);
		return (
			<section ref={node}>
				<div data-turn-key="turn">
					{messages.map((message) => (
						<div key={message.id} data-message-id={message.id}>
							<button type="button">{message.id}</button>
						</div>
					))}
				</div>
			</section>
		);
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	act(() => root.render(<View />));
	const node = host.querySelector("section");
	assert.ok(node);
	Object.defineProperty(node, "clientHeight", { value: 200 });
	node.scrollTop = 10_000;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const index = Number(this.dataset.messageId?.slice(1));
		const top = this === node ? 0 : Number.isFinite(index) ? index * 100 - 10_000 : 0;
		return new DOMRect(0, top, 500, this === node ? 200 : 100);
	});
	const flush = () =>
		act(() => {
			for (const [id, callback] of [...frames]) {
				frames.delete(id);
				callback(performance.now());
			}
		});
	flush();
	let state = reports.at(-1);
	assert.ok(state);
	assert.deepEqual([...state.pinnedIds], ["m100", "m101"]);
	assert.ok(
		fitHistoryWindow(messages, "older", state),
		"Offscreen children can leave the payload window even within the same virtual turn",
	);
	assert.equal(node.scrollTop, 10_000, "Read-only adapter never moves the scroll owner");
	const focused = host.querySelector<HTMLButtonElement>('[data-message-id="m2100"] button');
	assert.ok(focused);
	act(() => focused.focus());
	flush();
	state = reports.at(-1);
	assert.ok(state);
	assert.ok(state.pinnedIds.has("m2100"));
	assert.equal(fitHistoryWindow(messages, "older", state), undefined);
	act(() => focused.blur());
	flush();
	act(() => {
		const range = document.createRange();
		range.selectNodeContents(node);
		document.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	state = reports.at(-1);
	assert.ok(state);
	assert.equal(state.paused, true);
	assert.equal(state.pinnedIds.size, 2200);
	act(() => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	flush();
	assert.equal(reports.at(-1)?.paused, false);
	act(() => node.dispatchEvent(new Event("dragstart")));
	assert.equal(reports.at(-1)?.paused, true);
	act(() => window.dispatchEvent(new Event("dragend")));
	flush();
	assert.equal(reports.at(-1)?.paused, false);
	act(() => root.unmount());
	assert.equal(reports.at(-1), null);
	assert.equal(frames.size, 0);
	assert.equal(observers, 0);
});
