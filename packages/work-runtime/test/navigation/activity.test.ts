import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiWorkspace } from "../../src/pi-workspace.ts";

async function document(storage: Storage, kind: string, key: string) {
	const record = await storage.findDocument({ kind, key, scope: { kind: "session" } }, "current", context);
	return record ? (await storage.document(record.id, "current", context))?.value : undefined;
}

test("first acceptance and bounded activity commit together; crash replay preserves original time and public receipt", async (t) => {
	const path = await mkdtemp(join(tmpdir(), "hipi-navigation-activity-"));
	const file = join(path, "workspace.sqlite");
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	let changed = 0;
	const options = {
		workspaceId: "work",
		name: "Work",
		models,
		model: { provider: "faux", modelId: "faux-1" },
		onNavigationChanged: () => {
			changed++;
		},
	};
	let storage = await openNodeSqliteStorage(file);
	let workspace = await PiWorkspace.open(storage, {
		...options,
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("accepted before delivery");
		},
	});
	try {
		const conversation = await workspace.createConversation({
			workspaceId: "work",
			requestId: "create",
			title: "Activity",
		});
		const input = { ...conversation, requestId: "send", text: "Original submission" };
		const before = changed;
		t.mock.method(Date, "now", () => 123456);
		await assert.rejects(workspace.submit(input), /accepted before delivery/);
		assert.ok(changed > before, "first durable acceptance invalidates navigation");
		const key = createHash("sha256")
			.update(JSON.stringify(["local-owner", "work", "submit", "send"]))
			.digest("hex");
		const saved = await document(storage, "hipi.receipt", key);
		assert.ok(saved?.receipt && typeof saved.receipt === "object" && !Array.isArray(saved.receipt));
		assert.equal(saved.receipt.acceptedAt, 123456);
		assert.deepEqual(await document(storage, "hipi.conversation-activity", conversation.conversationId), {
			latestAcceptedAt: 123456,
		});
		t.mock.restoreAll();
		await workspace.close();
		storage = await openNodeSqliteStorage(file);
		workspace = await PiWorkspace.open(storage, options);
		t.mock.method(Date, "now", () => {
			throw new Error("Replay must not sample a fresh time");
		});
		const replay = await workspace.submit(input);
		assert.equal("acceptedAt" in replay, false);
		assert.equal(replay.receiptId, saved.receipt.receiptId);
		assert.equal(replay.state, "accepted");
		t.mock.restoreAll();
		assert.deepEqual(await document(storage, "hipi.conversation-activity", conversation.conversationId), {
			latestAcceptedAt: 123456,
		});
		assert.equal(faux.state.callCount, 0);
		await workspace.cancelExecution(conversation);
		assert.deepEqual(await document(storage, "hipi.conversation-activity", conversation.conversationId), {
			latestAcceptedAt: 123456,
		});
	} finally {
		t.mock.restoreAll();
		await workspace.close();
		await rm(path, { recursive: true, force: true });
	}
});

test("rejected archived admission writes no acceptance activity", async () => {
	const path = await mkdtemp(join(tmpdir(), "hipi-navigation-rejected-"));
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const storage = await openNodeSqliteStorage(join(path, "workspace.sqlite"));
	const workspace = await PiWorkspace.open(storage, {
		workspaceId: "work",
		name: "Work",
		models,
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		const conversation = await workspace.createConversation({
			workspaceId: "work",
			requestId: "create",
			title: "Archived",
		});
		await workspace.archiveConversation({ ...conversation, requestId: "archive", expectedRevision: 1 });
		await assert.rejects(workspace.submit({ ...conversation, requestId: "reject", text: "No admission" }), {
			code: "CONVERSATION_ARCHIVED",
		});
		assert.equal(await document(storage, "hipi.conversation-activity", conversation.conversationId), undefined);
		const key = createHash("sha256")
			.update(JSON.stringify(["local-owner", "work", "submit", "reject"]))
			.digest("hex");
		assert.equal(await document(storage, "hipi.receipt", key), undefined);
	} finally {
		await workspace.close();
		await rm(path, { recursive: true, force: true });
	}
});
