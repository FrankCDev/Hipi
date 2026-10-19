import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { type Conversation, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { LIMITS } from "../src/contracts.ts";
import { readHistory, readMessageText } from "../src/history.ts";
import { deterministicModels } from "../src/testing.ts";

async function write(conversation: Conversation, model: PiMessage[]) {
	const result = await (
		await conversation.submit({ type: "write", entry: { kind: "history.fork-fixture", model } }, context)
	).wait(context);
	assert.equal(result.status, "done");
	assert.ok("entry" in result);
	return result.entry;
}

test("public fork-aware history and text exclude parent entries after the fork boundary", async () => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: deterministicModels(), registry: createRegistry() },
		context,
	);
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const inherited = await write(parent, [{ role: "user", content: "inherited", timestamp: 0 }]);
		const fork = await parent.fork(inherited, { ownership: { kind: "ownerless" } }, context);
		const excluded = await write(parent, [{ role: "user", content: "parent only", timestamp: 1 }]);
		await write(fork, [{ role: "user", content: "fork only", timestamp: 2 }]);
		await fork.reset(undefined, context);
		const scope = { workspaceId: "work", conversationId: "fork" };
		const page = await readHistory(fork, scope);
		assert.deepEqual(
			page.messages.map((message) => message.text),
			["inherited", "fork only"],
		);
		assert.equal((await readMessageText(fork, scope, `${inherited}_0`, 0)).text, "inherited");
		await assert.rejects(readMessageText(fork, scope, `${excluded}_0`, 0), { code: "NOT_FOUND" });
	} finally {
		await harness.close(context);
	}
});

test("non-displayable model slots yield an empty continuation without dropping earlier messages", async () => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: deterministicModels(), registry: createRegistry() },
		context,
	);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const model: PiMessage[] = [{ role: "user", content: "before hidden slots", timestamp: 0 }];
		for (let index = 0; index < LIMITS.historyScanSlots + 1; index++) {
			model.push({
				role: "toolResult",
				toolCallId: `call_${index}`,
				toolName: "hidden",
				content: [],
				isError: false,
				timestamp: index,
			});
		}
		await write(conversation, model);
		const scope = { workspaceId: "work", conversationId: "slots" };
		const first = await readHistory(conversation, scope);
		assert.deepEqual(first.messages, []);
		assert.ok(first.nextCursor);
		const second = await readHistory(conversation, scope, first.nextCursor);
		assert.deepEqual(
			second.messages.map((message) => message.text),
			["before hidden slots"],
		);
		assert.equal(second.nextCursor, null);
	} finally {
		await harness.close(context);
	}
});
