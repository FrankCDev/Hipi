import assert from "node:assert/strict";
import { Virtualizer } from "@tanstack/react-virtual";
import { test } from "vitest";
import { virtualRecentRange } from "../../../src/features/workbench/sidebar/virtual-recent-range.ts";

test("a far-scrolled public virtualizer keeps real protected keys without retaining every DOM row", () => {
	const virtualizer = new Virtualizer<HTMLElement, HTMLLIElement>({
		count: 600,
		getScrollElement: () => null,
		getItemKey: (index) => JSON.stringify(["physical", String(index)]),
		estimateSize: () => 36,
		initialRect: { width: 300, height: 360 },
		initialOffset: 500 * 36,
		overscan: 5,
		rangeExtractor: (range) => virtualRecentRange(range, [0, 599, 0, -1, 600]),
		observeElementRect: () => undefined,
		observeElementOffset: () => undefined,
		scrollToFn: () => {},
	});
	const items = virtualizer.getVirtualItems();
	assert.equal(items[0]?.key, '["physical","0"]');
	assert.equal(items.at(-1)?.key, '["physical","599"]');
	assert.ok(items.some((item) => item.index === 500));
	assert.ok(items.length <= 23);
	assert.equal(new Set(items.map((item) => item.key)).size, items.length);
	assert.equal(virtualizer.getTotalSize(), 600 * 36);
	const anchor = items.find((item) => item.index === 500);
	virtualizer.setOptions({ ...virtualizer.options, count: 650 });
	assert.equal(virtualizer.getTotalSize(), 650 * 36);
	assert.equal(virtualizer.getVirtualItems().find((item) => item.index === 500)?.start, anchor?.start);
});

test("protected scopes only extend the current public range by distinct eligible indices", () => {
	const range = virtualRecentRange({ startIndex: 300, endIndex: 309, overscan: 5, count: 1000 }, [2, 2, 900]);
	assert.equal(range.length, 22);
	assert.deepEqual(range, [2, ...Array.from({ length: 20 }, (_, index) => 295 + index), 900]);
});

test("offscreen focus retains real adjacent tab targets without mounting the intervening history", () => {
	const range = virtualRecentRange({ startIndex: 500, endIndex: 509, overscan: 5, count: 1000 }, [2], 2);
	assert.deepEqual(range.slice(0, 3), [1, 2, 3]);
	assert.equal(range.length, 23);
});
