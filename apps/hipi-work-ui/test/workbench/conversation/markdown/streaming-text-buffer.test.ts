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
	const seen: StreamingText[] = [];
	const buffer = new StreamingTextBuffer(
		initial,
		(value) => seen.push(value),
		() => false,
		() => false,
	);
	const source = "😀".repeat(120);
	for (let length = 2; length <= source.length; length += 2)
		buffer.update({ ...initial, source: source.slice(0, length) });
	assert.equal(seen.length, 0);
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
		);
		buffer.update({ ...initial, source: "buffered ".repeat(40) });
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
