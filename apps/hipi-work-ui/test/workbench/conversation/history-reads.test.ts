import assert from "node:assert/strict";
import { test } from "node:test";
import { type AppClient, type ConversationSearchHit, parseResult } from "@hipi/work-runtime/contracts";
import {
	prepareSearchNavigation,
	readHistoryPage,
	readMessagePage,
} from "../../../src/features/workbench/conversation/history-reads.ts";

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

test("search activation validates canonical identity and the original matching UTF-16 chunk before navigation", async () => {
	const hit: ConversationSearchHit = {
		...scope,
		title: "Loaded title is irrelevant",
		workspaceName: "Closed project",
		kind: "message",
		messageId: "1_0",
		locator: "do-not-decode",
		snippet: "😀匹配",
		snippetOffset: 9000,
		matchStart: 9002,
		matchEnd: 9004,
	};
	const window = {
		...scope,
		messages: [{ id: "1_0", role: "user", text: "preview", textLength: 10000, truncated: true }],
		target: { ...scope, messageId: "1_0", text: "😀匹配", offset: 9000, nextOffset: 9004, textLength: 10000 },
		matchStart: 9002,
		matchEnd: 9004,
		olderCursor: "opaque-older",
		newerCursor: "opaque-newer",
	};
	const conversation = { ...scope, title: "Current title", revision: 1, archivedAt: null, createdAt: 1 };
	const methods: string[] = [];
	const client: AppClient = {
		async call(method, params, receivedSignal) {
			methods.push(method);
			assert.equal(receivedSignal, signal);
			if (method === "getHistoryAroundMatch") {
				assert.deepEqual(params, { ...scope, locator: "do-not-decode" });
				return parseResult(method, window);
			}
			assert.equal(method, "getConversation", "Activation must not hydrate via snapshot, getHistory or text reads");
			return parseResult(method, conversation);
		},
		async observe() {
			throw new Error("No execution observation during search hydration");
		},
	};
	const result = await prepareSearchNavigation(client, hit, signal);
	assert.deepEqual(methods, ["getConversation", "getHistoryAroundMatch"]);
	assert.equal(result.anchor?.locator, "do-not-decode");
	assert.equal(result.anchor?.window.target.text, "😀匹配");
	assert.equal(result.conversation.title, "Current title");
	for (const change of [
		{ workspaceId: "foreign" },
		{ target: { ...window.target, messageId: "2_0" } },
		{ matchStart: 9001 },
		{ messages: [] },
	]) {
		const invalid: AppClient = {
			...client,
			async call(method) {
				return parseResult(method, method === "getConversation" ? conversation : { ...window, ...change });
			},
		};
		await assert.rejects(prepareSearchNavigation(invalid, hit, signal), { code: "INVALID_REQUEST" });
	}
	const archived: AppClient = {
		...client,
		async call(method) {
			return parseResult(method, method === "getConversation" ? { ...conversation, archivedAt: 2 } : window);
		},
	};
	await assert.rejects(prepareSearchNavigation(archived, hit, signal), { code: "CONVERSATION_ARCHIVED" });
});
