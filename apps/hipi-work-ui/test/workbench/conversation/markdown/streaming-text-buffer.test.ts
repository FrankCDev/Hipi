import assert from "node:assert/strict";
import { test } from "node:test";
import {
	STREAM_DISPLAY_INTERVAL_MS,
	type StreamingText,
	StreamingTextBuffer,
} from "../../../../src/features/workbench/conversation/markdown/streaming-text-buffer.ts";

const initial: StreamingText = { source: "", streaming: true, identity: "one" };

test("bursty streaming drains a latest-only well-formed prefix and flushes canonical final immediately", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => false,
		() => now,
	);
	const source = "😀".repeat(120);
	for (let length = 2; length <= source.length; length += 2)
		buffer.update({ ...initial, source: source.slice(0, length) });
	assert.equal(seen.length, 0);
	now += STREAM_DISPLAY_INTERVAL_MS;
	context.mock.timers.tick(STREAM_DISPLAY_INTERVAL_MS);
	assert.ok(seen[0]?.source.length && seen[0].source.length < source.length);
	assert.ok(seen[0].source.isWellFormed());
	assert.ok(source.startsWith(seen[0].source));
	buffer.update({ ...initial, source, streaming: false });
	assert.deepEqual(seen.at(-1), { ...initial, source, streaming: false });
	const count = seen.length;
	context.mock.timers.tick(5000);
	assert.equal(seen.length, count);
	buffer.dispose();
});

test("identity, non-prefix correction and completed-to-streaming restart never reuse old prefixes", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		{ ...initial, source: "old" },
		(value) => seen.push(value),
		() => false,
		() => false,
	);
	buffer.update({ ...initial, source: "old addition" });
	buffer.update({ ...initial, source: "replacement" });
	assert.equal(seen.at(-1)?.source, "replacement");
	buffer.update({ ...initial, identity: "two", source: "new identity" });
	assert.equal(seen.at(-1)?.identity, "two");
	buffer.update({ ...initial, identity: "two", source: "final", streaming: false });
	buffer.update({ ...initial, identity: "two", source: "final restart" });
	assert.equal(seen.at(-1)?.source, "final restart");
	buffer.dispose();
	context.mock.timers.tick(5000);
	assert.equal(seen.length, 4);
});

test("selection freezes scheduled and final updates, then release publishes only latest", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let blocked = false;
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => blocked,
		() => false,
	);
	buffer.update({ ...initial, source: "partial ".repeat(40) });
	blocked = true;
	context.mock.timers.tick(STREAM_DISPLAY_INTERVAL_MS);
	buffer.update({ ...initial, source: "interrupted canonical", streaming: false });
	buffer.flush();
	assert.deepEqual(seen, []);
	blocked = false;
	buffer.flush();
	assert.deepEqual(seen, [{ ...initial, source: "interrupted canonical", streaming: false }]);
	buffer.dispose();
});

test("reduced motion bypasses animation and disposal silences queued work", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => true,
	);
	buffer.update({ ...initial, source: "entire arrival" });
	assert.equal(seen[0]?.source, "entire arrival");
	buffer.dispose();
	buffer.update({ ...initial, source: "ignored" });
	buffer.flush();
	context.mock.timers.tick(5000);
	assert.equal(seen.length, 1);
});

test("a terminal source cancels a queued animation frame before publishing the exact final", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	let callback: FrameRequestCallback | undefined;
	const originalFrame = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	let canceled: number | undefined;
	globalThis.requestAnimationFrame = (next) => {
		callback = next;
		return 7;
	};
	globalThis.cancelAnimationFrame = (frame) => {
		canceled = frame;
		callback = undefined;
	};
	try {
		const seen: StreamingText[] = [];
		const buffer = new StreamingTextBuffer(
			initial,
			(value) => seen.push(value),
			() => false,
			() => false,
			() => now,
		);
		buffer.update({ ...initial, source: "buffered ".repeat(40) });
		now += STREAM_DISPLAY_INTERVAL_MS;
		context.mock.timers.tick(STREAM_DISPLAY_INTERVAL_MS);
		assert.ok(callback);
		assert.equal(seen.length, 0);
		buffer.update({ ...initial, source: "exact final", streaming: false });
		assert.equal(canceled, 7);
		assert.equal(callback, undefined);
		assert.equal(seen.at(-1)?.source, "exact final");
		buffer.dispose();
	} finally {
		globalThis.requestAnimationFrame = originalFrame;
		globalThis.cancelAnimationFrame = originalCancel;
	}
});

test("adaptive drain uses arrival rate and fractional carry rather than a minimum chunk", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => false,
		() => now,
	);
	buffer.update({ ...initial, source: "x".repeat(100) });
	assert.equal(seen.length, 0);
	now = 50;
	context.mock.timers.tick(50);
	// First arrival rate=100; one backlog adjustment gives 125 units/s, then 6.25 units.
	assert.equal(seen.at(-1)?.source.length, 6);
	now = 100;
	context.mock.timers.tick(50);
	assert.equal(seen.at(-1)?.source.length, 15);
	buffer.dispose();
});

test("sub-frame arrivals use the source-default ten-second arrival floor", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => false,
		() => now,
	);
	buffer.update({ ...initial, source: "x".repeat(100) });
	now = 25;
	buffer.update({ ...initial, source: "x".repeat(200) });
	// Arrival EMA is 91, not the enabled-experiment estimate of 490.
	// With 0.025 seconds elapsed the backlog adjustment yields 137.9166… units/s.
	assert.equal(seen.at(-1)?.source.length, 3);
	buffer.dispose();
});

test("small arrivals retain fractional progress and idle gaps restart without a jump", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => false,
		() => now,
	);
	buffer.update({ ...initial, source: "a" });
	now = 50;
	context.mock.timers.tick(50);
	assert.equal(seen.length, 0);
	for (let step = 0; step < 20; step++) {
		now += 50;
		context.mock.timers.tick(50);
	}
	assert.equal(seen.at(-1)?.source, "a");
	now += 60_000;
	buffer.update({ ...initial, source: "ab" });
	assert.equal(seen.at(-1)?.source, "a");
	buffer.update({ ...initial, source: "ab", streaming: false });
	assert.equal(seen.at(-1)?.source, "ab");
	buffer.dispose();
});

test("an adaptive boundary never publishes half of a surrogate pair", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => false,
		() => now,
	);
	buffer.update({ ...initial, source: `12345😀${"x".repeat(93)}` });
	now = 50;
	context.mock.timers.tick(50);
	assert.equal(seen.at(-1)?.source, "12345😀");
	assert.ok(seen.at(-1)?.source.isWellFormed());
	buffer.dispose();
});

test("animation frames coalesce drains and recheck selection before publishing", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	let blocked = false;
	let callback: FrameRequestCallback | undefined;
	let frames = 0;
	const originalFrame = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	globalThis.requestAnimationFrame = (next) => {
		callback = next;
		return ++frames;
	};
	globalThis.cancelAnimationFrame = () => {
		callback = undefined;
	};
	const runFrame = () => {
		const next = callback;
		callback = undefined;
		assert.ok(next);
		next(now);
	};
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => blocked,
		() => false,
		() => now,
	);
	try {
		buffer.update({ ...initial, source: "x".repeat(100) });
		now = 50;
		context.mock.timers.tick(50);
		now = 100;
		context.mock.timers.tick(50);
		assert.equal(frames, 1);
		assert.equal(seen.length, 0);
		runFrame();
		assert.equal(seen.at(-1)?.source.length, 15);
		now = 150;
		context.mock.timers.tick(50);
		blocked = true;
		runFrame();
		assert.equal(seen.at(-1)?.source.length, 15);
		buffer.update({ ...initial, source: "latest", streaming: false });
		assert.equal(seen.at(-1)?.source.length, 15);
		blocked = false;
		buffer.flush();
		assert.equal(seen.at(-1)?.source, "latest");
	} finally {
		buffer.dispose();
		globalThis.requestAnimationFrame = originalFrame;
		globalThis.cancelAnimationFrame = originalCancel;
	}
});

test("a suspended-page clock jump drains safely without an elapsed-time-sized loop", { timeout: 1000 }, (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => false,
		() => now,
	);
	const source = "x".repeat(30_000);
	buffer.update({ ...initial, source });
	now = 365 * 24 * 60 * 60 * 1000;
	context.mock.timers.tick(50);
	assert.equal(seen.at(-1)?.source, source);
	buffer.dispose();
});
