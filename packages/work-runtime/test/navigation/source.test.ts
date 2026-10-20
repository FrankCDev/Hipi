import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type EntryId,
	MemoryStorage,
	type StorageWrite,
	type TaskId,
} from "@earendil-works/pi-durable";
import { readActivityStep } from "../../src/navigation/source.ts";

test("resumable full task scan revisits an older task ID gaining terminal time and ignores unrelated tasks", async () => {
	const storage = new MemoryStorage();
	const id = await storage.mintId<ConversationId>();
	await storage.commit([{ type: "conversation", value: { id } }], context);
	const records: Extract<StorageWrite, { type: "task" }>["value"][] = [];
	for (let i = 0; i < 70; i++) {
		const taskId = await storage.mintId<TaskId<JsonValue>>();
		const value = {
			id: taskId,
			conversationId: id,
			kind: "pi.generation",
			version: 1,
			input: {},
			background: false,
			abortRequested: false,
			startedAt: 10,
			state: { status: "running" as const, checkpoint: {} },
		};
		records.push(value);
		await storage.commit([{ type: "task", value }], context);
	}
	const source = { generation: "g", durableId: id, revision: 1, title: "C", archived: false },
		conversation = { workspaceId: "w", conversationId: "c", title: "C", revision: 1, createdAt: 1, archivedAt: null };
	try {
		let batch = await readActivityStep(storage, source, conversation);
		assert.equal(batch.complete, false);
		assert.ok(batch.position.cursor);
		batch = await readActivityStep(storage, source, conversation, batch.position);
		assert.equal(batch.complete, false);
		batch = await readActivityStep(storage, source, conversation, batch.position);
		assert.equal(batch.complete, true);
		assert.equal(batch.position.recencyAt, 10);
		const old = records[0];
		await storage.commit(
			[
				{
					type: "task",
					value: {
						...old,
						memos: undefined,
						endedAt: 100,
						state: { status: "terminal", outcome: { status: "completed", result: {} } },
					},
				},
			],
			context,
		);
		let renewed = await readActivityStep(storage, source, conversation);
		while (!renewed.complete) renewed = await readActivityStep(storage, source, conversation, renewed.position);
		assert.equal(renewed.position.recencyAt, 100);
		assert.equal(renewed.position.basis, "generation_terminal");
		await assert.rejects(
			readActivityStep(storage, { ...source, generation: "replacement" }, conversation, batch.position),
			{ code: "CURSOR_STALE" },
		);
	} finally {
		await storage.close(context);
	}
});
test("unversioned directory snapshot publishes unknown activity without reading activity storage", async (t) => {
	const storage = new MemoryStorage();
	for (const method of ["findDocument", "scanTasks", "scanEntries"] as const)
		t.mock.method(storage, method, () => {
			throw new Error("No activity reads for unversioned sources");
		});
	const source = {
		generation: "legacy_w",
		unversioned: "metadata-fingerprint",
		durableId: 1,
		revision: 1,
		title: "C",
		archived: false,
	};
	const conversation = {
		workspaceId: "w",
		conversationId: "c",
		title: "C",
		revision: 1,
		createdAt: null,
		archivedAt: null,
	};
	const batch = await readActivityStep(storage, source, conversation);
	assert.equal(batch.complete, true);
	assert.equal(batch.unversioned, true);
	assert.equal(batch.position.recencyAt, null);
	assert.equal(batch.position.basis, "unknown");
	assert.equal(JSON.parse(batch.position.source)[0], "metadata-fingerprint");
	await storage.close(context);
});
test("legacy messages and creation are explicit original-time fallbacks; tool results do not manufacture completion", async () => {
	const storage = new MemoryStorage();
	const id = await storage.mintId<ConversationId>();
	await storage.commit([{ type: "conversation", value: { id } }], context);
	const conversation = {
		workspaceId: "w",
		conversationId: "c",
		title: "C",
		revision: 1,
		createdAt: 7,
		archivedAt: null,
	};
	const source = { generation: "g", durableId: id, revision: 1, title: "C", archived: false };
	try {
		assert.equal((await readActivityStep(storage, source, conversation)).position.basis, "creation");
		const entryId = await storage.mintId<EntryId>();
		await storage.commit(
			[
				{
					type: "entry",
					value: {
						id: entryId,
						conversationId: id,
						kind: "pi.user",
						model: Array.from({ length: 300 }, (_, i) => ({
							role: "user" as const,
							content: "persisted",
							timestamp: 100 + i,
						})),
					},
				},
			],
			context,
		);
		let batch = await readActivityStep(storage, source, conversation);
		assert.equal(batch.complete, false);
		assert.equal(batch.position.slot, 256);
		batch = await readActivityStep(storage, source, conversation, batch.position);
		assert.equal(batch.complete, true);
		assert.equal(batch.position.recencyAt, 399);
		assert.equal(batch.position.basis, "message");
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(readActivityStep(storage, source, conversation, undefined, aborted.signal), {
			code: "CLOSED",
		});
	} finally {
		await storage.close(context);
	}
});
