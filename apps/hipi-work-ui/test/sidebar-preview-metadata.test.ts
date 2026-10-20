import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationAge, projectConversationCount } from "../src/features/workbench/sidebar-preview-metadata.ts";

test("relative creation age uses the recorded time and supports both locales", () => {
	const now = Date.UTC(2026, 9, 20, 10);
	assert.equal(conversationAge(now - 120_000, now, "en"), "2m ago");
	assert.equal(conversationAge(now - 120_000, now, "zh-CN"), "2分钟前");
	assert.equal(conversationAge(now - 86_400_000 * 40, now, "en"), "1mo ago");
	for (const invalid of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])
		assert.equal(conversationAge(invalid, now, "en"), null);
});

test("only a complete first catalog page may claim an exact chat count", () => {
	assert.equal(projectConversationCount(0, false, "en"), "0 chats");
	assert.equal(projectConversationCount(1, false, "en"), "1 chat");
	assert.equal(projectConversationCount(50, true, "en"), "At least 50 chats");
	assert.equal(projectConversationCount(50, true, "zh-CN"), "至少 50 个聊天");
	assert.equal(projectConversationCount(3, false, "zh-CN"), "3 个聊天");
});
