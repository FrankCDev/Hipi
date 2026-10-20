import assert from "node:assert/strict";
import { test } from "node:test";
import { Virtualizer } from "@tanstack/react-virtual";
import { virtualMessageRange } from "../../../src/features/workbench/conversation/virtual-message-range.ts";

// Core layout model only: these are not browser scrolling/ResizeObserver acceptance tests.
function virtualizer(keys: string[], offset = 0) {
	return new Virtualizer<HTMLElement, HTMLDivElement>({
		count: keys.length,
		getItemKey: (index) => keys[index] ?? "missing",
		getScrollElement: () => null,
		estimateSize: () => 100,
		initialRect: { width: 800, height: 600 },
		initialOffset: offset,
		anchorTo: "end",
		followOnAppend: true,
		overscan: 5,
		observeElementRect: () => {},
		observeElementOffset: () => {},
		scrollToFn: () => {},
	});
}

test("virtual range remains viewport-sized with two thousand retained message previews", () => {
	const keys = Array.from({ length: 2000 }, (_, index) => `message:${index}`);
	const instance = virtualizer(keys, 100000);
	assert.ok(instance.getVirtualItems().length <= 17);
	assert.equal(instance.getTotalSize(), 200000);
	assert.ok(instance.getVirtualItems().some((item) => item.key === "message:1000"));
});

test("stable keyed prepend preserves reading anchor in the library layout model", () => {
	const keys = Array.from({ length: 100 }, (_, index) => `message:${index}`);
	const instance = virtualizer(keys, 2000);
	// Structural element double activates the library's mounted-list anchoring path.
	instance.scrollElement = { scrollTop: 2000, scrollHeight: 10000, clientHeight: 600 } as HTMLElement;
	instance.getVirtualItems();
	const next = ["older:0", "older:1", ...keys];
	instance.setOptions({ ...instance.options, count: next.length, getItemKey: (index) => next[index] ?? "missing" });
	assert.equal(instance.scrollOffset, 2200);
	assert.ok(instance.getVirtualItems().some((item) => item.key === "message:20"));
});

test("explicit selection range keeps selected rows mounted when viewport changes", () => {
	const instance = virtualizer(
		Array.from({ length: 100 }, (_, index) => `message:${index}`),
		2000,
	);
	const selected = instance.getVirtualIndexes();
	instance.setOptions({
		...instance.options,
		rangeExtractor: (range) => virtualMessageRange(range, selected, [], -1),
		anchorTo: "start",
		followOnAppend: false,
	});
	instance.scrollOffset = 6000;
	const indexes = instance.getVirtualIndexes();
	for (const index of selected) assert.ok(indexes.includes(index));
	assert.ok(indexes.includes(60));
	assert.ok(indexes.length <= 34);
});

test("selection extension pins its new endpoints without accumulating visited windows", () => {
	const range = { startIndex: 80, endIndex: 85, overscan: 5, count: 2000 };
	const initial = [10, 11, 12, 13];
	const indexes = virtualMessageRange(range, initial, [12, 45], 70);
	for (const index of [...initial, 45, 70, 80, 85]) assert.ok(indexes.includes(index));
	assert.ok(indexes.length <= 23);
	const moved = virtualMessageRange(range, initial, [12, 60], -1);
	assert.ok(moved.includes(60));
	assert.equal(moved.includes(45), false);
	const released = virtualMessageRange(range, null, [], -1);
	assert.equal(released.includes(12), false);
});
