import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { backupStore } from "../src/maintenance/backup.ts";
import { hashFile } from "../src/maintenance/paths.ts";
import { restoreStore } from "../src/maintenance/restore.ts";
import { inspectCatalog } from "../src/maintenance/sqlite.ts";
import { verifyBackup } from "../src/maintenance/verify.ts";
import { openTestRuntime } from "../src/testing.ts";

async function fixture() {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-presentation-backup-")));
	const source = join(parent, "source");
	const runtime = await openTestRuntime(source);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Pinned",
		});
		const scope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
		await runtime.call("setConversationPinned", {
			...scope,
			requestId: "pin",
			expectedPresentationRevision: 0,
			pinned: true,
		});
		await runtime.call("archiveConversation", { ...scope, requestId: "archive", expectedRevision: 1 });
		await runtime.call("restoreConversation", { ...scope, requestId: "restore", expectedRevision: 2 });
		await runtime.call("setConversationPinned", {
			...scope,
			requestId: "repin",
			expectedPresentationRevision: 2,
			pinned: true,
		});
		return {
			parent,
			source,
			scope,
			catalogPath: join(source, "catalog.sqlite"),
			destination: join(parent, "backup"),
		};
	} finally {
		await runtime.close();
		// Keep schema7 compatibility evidence independent from newer derived search tables.
		const database = new DatabaseSync(join(source, "catalog.sqlite"));
		try {
			database.exec(
				"DROP TABLE search_chunks; DROP TABLE search_sources; DROP TABLE search_state; UPDATE identity SET version=7",
			);
		} finally {
			database.close();
		}
	}
}

test("schema7 backup preserves pin order, archive fences and immutable receipts without changing source bytes", async () => {
	const f = await fixture();
	try {
		const before = await readFile(f.catalogPath);
		const result = await backupStore(f);
		assert.equal(result.manifest.catalogSchema, 7);
		assert.deepEqual(await readFile(f.catalogPath), before);
		assert.equal((await verifyBackup({ directory: result.directory })).manifest.catalogSchema, 7);
		const db = new DatabaseSync(join(result.directory, "catalog.sqlite"), { readOnly: true });
		try {
			const row = db.prepare("SELECT * FROM conversation_presentations").get();
			assert.equal(row?.revision, 3);
			assert.equal(row?.pin_ordinal, 2);
			assert.equal(row?.pin_conversation_revision, 3);
			assert.equal(row?.archived_revision, 2);
			assert.equal(db.prepare("SELECT count(*) AS total FROM presentation_commands").get()?.total, 2);
		} finally {
			db.close();
		}
		const restored = await restoreStore({ source: result.directory, destination: join(f.parent, "archive") });
		const recovered = new DatabaseSync(join(restored.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(recovered.prepare("SELECT version FROM identity").get()?.version, 4);
			for (const name of ["conversation_presentations", "presentation_state", "presentation_commands"])
				assert.equal(recovered.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name), undefined);
		} finally {
			recovered.close();
		}
		await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("schema6 migrates atomically to empty presentation state without changing store or conversation identity", async () => {
	const f = await fixture();
	try {
		const db = new DatabaseSync(f.catalogPath);
		let storeId: unknown;
		try {
			storeId = db.prepare("SELECT store_id FROM identity").get()?.store_id;
			db.exec(
				"DROP TABLE conversation_presentations; DROP TABLE presentation_state; DROP TABLE presentation_commands; UPDATE identity SET version=6",
			);
		} finally {
			db.close();
		}
		assert.equal(inspectCatalog(f.catalogPath).catalogSchema, 6);
		const runtime = await openTestRuntime(f.source);
		try {
			assert.equal((await runtime.call("handshake", {})).storeId, storeId);
			assert.deepEqual(await runtime.call("getConversationPresentation", f.scope), {
				...f.scope,
				revision: 0,
				pinned: false,
			});
			assert.equal((await runtime.call("getConversation", f.scope)).revision, 3);
			assert.equal(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), null);
		} finally {
			await runtime.close();
		}
		assert.equal(inspectCatalog(f.catalogPath).catalogSchema, 8);
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("schema7 validates pin/fence/order/journal relationships and bounds strings before materialization", async () => {
	const f = await fixture();
	const db = new DatabaseSync(f.catalogPath);
	try {
		const row = db.prepare("SELECT * FROM conversation_presentations").get();
		assert.ok(row);
		const cases: [string, SQLInputValue, string][] = [
			["workspace_id", "missing", "IDENTITY_MISMATCH"],
			["public_id", "../foreign", "IDENTITY_MISMATCH"],
			["revision", -1, "IDENTITY_MISMATCH"],
			["revision", 1.5, "IDENTITY_MISMATCH"],
			["revision", 9007199254740992n, "IDENTITY_MISMATCH"],
			["revision", 1, "IDENTITY_MISMATCH"],
			["pin_ordinal", 0, "IDENTITY_MISMATCH"],
			["pin_ordinal", 99, "IDENTITY_MISMATCH"],
			["pin_conversation_revision", null, "IDENTITY_MISMATCH"],
			["pin_conversation_revision", 2, "IDENTITY_MISMATCH"],
			["archived_revision", 3, "IDENTITY_MISMATCH"],
			["archived_revision", -1, "IDENTITY_MISMATCH"],
			["workspace_id", "w".repeat(129), "CAPACITY_EXCEEDED"],
			["public_id", "c".repeat(129), "CAPACITY_EXCEEDED"],
		];
		for (const [column, value, code] of cases) {
			db.prepare(`UPDATE conversation_presentations SET ${column}=?`).run(value);
			assert.throws(() => inspectCatalog(f.catalogPath), { code }, column);
			db.exec("DELETE FROM conversation_presentations");
			db.prepare("INSERT INTO conversation_presentations VALUES (?,?,?,?,?,?)").run(
				row.workspace_id!,
				row.public_id!,
				row.revision!,
				row.pin_ordinal!,
				row.pin_conversation_revision!,
				row.archived_revision!,
			);
		}
		const receipt = db.prepare("SELECT result FROM presentation_commands WHERE request_id='pin'").get()?.result;
		assert.equal(typeof receipt, "string");
		db.prepare("UPDATE presentation_commands SET result=? WHERE request_id='pin'").run("x".repeat(4097));
		assert.throws(() => inspectCatalog(f.catalogPath), { code: "CAPACITY_EXCEEDED" });
		db.prepare("UPDATE presentation_commands SET result=? WHERE request_id='pin'").run(receipt!);
		db.exec(
			"UPDATE presentation_commands SET digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE request_id='pin'",
		);
		assert.throws(() => inspectCatalog(f.catalogPath), { code: "IDENTITY_MISMATCH" });
	} finally {
		db.close();
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("rehashed invalid pin metadata is rejected by backup verification and restore", async () => {
	const f = await fixture();
	try {
		const result = await backupStore(f);
		const path = join(result.directory, "catalog.sqlite");
		const db = new DatabaseSync(path);
		try {
			db.exec("UPDATE conversation_presentations SET pin_conversation_revision=archived_revision");
		} finally {
			db.close();
		}
		const file = result.manifest.files.find((entry) => entry.path === "catalog.sqlite");
		assert.ok(file);
		Object.assign(file, await hashFile(path));
		await writeFile(join(result.directory, "manifest.json"), JSON.stringify(result.manifest));
		await assert.rejects(verifyBackup({ directory: result.directory }), { code: "IDENTITY_MISMATCH" });
		await assert.rejects(restoreStore({ source: result.directory, destination: join(f.parent, "archive") }), {
			code: "IDENTITY_MISMATCH",
		});
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

for (const table of ["conversation_presentations", "presentation_state", "presentation_commands"]) {
	test(`missing schema7 ${table} is never silently replaced with empty state`, async () => {
		const f = await fixture();
		try {
			const db = new DatabaseSync(f.catalogPath);
			try {
				db.exec(`DROP TABLE ${table}`);
			} finally {
				db.close();
			}
			await assert.rejects(openTestRuntime(f.source), { code: "STORE_MISMATCH" });
			const inspected = new DatabaseSync(f.catalogPath, { readOnly: true });
			try {
				assert.equal(inspected.prepare("SELECT version FROM identity").get()?.version, 7);
				assert.equal(inspected.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(table), undefined);
			} finally {
				inspected.close();
			}
		} finally {
			await rm(f.parent, { recursive: true, force: true });
		}
	});
}
