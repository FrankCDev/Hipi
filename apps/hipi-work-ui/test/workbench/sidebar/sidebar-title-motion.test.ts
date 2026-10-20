import assert from "node:assert/strict";
import { test } from "vitest";
import { sidebarTitleMotion } from "../../../src/features/workbench/sidebar/title-motion.ts";

const geometry = { contentWidth: 240, viewportWidth: 100, fontSize: 14, direction: "ltr" as const };

test("title movement holds for 350 ms, travels two font sizes per second and stops at the actual end", () => {
	assert.deepEqual(sidebarTitleMotion(geometry), {
		direction: "ltr",
		distancePx: 140,
		offsetPx: -140,
		delayMs: 350,
		durationMs: 5000,
		totalDurationMs: 5350,
	});
});

test("subpixel overflow is ignored until it reaches one layout pixel", () => {
	for (const contentWidth of [0, 40, 100, 100.25, 100.999]) {
		assert.equal(sidebarTitleMotion({ ...geometry, contentWidth }), null);
	}
	assert.equal(sidebarTitleMotion({ ...geometry, contentWidth: 101 })?.distancePx, 1);
});

test("zoomed fractional measurements produce the same distance and duration as layout pixels", () => {
	const expected = sidebarTitleMotion({ ...geometry, contentWidth: 240.25, viewportWidth: 100.25 });
	for (const scaleX of [0.75, 1.25, 1.5, 2]) {
		assert.deepEqual(
			sidebarTitleMotion({ ...geometry, contentWidth: 240.25 * scaleX, viewportWidth: 100.25 * scaleX, scaleX }),
			expected,
		);
		assert.equal(
			sidebarTitleMotion({ ...geometry, contentWidth: 100.75 * scaleX, viewportWidth: 100 * scaleX, scaleX }),
			null,
		);
	}
});

test("RTL reverses translation without changing the hold, travel distance or speed", () => {
	const left = sidebarTitleMotion(geometry);
	const right = sidebarTitleMotion({ ...geometry, direction: "rtl" });
	assert.ok(left && right);
	assert.equal(right.offsetPx, -left.offsetPx);
	assert.equal(right.durationMs, left.durationMs);
	assert.equal(right.delayMs, left.delayMs);
});

test("font size changes control speed and newly exposed row actions increase the measured trip", () => {
	assert.equal(sidebarTitleMotion({ ...geometry, fontSize: 28 })?.durationMs, 2500);
	assert.equal(sidebarTitleMotion({ ...geometry, viewportWidth: 72 })?.distancePx, 168);
	assert.equal(sidebarTitleMotion({ ...geometry, viewportWidth: 72 })?.durationMs, 6000);
	for (const fontSize of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
		assert.equal(sidebarTitleMotion({ ...geometry, contentWidth: 126, fontSize })?.durationMs, 1000);
	}
});

test("hidden and invalid geometry never starts an animation", () => {
	for (const viewportWidth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(sidebarTitleMotion({ ...geometry, viewportWidth }), null);
	}
	for (const contentWidth of [Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(sidebarTitleMotion({ ...geometry, contentWidth }), null);
	}
	for (const scaleX of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(sidebarTitleMotion({ ...geometry, scaleX }), null);
	}
});
