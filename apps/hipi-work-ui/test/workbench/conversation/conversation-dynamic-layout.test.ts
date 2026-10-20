import assert from "node:assert/strict";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { type Rect, Virtualizer } from "@tanstack/react-virtual";
import { MessageMeasurementPolicy } from "../../../src/features/workbench/conversation/message-measurement-policy.ts";

// Adapter-level layout model, not a DOM, React, ResizeObserver or browser benchmark.
// The element double only models scroll clamping and committed sizer dimensions.
function layout(count = 100, initialOffset = 2025, useMeasurementPolicy = false) {
	const initialKeys = Array.from({ length: count }, (_, index) => `message:${index}`);
	let keys = initialKeys;
	let rect: Rect = { width: 800, height: 600 };
	let observeOffset: ((offset: number, scrolling: boolean) => void) | undefined;
	let observeRect: ((rect: Rect) => void) | undefined;
	const element = {
		scrollTop: initialOffset,
		scrollHeight: count * 100,
		clientHeight: 600,
		ownerDocument: { defaultView: null },
	};
	const writes: number[] = [];
	const policy = useMeasurementPolicy
		? new MessageMeasurementPolicy<HTMLElement, Element>(
				() => false,
				(node) => node.clientHeight,
			)
		: undefined;
	const instance = new Virtualizer<HTMLElement, Element>({
		count,
		// Local structural double at the adapter boundary; never passed to DOM APIs.
		getScrollElement: () => element as HTMLElement,
		getItemKey: (index) => initialKeys[index] ?? `missing:${index}`,
		estimateSize: () => 100,
		measureElement: policy?.measureElement ?? ((node) => node.clientHeight),
		initialRect: rect,
		initialOffset,
		anchorTo: "end",
		followOnAppend: true,
		scrollEndThreshold: 64,
		overscan: 5,
		observeElementRect: (_instance, callback) => {
			observeRect = callback;
			callback(rect);
			return () => {
				observeRect = undefined;
			};
		},
		observeElementOffset: (_instance, callback) => {
			observeOffset = callback;
			callback(element.scrollTop, false);
			return () => {
				observeOffset = undefined;
			};
		},
		scrollToFn: (offset, { adjustments = 0 }) => {
			element.scrollTop = Math.max(0, Math.min(offset + adjustments, element.scrollHeight - element.clientHeight));
			writes.push(element.scrollTop);
		},
	});
	// These are the exported adapter lifecycle entry points used by react-virtual.
	const unmount = instance._didMount();
	function measure(index: number, size: number) {
		// Structural measurement boundary, not a real element/ResizeObserver.
		const row: Partial<Element> = { isConnected: true, clientHeight: size, getAttribute: () => String(index) };
		instance.measureElement(row as Element);
	}
	function commit() {
		policy?.synchronize(instance);
		element.scrollHeight = instance.getTotalSize();
		instance._willUpdate();
		observeOffset?.(element.scrollTop, false);
		instance.getVirtualItems();
	}
	commit();
	return {
		instance,
		element,
		writes,
		dispose() {
			unmount();
			policy?.clear();
		},
		commit,
		get keys() {
			return keys;
		},
		resize(index: number, size: number) {
			if (policy) measure(index, size);
			else instance.resizeItem(index, size);
			commit();
		},
		measure(index: number, size: number) {
			measure(index, size);
			commit();
		},
		replace(next: string[], beforeCommit: ReadonlyArray<{ index: number; size: number }> = []) {
			// Capture the previous immutable key list: setOptions compares both lists.
			keys = next;
			instance.setOptions({
				...instance.options,
				count: next.length,
				getItemKey: (index) => next[index] ?? `missing:${index}`,
			});
			for (const measurement of beforeCommit) {
				if (policy) measure(measurement.index, measurement.size);
				else instance.resizeItem(measurement.index, measurement.size);
			}
			commit();
		},
		viewport(width: number) {
			rect = { ...rect, width };
			observeRect?.(rect);
			commit();
		},
		stopFollowing() {
			instance.cancelScroll();
			instance.setOptions({ ...instance.options, followOnAppend: false, scrollEndThreshold: -1 });
		},
		position(key: string) {
			const item = instance.getVirtualItems().find((candidate) => candidate.key === key);
			assert.ok(item, `Expected ${key} in the rendered range`);
			return item.start - element.scrollTop;
		},
	};
}

test("stable ID expansion and above-viewport tool collapse preserve the reading anchor", (t) => {
	const model = layout();
	t.after(model.dispose);
	const before = model.position("message:20");
	model.resize(5, 350);
	assert.equal(model.element.scrollTop, 2275);
	assert.equal(model.position("message:20"), before);
	model.resize(5, 40);
	assert.equal(model.element.scrollTop, 1965);
	assert.equal(model.position("message:20"), before);
	assert.ok(model.writes.includes(2275));
});

test("explicit intent inside 24px stops resize following without losing stable-key prepend anchoring", (t) => {
	const model = layout(100, 9390, true);
	t.after(model.dispose);
	assert.equal(model.instance.isAtEnd(24), true);
	model.stopFollowing();
	model.resize(99, 500);
	assert.equal(model.element.scrollTop, 9390);
	model.replace(["older:0", "older:1", ...model.keys]);
	assert.equal(model.element.scrollTop, 9590);
	model.resize(101, 700);
	assert.equal(model.element.scrollTop, 9590);
});

test("growth and shrink of an already measured row spanning the fold do not drag the reader", (t) => {
	const model = layout();
	t.after(model.dispose);
	model.resize(20, 101); // A nonzero delta establishes a cached measurement.
	model.resize(20, 500);
	assert.equal(model.element.scrollTop, 2026);
	assert.equal(model.position("message:20"), -26);
	model.resize(20, 70);
	assert.equal(model.element.scrollTop, 2026);
	assert.equal(model.position("message:20"), -26);
});

test("bottom streaming increments follow the new end, including stale-sizer clamping", (t) => {
	const model = layout(100, 9400);
	t.after(model.dispose);
	for (const size of [140, 220, 410, 180]) {
		model.resize(99, size);
		assert.equal(model.element.scrollTop, 9300 + size);
		assert.equal(model.instance.getDistanceFromEnd(), 0);
	}
});

test("known library limitation: estimate-equal first measurement still compensates later fold-spanning growth", (t) => {
	for (const entryPoint of ["resize", "measure"] as const) {
		const model = layout();
		t.after(model.dispose);
		model[entryPoint](20, 100);
		model[entryPoint](20, 500);
		// Characterization, not desired UX: equal estimate does not establish a
		// cached measurement in core 3.19.6, so later growth counts as first measure.
		assert.equal(model.element.scrollTop, 2425, entryPoint);
		assert.equal(model.position("message:20"), -425, entryPoint);
	}
});

test("off-bottom streaming and append retain the reader rather than follow", (t) => {
	const model = layout();
	t.after(model.dispose);
	model.resize(99, 700);
	model.replace([...model.keys, "message:100"]);
	assert.equal(model.element.scrollTop, 2025);
	assert.equal(model.position("message:20"), -25);
	assert.equal(model.instance.isAtEnd(), false);
});

test("same-count partial-to-final key replacement honors explicitly captured bottom intent", (t) => {
	for (const offset of [2025, 9400]) {
		const model = layout(100, offset);
		t.after(model.dispose);
		model.replace([...model.keys.slice(0, -1), "partial-output"]);
		model.resize(99, 300);
		const followFinal = model.instance.isAtEnd();
		model.replace([...model.keys.slice(0, -1), "message:final"]);
		// Mirrors the application's explicit final-publication policy. The library
		// cannot infer stream completion from an unrelated key at the same count.
		if (followFinal) {
			model.instance.scrollToEnd();
			model.commit();
		}
		model.resize(99, 520);
		assert.equal(model.element.scrollTop, followFinal ? 9820 : 2025);
		if (!followFinal) assert.equal(model.position("message:20"), -25);
		assert.equal(model.instance.isAtEnd(), followFinal);
	}
});

test("prepend and existing-row resize preserve the same key and pixel anchor in either order", (t) => {
	for (const resizeFirst of [true, false]) {
		const model = layout();
		t.after(model.dispose);
		if (resizeFirst) model.resize(5, 350);
		model.replace(["older:0", "older:1", ...model.keys]);
		if (!resizeFirst) model.resize(7, 350);
		model.resize(0, 180);
		assert.equal(model.element.scrollTop, 2555);
		assert.equal(model.position("message:20"), -25);
	}
});

test("wider viewport followed by measured wrapping changes retains the visible anchor", (t) => {
	const model = layout();
	t.after(model.dispose);
	model.resize(18, 300);
	const before = model.position("message:20");
	model.viewport(1200);
	// Width notification alone does not reflow text in Node. Supply the heights
	// a browser's row ResizeObserver would report after wrapping changes.
	model.resize(18, 140);
	model.resize(19, 70);
	assert.equal(model.element.scrollTop, 2035);
	assert.equal(model.position("message:20"), before);
	assert.equal(model.instance.scrollRect?.width, 1200);
});

test("prepend and multiple resize reports before the next committed sizer keep the reading anchor", (t) => {
	const model = layout();
	t.after(model.dispose);
	model.replace(
		["older:0", "older:1", ...model.keys],
		[
			{ index: 7, size: 350 },
			{ index: 0, size: 180 },
		],
	);
	assert.equal(model.element.scrollTop, 2555);
	assert.equal(model.position("message:20"), -25);
});

test("small deterministic dynamic-layout timing sample (not a browser performance budget)", (t) => {
	const samples: number[] = [];
	let maximumRendered = 0;
	for (let run = 0; run < 6; run++) {
		const model = layout(2000, 100025);
		const start = performance.now();
		for (let update = 0; update < 40; update++) {
			model.resize(990 + (update % 8), 80 + (update % 7) * 30);
			maximumRendered = Math.max(maximumRendered, model.instance.getVirtualItems().length);
			assert.equal(model.position("message:1000"), -25);
		}
		const elapsed = performance.now() - start;
		model.dispose();
		if (run > 0) samples.push(elapsed);
	}
	assert.ok(maximumRendered <= 20);
	t.diagnostic(
		JSON.stringify({
			node: process.version,
			os: `${platform()} ${release()}`,
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
			rows: 2000,
			updatesPerSample: 40,
			warmupSamples: 1,
			measuredSamples: samples.length,
			milliseconds: samples,
			maximumRendered,
		}),
	);
});

test("application measurement policy fixes equal-estimate growth while preserving prepend and width anchors", (t) => {
	const model = layout(100, 2025, true);
	t.after(model.dispose);
	model.measure(20, 100);
	model.measure(20, 500);
	assert.equal(model.element.scrollTop, 2025);
	assert.equal(model.position("message:20"), -25);
	model.resize(5, 350);
	assert.equal(model.element.scrollTop, 2275);
	model.resize(5, 40);
	assert.equal(model.element.scrollTop, 1965);
	model.replace(["older:0", "older:1", ...model.keys], [{ index: 0, size: 180 }]);
	assert.equal(model.element.scrollTop, 2245);
	assert.equal(model.position("message:20"), -25);
	model.viewport(1200);
	model.resize(7, 30);
	assert.equal(model.element.scrollTop, 2235);
	assert.equal(model.position("message:20"), -25);
});

test("application measurement policy retains bottom streaming and same-count final intent without pulling non-bottom readers", (t) => {
	for (const offset of [2025, 9400]) {
		const model = layout(100, offset, true);
		t.after(model.dispose);
		model.replace([...model.keys.slice(0, -1), "partial-output"]);
		for (const size of [100, 140, 220, 410, 180]) {
			model.resize(99, size);
			assert.equal(model.element.scrollTop, offset === 9400 ? 9300 + size : offset);
		}
		const followFinal = model.instance.isAtEnd();
		model.replace([...model.keys.slice(0, -1), "message:final"]);
		if (followFinal) {
			model.instance.scrollToEnd();
			model.commit();
		}
		model.resize(99, 520);
		assert.equal(model.element.scrollTop, followFinal ? 9820 : 2025);
		assert.equal(model.instance.isAtEnd(), followFinal);
		if (!followFinal) assert.equal(model.position("message:20"), -25);
	}
});
