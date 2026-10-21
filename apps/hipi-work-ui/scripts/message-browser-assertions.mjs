import assert from "node:assert/strict";

/** Transport evidence is separate from history calls, and cannot substitute for the rendered full text. */
export function assertCanonicalReads(calls, rendered, expected, chunkSize) {
	const reads = calls.filter((call) => call.method === "getMessageText");
	assert.equal(rendered, expected, "Canonical body must retain the exact prefix, middle and suffix");
	assert.equal(reads.length, Math.ceil(expected.length / chunkSize));
	for (const [index, read] of reads.entries()) {
		assert.equal(read.offset, index * chunkSize);
		assert.equal(read.settled, true);
		assert.equal(read.aborted, false);
		assert.equal(read.conversationId, "fixture-a");
	}
}

export function assertHistoryYield(calls, maxActive) {
	const reads = calls.filter((call) => call.method === "getHistory");
	assert.equal(reads.length, 17, "Visible demand must continue past the internal sixteen-read yield");
	assert.equal(maxActive, 1, "One history request at a time");
	for (const [index, read] of reads.entries()) {
		assert.equal(read.cursor, `scan-${index}`);
		assert.equal(read.aborted, false);
		assert.equal(read.settled, index < 16);
	}
}
