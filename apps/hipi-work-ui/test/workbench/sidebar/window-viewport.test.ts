import assert from "node:assert/strict";
import { test } from "vitest";
import { captureWindowAnchor, restoreWindowAnchor } from "../../../src/features/workbench/sidebar/window-viewport.ts";

function fixture() {
	let top = 120;
	const row = {
		dataset: { workspaceId: "physical", conversationId: "selected" },
		getBoundingClientRect: () => ({ top, bottom: top + 36 }),
	} as unknown as HTMLElement;
	const other = {
		dataset: { workspaceId: "physical", conversationId: "other" },
		getBoundingClientRect: () => ({ top: 20, bottom: 56 }),
	} as unknown as HTMLElement;
	const region = { querySelectorAll: () => [other, row] } as unknown as HTMLElement;
	const scrollport = {
		scrollTop: 200,
		getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
	} as unknown as HTMLElement;
	return {
		row,
		region,
		scrollport,
		setTop: (value: number) => {
			top = value;
		},
	};
}
test("compaction preserves a measured visible canonical anchor, not estimated row or global height", () => {
	const f = fixture();
	const anchor = captureWindowAnchor(f.region, f.scrollport);
	assert.equal(anchor?.element, f.row);
	assert.equal(anchor.offset, 20);
	f.setTop(48);
	restoreWindowAnchor(anchor, f.region, f.scrollport);
	assert.equal(f.scrollport.scrollTop, 128);
	f.setTop(145);
	const resized = captureWindowAnchor(f.region, f.scrollport);
	f.setTop(170);
	restoreWindowAnchor(resized, f.region, f.scrollport);
	assert.equal(f.scrollport.scrollTop, 153);
});
test("missing or out-of-viewport anchor never fabricates a scroll position", () => {
	const f = fixture();
	f.setTop(500);
	assert.equal(captureWindowAnchor(f.region, f.scrollport), undefined);
	restoreWindowAnchor(undefined, f.region, f.scrollport);
	assert.equal(f.scrollport.scrollTop, 200);
});

test("measured anchor compensation alone does not preserve the scrollbar thumb during bounded compaction", () => {
	const f = fixture();
	// Deterministic geometry model, not a native-browser scrollbar acceptance test.
	const measuredRowExtent = 36;
	const retainedHeight = 250 * measuredRowExtent;
	const viewportHeight = 300;
	f.scrollport.scrollTop = 200 * measuredRowExtent;
	const before = f.scrollport.scrollTop / (retainedHeight - viewportHeight);
	const anchor = captureWindowAnchor(f.region, f.scrollport);
	f.setTop(120 - 50 * measuredRowExtent);
	restoreWindowAnchor(anchor, f.region, f.scrollport);
	const after = f.scrollport.scrollTop / (retainedHeight - viewportHeight);
	assert.ok(before - after > 0.2);
	assert.equal(f.scrollport.scrollTop, 150 * measuredRowExtent);
});
