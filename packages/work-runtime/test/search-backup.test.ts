import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { backupStore } from "../src/maintenance/backup.ts";
import { restoreStore } from "../src/maintenance/restore.ts";
import { inspectCatalog } from "../src/maintenance/sqlite.ts";
import { verifyBackup } from "../src/maintenance/verify.ts";
import { openTestRuntime } from "../src/testing.ts";

test("populated schema7 upgrades to8 preserving pins and receipts; backup remains nonexecuting", async () => {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-search-backup-")));
	const source = join(parent, "source"),
		path = join(source, "catalog.sqlite");
	let runtime = await openTestRuntime(source);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Indexed title",
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		const pin = await runtime.call("setConversationPinned", {
			...scope,
			requestId: "pin",
			expectedPresentationRevision: 0,
			pinned: true,
		});
		await runtime.close();
		const before = new DatabaseSync(path);
		let receipts: unknown, presentations: unknown;
		try {
			receipts = before.prepare("SELECT * FROM presentation_commands").all();
			presentations = before.prepare("SELECT * FROM conversation_presentations").all();
			before.exec(
				"DROP TABLE search_chunks; DROP TABLE search_sources; DROP TABLE search_state; UPDATE identity SET version=7",
			);
		} finally {
			before.close();
		}
		runtime = await openTestRuntime(source);
		assert.deepEqual(await runtime.call("getConversationPresentation", scope), pin);
		assert.deepEqual(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), {
			method: "setConversationPinned",
			params: { ...scope, requestId: "pin", expectedPresentationRevision: 0, pinned: true },
			result: pin,
		});
		let status = await runtime.call("refreshConversationSearch", {});
		while (status.nextCursor) status = await runtime.call("refreshConversationSearch", { cursor: status.nextCursor });
		assert.equal((await runtime.call("searchConversations", { query: "Indexed" })).items.length, 1);
		await runtime.close();
		const upgraded = new DatabaseSync(path);
		try {
			assert.deepEqual(upgraded.prepare("SELECT * FROM presentation_commands").all(), receipts);
			assert.deepEqual(upgraded.prepare("SELECT * FROM conversation_presentations").all(), presentations);
		} finally {
			upgraded.close();
		}
		assert.equal(inspectCatalog(path).catalogSchema, 8);
		const bytes = await readFile(path);
		const backup = await backupStore({ source, destination: join(parent, "backup") });
		assert.equal(backup.manifest.catalogSchema, 8);
		assert.deepEqual(await readFile(path), bytes);
		assert.equal((await verifyBackup({ directory: backup.directory })).manifest.catalogSchema, 8);
		const restored = await restoreStore({ source: backup.directory, destination: join(parent, "archive") });
		await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
		const invalid = new DatabaseSync(path);
		try {
			invalid.exec("DROP TABLE search_chunks");
		} finally {
			invalid.close();
		}
		assert.throws(() => inspectCatalog(path));
		await assert.rejects(openTestRuntime(source), { code: "STORE_MISMATCH" });
	} finally {
		await runtime.close();
		await rm(parent, { recursive: true, force: true });
	}
});
