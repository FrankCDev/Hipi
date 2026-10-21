// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { CatalogPagination, type CatalogViewportPages } from "../../../src/features/workbench/catalog/pagination.tsx";

test("viewport drives both directions without pagination controls, fences hidden/drag-like disabled demand and cancels hidden reads", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const region = createRef<HTMLDivElement>();
	let finish: (() => void) | undefined;
	const pages: CatalogViewportPages = {
		hasMore: true,
		hasPrevious: true,
		isFetching: false,
		isError: false,
		itemKeys: ["a", "b"],
		evictedKeys: () => [],
		cancelLoad: vi.fn(),
		loadMore: vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		),
		loadPrevious: vi.fn(async () => {}),
	};
	const render = (enabled = true) => (
		<div className="navigation-list" ref={region}>
			<button type="button" data-catalog-key="a">
				A
			</button>
			<button type="button" data-catalog-key="b">
				B
			</button>
			<CatalogPagination pages={pages} listRef={region} enabled={enabled} />
		</div>
	);
	const rect = (top: number, bottom: number) => ({
		top,
		bottom,
		left: 0,
		right: 100,
		width: 100,
		height: bottom - top,
		x: 0,
		y: top,
		toJSON() {},
	});
	const flush = async () => {
		await act(async () => {
			const batch = [...frames.values()];
			frames.clear();
			for (const callback of batch) callback(0);
		});
	};
	try {
		await act(async () => root.render(render()));
		const list = region.current;
		assert.ok(list);
		list.getBoundingClientRect = () => rect(0, 100);
		list.getClientRects = () => [rect(0, 100)] as unknown as DOMRectList;
		for (const [index, row] of [...list.querySelectorAll<HTMLElement>("[data-catalog-key]")].entries())
			row.getBoundingClientRect = () => rect(index * 40, index * 40 + 30);
		const edge = list.querySelector<HTMLElement>("[data-catalog-boundary]");
		assert.ok(edge);
		edge.getBoundingClientRect = () => rect(80, 80);
		assert.deepEqual(
			[...host.querySelectorAll("button")].map((button) => button.textContent),
			["A", "B"],
		);
		await flush();
		assert.equal(vi.mocked(pages.loadMore).mock.calls.length, 1);
		list.dispatchEvent(new Event("scroll"));
		await flush();
		assert.equal(vi.mocked(pages.loadMore).mock.calls.length, 1, "single flight");
		await act(async () => {
			finish?.();
		});
		list.scrollTop = 20;
		list.dispatchEvent(new Event("scroll"));
		list.scrollTop = 0;
		list.dispatchEvent(new Event("scroll"));
		await flush();
		assert.equal(vi.mocked(pages.loadPrevious).mock.calls.length, 1);
		await act(async () => root.render(render(false)));
		list.dispatchEvent(new Event("scroll"));
		await flush();
		assert.equal(vi.mocked(pages.loadMore).mock.calls.length, 1);
		// A hidden document cannot start background continuation.
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await act(async () => root.render(render()));
		await flush();
		assert.equal(vi.mocked(pages.loadMore).mock.calls.length, 1);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		list.scrollTop = 30;
		list.dispatchEvent(new Event("scroll"));
		await flush();
		assert.equal(vi.mocked(pages.loadMore).mock.calls.length, 2);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
		assert.ok(pages.cancelLoad);
		assert.equal(vi.mocked(pages.cancelLoad).mock.calls.length, 1);
		await act(async () => {
			finish?.();
		});
	} finally {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		await act(async () => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
