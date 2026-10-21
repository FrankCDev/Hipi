import assert from "node:assert/strict";
import test from "node:test";
import { assertCanonicalReads, assertHistoryYield } from "./message-browser-assertions.mjs";

test("canonical browser evidence rejects prefix-only, replacement chunks, gaps and old-scope callbacks", () => {
	const expected = "first middle last";
	const calls = Array.from({ length: 3 }, (_, index) => ({
		method: "getMessageText",
		offset: index * 6,
		settled: true,
		aborted: false,
		conversationId: "fixture-a",
	}));
	assertCanonicalReads([{ method: "getHistory" }, ...calls], expected, expected, 6);
	for (const text of ["first ", "middle", "last", "first WRONG last"])
		assert.throws(() => assertCanonicalReads(calls, text, expected, 6));
	for (const change of [{ offset: 7 }, { settled: false }, { aborted: true }, { conversationId: "fixture-b" }]) {
		assert.throws(() => assertCanonicalReads([calls[0], { ...calls[1], ...change }, calls[2]], expected, expected, 6));
	}
	assert.throws(() => assertCanonicalReads(calls.slice(0, 2), expected, expected, 6));
});

test("history yield evidence requires sixteen completed cursor reads plus exactly one pending continuation", () => {
	const calls = Array.from({ length: 17 }, (_, index) => ({
		method: "getHistory",
		cursor: `scan-${index}`,
		settled: index < 16,
		aborted: false,
	}));
	assertHistoryYield(calls, 1);
	assertHistoryYield([{ method: "getMessageText" }, ...calls], 1);
	assert.throws(() => assertHistoryYield(calls, 2));
	assert.throws(() => assertHistoryYield(calls.slice(0, 16), 1));
	for (const change of [{ cursor: "scan-0" }, { settled: true }, { aborted: true }]) {
		assert.throws(() => assertHistoryYield([...calls.slice(0, 16), { ...calls[16], ...change }], 1));
	}
});
