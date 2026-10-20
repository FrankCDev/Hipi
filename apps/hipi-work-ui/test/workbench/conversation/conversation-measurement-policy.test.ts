import assert from "node:assert/strict";
import { test } from "node:test";
import { Virtualizer } from "@tanstack/react-virtual";
import { MessageMeasurementPolicy } from "../../../src/features/workbench/conversation/message-measurement-policy.ts";

// Policy/real-core dispatch tests with structural elements, not browser layout.
function fixture(keys = Array.from({ length: 100 }, (_, index) => `message:${index}`)) {
	let blocked = false;
	const policy = new MessageMeasurementPolicy<HTMLElement, HTMLDivElement>(
		() => blocked,
		(node) => node.clientHeight,
	);
	const instance = new Virtualizer<HTMLElement, HTMLDivElement>({
		count: keys.length,
		getItemKey: (index) => keys[index] ?? `missing:${index}`,
		getScrollElement: () => null,
		estimateSize: () => 100,
		initialRect: { width: 800, height: 600 },
		initialOffset: 2025,
		measureElement: policy.measureElement,
		observeElementRect: () => {},
		observeElementOffset: () => {},
		scrollToFn: () => {},
	});
	instance.getVirtualItems();
	return {
		policy,
		instance,
		block(value: boolean) {
			blocked = value;
		},
		measure(index: number, size: number) {
			const node: Partial<HTMLDivElement> = {
				isConnected: true,
				clientHeight: size,
				getAttribute: () => String(index),
			};
			instance.measureElement(node as HTMLDivElement);
			instance.getVirtualItems();
		},
		adjust(index: number) {
			const item = instance.getVirtualItems().find((candidate) => candidate.index === index);
			assert.ok(item);
			return policy.shouldAdjust(item, 400, instance);
		},
		replace(next: string[]) {
			instance.setOptions({
				...instance.options,
				count: next.length,
				getItemKey: (index) => next[index] ?? `missing:${index}`,
			});
			policy.synchronize(instance);
			instance.getVirtualItems();
		},
	};
}

test("estimate-equal first measurement becomes a remeasurement before later fold-spanning growth", () => {
	const model = fixture();
	model.measure(20, 100);
	assert.equal(model.adjust(20), true);
	model.measure(20, 500);
	assert.equal(model.adjust(20), false);
	assert.equal(model.instance.scrollOffset, 2025);
	model.measure(20, 70);
	assert.equal(model.instance.scrollOffset, 2025);
});

test("first actual height above the fold compensates in either scroll direction", () => {
	for (const direction of ["forward", "backward"] as const) {
		const model = fixture();
		model.instance.scrollDirection = direction;
		model.measure(20, 500);
		assert.equal(model.instance.scrollOffset, 2425);
	}
});

test("remeasurements compensate entirely above the fold except during upward scrolling", () => {
	for (const direction of ["forward", "backward"] as const) {
		const model = fixture();
		model.measure(18, 100);
		model.instance.scrollDirection = direction;
		model.measure(18, 140);
		assert.equal(model.instance.scrollOffset, direction === "forward" ? 2065 : 2025);
	}
});

test("selection suppresses both first and repeat measurement compensation, then releases", () => {
	const model = fixture();
	model.block(true);
	model.measure(18, 140);
	model.measure(18, 180);
	assert.equal(model.instance.scrollOffset, 2025);
	model.block(false);
	model.measure(18, 200);
	assert.equal(model.instance.scrollOffset, 2045);
});

test("virtual unmount retains a measurement but removing and reintroducing its key does not", () => {
	const keys = Array.from({ length: 100 }, (_, index) => `message:${index}`);
	keys[20] = "partial-output";
	const model = fixture(keys);
	model.measure(20, 100);
	model.instance.measureElement(null);
	model.measure(20, 100);
	assert.equal(model.adjust(20), false);
	model.replace(keys.map((key) => (key === "partial-output" ? "message:final" : key)));
	model.replace(keys);
	model.measure(20, 100);
	assert.equal(model.adjust(20), true);
});

test("retention follows stable keys through prepend and clearing resets the display lifetime", () => {
	const keys = Array.from({ length: 100 }, (_, index) => `message:${index}`);
	const model = fixture(keys);
	model.measure(20, 100);
	model.replace(["older", ...keys]);
	model.instance.scrollOffset = 2125;
	model.measure(21, 100);
	assert.equal(model.adjust(21), false);
	model.policy.clear();
	model.measure(21, 100);
	assert.equal(model.adjust(21), true);
});

test("measurements for different rows keep independent first-measure decisions", () => {
	const model = fixture();
	model.measure(20, 100);
	model.measure(20, 100);
	model.measure(19, 100);
	assert.equal(model.adjust(20), false);
	assert.equal(model.adjust(19), true);
});

test("production default measurement records an estimate-equal DOM read before later growth", () => {
	const model = fixture();
	const policy = new MessageMeasurementPolicy(() => false);
	model.instance.setOptions({ ...model.instance.options, measureElement: policy.measureElement });
	let height = 100;
	const row: Partial<HTMLDivElement> = {
		isConnected: true,
		get offsetHeight() {
			return height;
		},
		getAttribute: () => "20",
	};
	model.instance.measureElement(row as HTMLDivElement);
	height = 500;
	model.instance.measureElement(row as HTMLDivElement);
	assert.equal(model.instance.scrollOffset, 2025);
	assert.equal(model.instance.getVirtualItems().find((item) => item.index === 20)?.size, 500);
});
