import assert from "node:assert/strict";
import { test } from "node:test";
import { type AppClient, parseResult } from "@hipi/work-runtime/contracts";
import { readHistoryPage, readMessagePage } from "../src/features/workbench/history-reads.ts";

const scope = { workspaceId: "w", conversationId: "c" };
const signal = new AbortController().signal;
function returning(value: unknown): AppClient {
	return {
		async call(method) {
			return parseResult(method, value);
		},
		async observe() {
			throw new Error("unused");
		},
	};
}

test("history accepts an empty continuation page but rejects a foreign conversation", async () => {
	const page = { ...scope, messages: [], nextCursor: "opaque" };
	assert.deepEqual(await readHistoryPage(returning(page), scope, "older", signal), page);
	await assert.rejects(readHistoryPage(returning({ ...page, conversationId: "foreign" }), scope, "older", signal), {
		code: "INVALID_REQUEST",
	});
});

test("text reads reject wrong identity, changed length, and unrelated offsets", async () => {
	const page = { ...scope, messageId: "m", text: "abc", offset: 5, nextOffset: 8, textLength: 10 };
	for (const change of [
		{ workspaceId: "foreign" },
		{ conversationId: "foreign" },
		{ messageId: "other" },
		{ textLength: 11 },
		{ offset: 2, nextOffset: 5 },
		{ offset: 4, nextOffset: 7 },
	]) {
		await assert.rejects(readMessagePage(returning({ ...page, ...change }), scope, "m", 10, 5, signal), {
			code: "INVALID_REQUEST",
		});
	}
});

test("previous-page requests may overlap one UTF-16 unit to preserve a surrogate pair", async () => {
	const page = { ...scope, messageId: "m", text: "😀abc", offset: 4, nextOffset: 9, textLength: 10 };
	const result = await readMessagePage(returning(page), scope, "m", 10, 5, signal);
	assert.equal(result.offset, 4);
	assert.equal(result.text, "😀abc");
	assert.equal(result.nextOffset, 9);
});
