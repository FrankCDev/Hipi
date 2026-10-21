import assert from "node:assert/strict";
import test from "node:test";
import { assertSearchHit, exerciseConversationSearch, searchBlockVisible } from "./gui-conversation-search.mjs";

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

test("search anchor requires the completed canonical source block, exact message and visible block start", () => {
	const block = {
		dataset: { markdownSourceStart: "0", markdownSourceEnd: "40" },
		textContent: "prefix 中文流式验证 suffix",
		getBoundingClientRect: () => ({ top: 20, bottom: 2000, left: 20, right: 80, width: 60, height: 1980 }),
	};
	let complete = true;
	const blocks = [block];
	const rows = [
		{ dataset: { messageId: "one" }, querySelector: () => (complete ? { querySelectorAll: () => blocks } : null) },
	];
	const document = {
		querySelectorAll: () => rows,
		querySelector: () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 100 }) }),
	};
	assert.equal(
		searchBlockVisible(document, "one", "中文流式验证"),
		true,
		"A large semantic block may extend below the viewport",
	);
	assert.equal(searchBlockVisible(document, "other", "中文流式验证"), false);
	assert.equal(searchBlockVisible(document, "one", "absent"), false);
	complete = false;
	assert.equal(searchBlockVisible(document, "one", "中文流式验证"), false);
	complete = true;
	for (const start of ["-1", "NaN", "40"]) {
		block.dataset.markdownSourceStart = start;
		assert.equal(searchBlockVisible(document, "one", "中文流式验证"), false);
	}
	block.dataset.markdownSourceStart = "0";
	blocks.push(block);
	assert.equal(searchBlockVisible(document, "one", "中文流式验证"), false);
	blocks.pop();
	block.getBoundingClientRect = () => ({ top: -200, bottom: -100, left: 20, right: 80, width: 60, height: 100 });
	assert.equal(searchBlockVisible(document, "one", "中文流式验证"), false);
});
