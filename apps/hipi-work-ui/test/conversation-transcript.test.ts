import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "@hipi/work-runtime/contracts";
import { projectTranscript, transcriptEstimate } from "../src/features/workbench/conversation-transcript.ts";

const snapshot: Snapshot = {
	workspaceId: "w",
	conversationId: "c",
	running: false,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: null,
	messages: [
		{ id: "10_0", role: "user", text: "Hello", textLength: 5, truncated: false },
		{ id: "11_0", role: "assistant", text: "Response", textLength: 8, truncated: false },
	],
};
test("semantic transcript retains unchanged identities through prepend and stream updates", () => {
	const initial = projectTranscript(snapshot);
	const streaming = projectTranscript({ ...snapshot, running: true, partial: "Partial" }, initial);
	assert.equal(streaming[0], initial[0]);
	assert.equal(streaming[1], initial[1]);
	assert.equal(streaming[2]?.kind, "assistant-stream");
	assert.equal(transcriptEstimate(initial[0]), 128);
	assert.equal(transcriptEstimate(initial[1]), 144);
	const first = snapshot.messages[0];
	assert.ok(first);
	const prepended = projectTranscript(
		{ ...snapshot, messages: [{ ...first, id: "older" }, ...snapshot.messages] },
		streaming,
	);
	assert.equal(prepended[1], initial[0]);
	assert.equal(prepended[2], initial[1]);
	assert.equal(
		prepended.some((row) => row.key === "partial-output"),
		false,
	);
});

test("only explicit scoped identity preserves the streaming row key into the committed assistant", () => {
	const partialId = "1de12561-9171-4806-923d-bd965b721a3b";
	const streaming = projectTranscript({ ...snapshot, running: true, partial: "Response", partialId });
	const stream = streaming.at(-1);
	assert.ok(stream);
	const completed = projectTranscript(
		{
			...snapshot,
			messages: [
				...snapshot.messages,
				{
					id: "12_0",
					role: "assistant",
					text: "Canonical final",
					textLength: 15,
					truncated: false,
					streamId: partialId,
				},
			],
		},
		streaming,
	);
	assert.equal(completed.at(-1)?.key, stream.key);
	assert.equal(completed.at(-1)?.kind, "assistant-message");
	assert.equal(completed.at(-1)?.message?.text, "Canonical final");
	assert.equal(new Set(completed.map((row) => row.key)).size, completed.length);
	const fallback = projectTranscript({ ...snapshot, running: false }, streaming);
	assert.ok(fallback.every((row) => row.key !== stream.key));
	const foreign = projectTranscript(
		{ ...snapshot, workspaceId: "other", running: true, partial: "Response", partialId },
		streaming,
	);
	assert.notEqual(foreign.at(-1)?.key, stream.key);
	const reconnected = projectTranscript(
		{ ...snapshot, running: true, partial: "Response", partialId: "10230315-a871-4a08-b7e2-f658a9e8a073" },
		streaming,
	);
	assert.notEqual(reconnected.at(-1)?.key, stream.key);
});
