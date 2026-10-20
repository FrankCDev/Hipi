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

for (const previousVersion of [7, 8])
	test(`populated schema${previousVersion} upgrades to12 preserving pins, search and receipts; backup remains nonexecuting`, async () => {
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
			let originalStatus = await runtime.call("refreshConversationSearch", {});
			while (originalStatus.nextCursor)
				originalStatus = await runtime.call("refreshConversationSearch", { cursor: originalStatus.nextCursor });
			await runtime.close();
			const before = new DatabaseSync(path);
			let receipts: unknown, presentations: unknown, chunks: unknown;
			try {
				receipts = before.prepare("SELECT * FROM presentation_commands").all();
				presentations = before.prepare("SELECT * FROM conversation_presentations").all();
				chunks = before.prepare("SELECT * FROM search_chunks").all();
				before.exec(
					"DROP TABLE sidebar_pin_commands; DROP TABLE sidebar_pin_order; DROP TABLE sidebar_pin_state; DROP TABLE project_commands; DROP TABLE project_memberships; DROP TABLE project_presentations; DROP TABLE project_presentation_state; DROP TABLE project_catalog_state; DROP TABLE projects; DROP TABLE navigation_sources; DROP TABLE navigation_publication; DROP TABLE navigation_state",
				);
				if (previousVersion === 7)
					before.exec("DROP TABLE search_chunks; DROP TABLE search_sources; DROP TABLE search_state");
				before.exec("ALTER TABLE presentation_state DROP COLUMN order_generation");
				before.prepare("UPDATE identity SET version=?").run(previousVersion);
			} finally {
				before.close();
			}
			assert.equal(inspectCatalog(path).catalogSchema, previousVersion);
			runtime = await openTestRuntime(source);
			assert.deepEqual(await runtime.call("getConversationPresentation", scope), pin);
			assert.deepEqual(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), {
				method: "setConversationPinned",
				params: { ...scope, requestId: "pin", expectedPresentationRevision: 0, pinned: true },
				result: pin,
			});
			assert.equal((await runtime.call("listPinnedConversations", {})).orderGeneration, 1);
			if (previousVersion === 8) {
				const migrated = new DatabaseSync(path, { readOnly: true });
				try {
					assert.deepEqual(migrated.prepare("SELECT * FROM search_chunks").all(), chunks);
				} finally {
					migrated.close();
				}
			}
			let status = await runtime.call("refreshConversationSearch", {});
			while (status.nextCursor)
				status = await runtime.call("refreshConversationSearch", { cursor: status.nextCursor });
			assert.equal((await runtime.call("searchConversations", { query: "Indexed" })).items.length, 1);
			await runtime.close();
			const upgraded = new DatabaseSync(path);
			try {
				assert.deepEqual(upgraded.prepare("SELECT * FROM presentation_commands").all(), receipts);
				assert.deepEqual(upgraded.prepare("SELECT * FROM conversation_presentations").all(), presentations);
			} finally {
				upgraded.close();
			}
			assert.equal(inspectCatalog(path).catalogSchema, 12);
			const bytes = await readFile(path);
			const backup = await backupStore({ source, destination: join(parent, "backup") });
			assert.equal(backup.manifest.catalogSchema, 12);
			assert.deepEqual(await readFile(path), bytes);
			assert.equal((await verifyBackup({ directory: backup.directory })).manifest.catalogSchema, 12);
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
