import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Conversation, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { historyAroundMatch, indexSource, type SearchSource } from "../src/search/storage.ts";
import { deterministicModels } from "../src/testing.ts";

async function write(conversation: Conversation, content: string) {
	const result = await (
		await conversation.submit(
			{ type: "write", entry: { kind: "search.fork-fixture", model: [{ role: "user", content, timestamp: 0 }] } },
			context,
		)
	).wait(context);
	assert.equal(result.status, "done");
	assert.ok("entry" in result);
	return result.entry;
}
test("public Storage search includes fork ancestors, excludes later parent entries, and survives reset", async () => {
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models: deterministicModels(), registry: createRegistry() }, context);
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const inherited = await write(parent, "inherited");
		const fork = await parent.fork(inherited, { ownership: { kind: "ownerless" } }, context);
		await write(parent, "parent secret");
		const own = await write(fork, "child text");
		await fork.reset(undefined, context);
		const source: SearchSource = {
			workspaceId: "work",
			conversationId: "fork",
			generation: "generation",
			durableId: fork.id,
			title: "Fork",
			workspaceName: "Work",
			revision: 1,
			archived: false,
		};
		const upper =
			(await storage.scanEntries({ conversationId: fork.id, order: "descending" }, 1, undefined, context)).items[0]
				?.id ?? 0;
		const batch = await indexSource(storage, source, {
			indexedEntry: 0,
			pendingEntry: 0,
			pendingSlot: 0,
			pendingOffset: 0,
			upperEntry: upper,
		});
		assert.equal(batch.complete, true);
		assert.deepEqual(
			batch.chunks.map((chunk) => chunk.text),
			["inherited", "child text"],
		);
		const window = await historyAroundMatch(
			storage,
			source,
			{
				...source,
				storeId: "store",
				messageId: `${inherited}_0`,
				start: 0,
				end: 9,
				match: createHash("sha256").update("inherited").digest("hex"),
				textLength: 9,
			},
			"test-locator",
		);
		assert.deepEqual(
			window.messages.map((message) => message.id),
			[`${inherited}_0`, `${own}_0`],
		);
		assert.equal(window.target.text, "inherited");
	} finally {
		await harness.close(context);
	}
});
