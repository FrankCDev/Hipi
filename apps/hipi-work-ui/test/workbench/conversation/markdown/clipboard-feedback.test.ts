import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ClipboardFeedback,
	type ClipboardStatus,
	COPY_FEEDBACK_MS,
	COPY_TIMEOUT_MS,
} from "../../../../src/features/workbench/conversation/markdown/clipboard-feedback.ts";

test("copy success is confirmed only after resolution, then resets after 1500ms", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: ClipboardStatus[] = [];
	const texts: string[] = [];
	let finish: (() => void) | undefined;
	const owner = new ClipboardFeedback(
		(status) => seen.push(status),
		(text) => {
			texts.push(text);
			return new Promise<void>((resolve) => {
				finish = resolve;
			});
		},
	);
	owner.copy("exact\nsource\n");
	owner.copy("duplicate");
	assert.deepEqual(texts, ["exact\nsource\n"]);
	assert.deepEqual(seen, ["copying"]);
	assert.ok(finish);
	finish();
	await Promise.resolve();
	assert.equal(seen.at(-1), "copied");
	context.mock.timers.tick(COPY_FEEDBACK_MS - 1);
	assert.equal(seen.at(-1), "copied");
	context.mock.timers.tick(1);
	assert.equal(seen.at(-1), "idle");
	owner.dispose();
});

test("failed retries cannot retain copied state; timed-out or disposed replies cannot claim success", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: ClipboardStatus[] = [];
	let fail = false;
	const owner = new ClipboardFeedback(
		(status) => seen.push(status),
		async () => {
			if (fail) throw new Error("Denied");
		},
	);
	owner.copy("value");
	await Promise.resolve();
	assert.equal(seen.at(-1), "copied");
	fail = true;
	owner.copy("value");
	assert.equal(seen.at(-1), "copying");
	await Promise.resolve();
	assert.equal(seen.at(-1), "failed");
	owner.dispose();
	let finish: (() => void) | undefined;
	const slow = new ClipboardFeedback(
		(status) => seen.push(status),
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	slow.copy("value");
	context.mock.timers.tick(COPY_TIMEOUT_MS);
	assert.equal(seen.at(-1), "failed");
	slow.dispose();
	assert.ok(finish);
	finish();
	await Promise.resolve();
	assert.equal(seen.at(-1), "failed");
});
