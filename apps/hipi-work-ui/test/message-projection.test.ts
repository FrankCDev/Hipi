import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MESSAGE_DISPLAY_INTERVAL_MS,
	MessageProjection,
	selectionIntersects,
} from "../src/features/workbench/message-projection.ts";

test("stream updates coalesce to latest and disposal cancels pending delivery", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: number[] = [];
	const projection = new MessageProjection(
		0,
		(value) => seen.push(value),
		() => false,
	);
	for (let index = 1; index <= 1000; index++) projection.update(index, true);
	assert.deepEqual(seen, []);
	context.mock.timers.tick(MESSAGE_DISPLAY_INTERVAL_MS);
	assert.deepEqual(seen, [1000]);
	projection.update(1001, true);
	projection.dispose();
	context.mock.timers.tick(MESSAGE_DISPLAY_INTERVAL_MS);
	projection.update(1002, false);
	projection.flush();
	assert.deepEqual(seen, [1000]);
});

test("selection freezes partial and final replacement and release publishes only latest", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let selected = false;
	const seen: string[] = [];
	const paused: boolean[] = [];
	const projection = new MessageProjection(
		"",
		(value) => seen.push(value),
		() => selected,
		(value) => paused.push(value),
	);
	projection.update("partial", true);
	selected = true;
	context.mock.timers.tick(MESSAGE_DISPLAY_INTERVAL_MS);
	projection.update("newer partial", true);
	projection.update("canonical final", false);
	projection.flush();
	assert.deepEqual(seen, []);
	assert.deepEqual(paused, [true]);
	selected = false;
	projection.flush();
	assert.deepEqual(seen, ["canonical final"]);
	assert.deepEqual(paused, [true, false]);
	projection.flush();
	assert.deepEqual(seen, ["canonical final"]);
	projection.dispose();
});

test("pending hint changes only on transitions, never for every blocked token or after disposal", () => {
	let selected = true;
	const paused: boolean[] = [];
	const seen: number[] = [];
	const projection = new MessageProjection(
		0,
		(value) => seen.push(value),
		() => selected,
		(value) => paused.push(value),
	);
	projection.flush();
	assert.deepEqual(paused, []);
	for (let index = 1; index <= 1000; index++) projection.update(index, true);
	projection.update(1001, false);
	assert.deepEqual(paused, [true]);
	assert.deepEqual(seen, []);
	selected = false;
	projection.flush();
	assert.deepEqual(paused, [true, false]);
	assert.deepEqual(seen, [1001]);
	projection.dispose();
	selected = true;
	projection.update(1002, false);
	assert.deepEqual(paused, [true, false]);
});

test("final flush cancels older timer; interrupted canonical projection is immediate", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: string[] = [];
	const projection = new MessageProjection(
		"",
		(value) => seen.push(value),
		() => false,
	);
	projection.update("healed partial", true);
	projection.update("interrupted original", false);
	context.mock.timers.tick(MESSAGE_DISPLAY_INTERVAL_MS);
	assert.deepEqual(seen, ["interrupted original"]);
	projection.dispose();
});

test("range intersection detects crossing selection even when endpoints are outside", () => {
	// Structural DOM doubles test the predicate, not browser selection behavior.
	const root = {} as HTMLElement;
	const selection = {
		isCollapsed: false,
		rangeCount: 2,
		getRangeAt: (index: number) => ({ intersectsNode: (node: HTMLElement) => index === 1 && node === root }),
	} as Selection;
	assert.equal(selectionIntersects(root, selection), true);
	assert.equal(selectionIntersects(root, { ...selection, isCollapsed: true } as Selection), false);
	assert.equal(selectionIntersects(null, selection), false);
	assert.equal(selectionIntersects(root, null), false);
});
