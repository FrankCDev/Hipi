import assert from "node:assert/strict";
import test from "node:test";
import { parseResult } from "../src/contracts.ts";

test("pinned catalog requires an explicit bounded previous cursor", () => {
	const page = { items: [], nextCursor: null, previousCursor: null, orderGeneration: 0, nextPinnedScope: null };
	assert.deepEqual(parseResult("listPinnedConversations", page), page);
	for (const previousCursor of [undefined, "", 1, "x".repeat(2049)])
		assert.throws(() => parseResult("listPinnedConversations", { ...page, previousCursor }), {
			code: "INVALID_REQUEST",
		});
	assert.equal(
		parseResult("listPinnedConversations", { ...page, previousCursor: "bounded-cursor" }).previousCursor,
		"bounded-cursor",
	);
});
