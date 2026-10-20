import assert from "node:assert/strict";
import test from "node:test";
import { assertSearchHit, exerciseConversationSearch } from "./gui-conversation-search.mjs";

test("native content-search evidence requires exact scope, message identity, selected result and actual highlight", () => {
	const scope = { workspaceId: "work", conversationId: "chat" };
	const phrase = "中文流式验证";
	const hit = { ...scope, messageId: "11_0", kind: "message", selected: true, highlight: phrase };
	assertSearchHit([hit], scope, "11_0", phrase);
	for (const delta of [
		{ workspaceId: "other" },
		{ conversationId: "other" },
		{ messageId: "12_0" },
		{ kind: "title" },
		{ selected: false },
		{ highlight: "wrong" },
	])
		assert.throws(() => assertSearchHit([{ ...hit, ...delta }], scope, "11_0", phrase));
	assert.throws(() => assertSearchHit([], scope, "11_0", phrase));
	assert.throws(() => assertSearchHit([hit, hit], scope, "11_0", phrase));
});

test("native search refuses invalid canonical scope before any input or observation", async () => {
	let calls = 0;
	const cdp = {
		request: async () => {
			calls++;
			throw new Error("Unexpected native call");
		},
	};
	await assert.rejects(exerciseConversationSearch(cdp, "unused", { workspaceId: 'bad"scope', conversationId: "chat" }));
	assert.equal(calls, 0);
});
