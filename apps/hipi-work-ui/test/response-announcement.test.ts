import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "@hipi/work-runtime/contracts";
import {
	RESPONSE_ANNOUNCEMENT_MS,
	RESPONSE_ANNOUNCEMENT_UNITS,
	ResponseAnnouncer,
} from "../src/features/workbench/response-announcement.ts";

const labels = { started: "Started", complete: "Complete", interrupted: "Interrupted" };
const initial: Snapshot = {
	workspaceId: "w",
	conversationId: "c",
	running: true,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: null,
	messages: [{ id: "user", role: "user", text: "Question", textLength: 8, truncated: false }],
};

test("response announcements start once, publish bounded deltas every5s and finish only on a new committed assistant", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: string[] = [];
	const owner = new ResponseAnnouncer((text) => seen.push(text), labels);
	owner.update(initial, false);
	assert.deepEqual(seen, ["", "Started"]);
	for (let index = 1; index <= 100; index++) {
		owner.update({ ...initial, partial: "word ".repeat(index) }, false);
	}
	assert.equal(seen.length, 2);
	context.mock.timers.tick(RESPONSE_ANNOUNCEMENT_MS);
	assert.equal(seen.at(-1), "word ".repeat(100));
	owner.update({ ...initial, partial: "😀".repeat(600) }, false);
	context.mock.timers.tick(RESPONSE_ANNOUNCEMENT_MS);
	assert.ok((seen.at(-1)?.length ?? Infinity) <= RESPONSE_ANNOUNCEMENT_UNITS);
	assert.ok(seen.at(-1)?.isWellFormed());
	owner.update(
		{
			...initial,
			running: false,
			messages: [
				...initial.messages,
				{ id: "final", role: "assistant", text: "Final answer", textLength: 12, truncated: false },
			],
		},
		false,
	);
	assert.equal(seen.at(-1), "Complete Final answer");
	const count = seen.length;
	context.mock.timers.tick(RESPONSE_ANNOUNCEMENT_MS * 2);
	assert.equal(seen.length, count);
	owner.dispose();
});

test("paused/error snapshots and prepended history never invent completion; explicit interruption is announced", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: string[] = [];
	const owner = new ResponseAnnouncer((text) => seen.push(text), labels);
	owner.update({ ...initial, partial: "Partial" }, false);
	owner.update({ ...initial, running: false }, true);
	owner.update(
		{
			...initial,
			running: false,
			messages: [
				{ id: "older", role: "assistant", text: "Old answer", textLength: 10, truncated: false },
				...initial.messages,
			],
		},
		false,
	);
	context.mock.timers.tick(RESPONSE_ANNOUNCEMENT_MS * 2);
	assert.deepEqual(seen, ["", "Started"]);
	owner.update(
		{
			...initial,
			running: false,
			messages: [
				...initial.messages,
				{ id: "interrupted", role: "assistant", text: "Partial", textLength: 7, truncated: false, interrupted: true },
			],
		},
		false,
	);
	assert.equal(seen.at(-1), "Interrupted Partial");
	owner.dispose();
});

test("scope switches and disposal cancel old announcements, completed historical snapshots are silent", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: string[] = [];
	const owner = new ResponseAnnouncer((text) => seen.push(text), labels);
	owner.update({ ...initial, partial: "Old pending" }, false);
	owner.update({ ...initial, conversationId: "other", running: false }, false);
	context.mock.timers.tick(RESPONSE_ANNOUNCEMENT_MS * 2);
	assert.deepEqual(seen, ["", "Started", ""]);
	owner.update({ ...initial, conversationId: "other", partial: "New pending" }, false);
	owner.dispose();
	context.mock.timers.tick(RESPONSE_ANNOUNCEMENT_MS * 2);
	assert.deepEqual(seen, ["", "Started", "", "Started"]);
});

test("completion speaks only the final unannounced delta and never repeats the full streamed answer", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const seen: string[] = [];
	const owner = new ResponseAnnouncer((text) => seen.push(text), labels);
	owner.update({ ...initial, partial: "Already heard." }, false);
	context.mock.timers.tick(RESPONSE_ANNOUNCEMENT_MS);
	assert.equal(seen.at(-1), "Already heard.");
	owner.update(
		{
			...initial,
			running: false,
			messages: [
				...initial.messages,
				{ id: "final", role: "assistant", text: "Already heard. Final delta.", textLength: 26, truncated: false },
			],
		},
		false,
	);
	assert.equal(seen.at(-1), "Complete  Final delta.");
	owner.dispose();
});
