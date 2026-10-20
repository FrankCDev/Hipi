import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { backupStore } from "../../src/maintenance/backup.ts";
import { hashFile } from "../../src/maintenance/paths.ts";
import { restoreStore } from "../../src/maintenance/restore.ts";
import { inspectCatalog } from "../../src/maintenance/sqlite.ts";
import { parseBackupManifest, verifyBackup } from "../../src/maintenance/verify.ts";
import type { PinKey } from "../../src/sidebar-pins/contracts.ts";
import { openTestRuntime } from "../../src/testing.ts";

const TABLES = ["sidebar_pin_order", "sidebar_pin_state", "sidebar_pin_commands"] as const;
const LEGACY_TABLES = [
	"projects",
	"project_memberships",
	"project_catalog_state",
	"project_presentations",
	"project_presentation_state",
	"project_commands",
	"conversation_presentations",
	"presentation_state",
	"presentation_commands",
] as const;

async function fixture() {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-mixed-pin-backup-")));
	const source = join(parent, "source");
	const runtime = await openTestRuntime(source);
	try {
		const keys: PinKey[] = [];
		const workspaceIds: string[] = [];
		for (let index = 0; index < 2; index++) {
			const project = await runtime.call("createProject", {
				requestId: `project-${index}`,
				name: `Project ${index}`,
			});
			workspaceIds.push(project.homeWorkspaceId);
			const { conversation } = await runtime.call("createProjectConversation", {
				requestId: `conversation-${index}`,
				projectId: project.projectId,
				title: `History ${index}`,
			});
			const scope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
			await runtime.call("setConversationPinned", {
				...scope,
				requestId: `pin-conversation-${index}`,
				expectedPresentationRevision: 0,
				pinned: true,
			});
			await runtime.call("setProjectPinned", {
				projectId: project.projectId,
				requestId: `pin-project-${index}`,
				expectedPresentationRevision: 0,
				pinned: true,
			});
			keys.push({ kind: "conversation", ...scope }, { kind: "project", projectId: project.projectId });
		}
		const page = await runtime.call("listSidebarPins", {});
		const params = {
			requestId: "mixed-reorder",
			moved: keys[3],
			before: keys[0],
			expectedOrderRevision: page.orderRevision,
		};
		const result = await runtime.call("reorderSidebarPin", params);
		const receipt = await runtime.call("getSidebarPinCommandResult", { requestId: params.requestId });
		assert.deepEqual(receipt, { method: "reorderSidebarPin", params, result });
		return {
			parent,
			source,
			path: join(source, "catalog.sqlite"),
			destination: join(parent, "backup"),
			workspaceIds,
			receipt,
		};
	} finally {
		await runtime.close();
	}
}

test("schema12 backup retains mixed authority and immutable receipts; restore remains a schema4 history archive", async () => {
	const f = await fixture();
	try {
		assert.equal(inspectCatalog(f.path).catalogSchema, 12);
		const originalBytes = await readFile(f.path);
		const originalWorkspaceBytes = await Promise.all(
			f.workspaceIds.map((id) => readFile(join(f.source, id, "workspace.sqlite"))),
		);
		const backup = await backupStore(f);
		assert.equal(backup.manifest.catalogSchema, 12);
		assert.equal((await verifyBackup({ directory: backup.directory })).manifest.catalogSchema, 12);
		assert.deepEqual(await readFile(f.path), originalBytes);
		assert.deepEqual(
			await Promise.all(f.workspaceIds.map((id) => readFile(join(f.source, id, "workspace.sqlite")))),
			originalWorkspaceBytes,
		);
		const original = new DatabaseSync(f.path, { readOnly: true });
		const copied = new DatabaseSync(join(backup.directory, "catalog.sqlite"), { readOnly: true });
		try {
			for (const table of [...TABLES, ...LEGACY_TABLES])
				assert.deepEqual(
					copied.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(),
					original.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(),
					table,
				);
		} finally {
			original.close();
			copied.close();
		}
		const runtime = await openTestRuntime(f.source);
		try {
			assert.deepEqual(await runtime.call("getSidebarPinCommandResult", { requestId: "mixed-reorder" }), f.receipt);
		} finally {
			await runtime.close();
		}
		const restored = await restoreStore({ source: backup.directory, destination: join(f.parent, "archive") });
		const archive = new DatabaseSync(join(restored.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(archive.prepare("SELECT version FROM identity").get()?.version, 4);
			for (const table of [...TABLES, ...LEGACY_TABLES])
				assert.equal(archive.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), undefined);
		} finally {
			archive.close();
		}
		await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("genuine schema11 backup remains supported; migration preserves both complete subsequences and legacy receipts", async () => {
	const f = await fixture();
	try {
		const database = new DatabaseSync(f.path);
		const oldRows = new Map(
			LEGACY_TABLES.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]),
		);
		const expected = [
			...database
				.prepare(
					"SELECT 'conversation' AS kind,NULL AS project_id,workspace_id,public_id AS conversation_id FROM conversation_presentations WHERE pin_ordinal IS NOT NULL ORDER BY pin_ordinal",
				)
				.all(),
			...database
				.prepare(
					"SELECT 'project' AS kind,s.project_id,NULL AS workspace_id,NULL AS conversation_id FROM project_presentations s JOIN projects p ON p.project_id=s.project_id WHERE s.pinned=1 AND p.status='ready' ORDER BY s.pin_ordinal",
				)
				.all(),
		];
		const storeId = database.prepare("SELECT store_id FROM identity").get()?.store_id;
		try {
			for (const table of TABLES) database.exec(`DROP TABLE ${table}`);
			database.exec("UPDATE identity SET version=11");
		} finally {
			database.close();
		}
		assert.equal(inspectCatalog(f.path).catalogSchema, 11);
		const backup = await backupStore(f);
		assert.equal((await verifyBackup({ directory: backup.directory })).manifest.catalogSchema, 11);
		const before = await Promise.all(f.workspaceIds.map((id) => readFile(join(f.source, id, "workspace.sqlite"))));
		const runtime = await openTestRuntime(f.source);
		try {
			assert.equal((await runtime.call("handshake", {})).storeId, storeId);
		} finally {
			await runtime.close();
		}
		assert.equal(inspectCatalog(f.path).catalogSchema, 12);
		assert.deepEqual(
			await Promise.all(f.workspaceIds.map((id) => readFile(join(f.source, id, "workspace.sqlite")))),
			before,
		);
		const migrated = new DatabaseSync(f.path, { readOnly: true });
		try {
			assert.deepEqual(
				migrated
					.prepare("SELECT kind,project_id,workspace_id,conversation_id FROM sidebar_pin_order ORDER BY ordinal")
					.all(),
				expected,
			);
			assert.deepEqual(
				{ ...migrated.prepare("SELECT * FROM sidebar_pin_state").get() },
				{ singleton: 1, order_revision: 1, next_ordinal: 4 },
			);
			assert.equal(migrated.prepare("SELECT count(*) AS total FROM sidebar_pin_commands").get()?.total, 0);
			for (const table of LEGACY_TABLES)
				assert.deepEqual(migrated.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(), oldRows.get(table), table);
		} finally {
			migrated.close();
		}
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("failed schema11 to12 migration rolls back mixed tables and permits a clean retry", async () => {
	const f = await fixture();
	try {
		const database = new DatabaseSync(f.path);
		try {
			for (const table of TABLES) database.exec(`DROP TABLE ${table}`);
			database.exec(
				"UPDATE identity SET version=11; CREATE TRIGGER reject_mixed BEFORE UPDATE OF version ON identity WHEN NEW.version=12 BEGIN SELECT RAISE(ABORT,'mixed migration failure'); END",
			);
		} finally {
			database.close();
		}
		const before = await Promise.all(f.workspaceIds.map((id) => readFile(join(f.source, id, "workspace.sqlite"))));
		await assert.rejects(openTestRuntime(f.source), /mixed migration failure/);
		const failed = new DatabaseSync(f.path);
		try {
			assert.equal(failed.prepare("SELECT version FROM identity").get()?.version, 11);
			for (const table of TABLES)
				assert.equal(failed.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), undefined);
			failed.exec("DROP TRIGGER reject_mixed");
		} finally {
			failed.close();
		}
		assert.equal(inspectCatalog(f.path).catalogSchema, 11);
		const runtime = await openTestRuntime(f.source);
		await runtime.close();
		assert.equal(inspectCatalog(f.path).catalogSchema, 12);
		assert.deepEqual(
			await Promise.all(f.workspaceIds.map((id) => readFile(join(f.source, id, "workspace.sqlite")))),
			before,
		);
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

for (const sql of [
	"DELETE FROM sidebar_pin_order WHERE ordinal=(SELECT min(ordinal) FROM sidebar_pin_order)",
	"UPDATE sidebar_pin_order SET ordinal=-ordinal WHERE kind='project'; UPDATE sidebar_pin_order SET ordinal=4+ordinal WHERE kind='project'",
	"UPDATE sidebar_pin_commands SET digest=printf('%064d',0)",
]) {
	test(`rehashed schema12 corruption cannot pass verification or archive restore: ${sql}`, async () => {
		const f = await fixture();
		try {
			const backup = await backupStore(f);
			const path = join(backup.directory, "catalog.sqlite");
			const database = new DatabaseSync(path);
			try {
				database.exec(sql);
			} finally {
				database.close();
			}
			const file = backup.manifest.files.find((entry) => entry.path === "catalog.sqlite");
			assert.ok(file);
			Object.assign(file, await hashFile(path));
			await writeFile(join(backup.directory, "manifest.json"), JSON.stringify(backup.manifest));
			await assert.rejects(verifyBackup({ directory: backup.directory }), { code: "IDENTITY_MISMATCH" });
			await assert.rejects(restoreStore({ source: backup.directory, destination: join(f.parent, "archive") }), {
				code: "IDENTITY_MISMATCH",
			});
		} finally {
			await rm(f.parent, { recursive: true, force: true });
		}
	});
}

for (const sql of [
	...TABLES.map((table) => `DROP TABLE ${table}`),
	"DROP INDEX sidebar_pin_project",
	"DROP INDEX sidebar_pin_conversation",
	"DROP INDEX sidebar_pin_ordinal",
]) {
	test(`schema12 structural loss is rejected without runtime mutation: ${sql}`, async () => {
		const f = await fixture();
		try {
			const database = new DatabaseSync(f.path);
			try {
				database.exec(sql);
			} finally {
				database.close();
			}
			const before = await readFile(f.path);
			assert.throws(() => inspectCatalog(f.path), { code: "UNSUPPORTED_SCHEMA" });
			await assert.rejects(openTestRuntime(f.source), { code: "STORE_MISMATCH" });
			assert.deepEqual(await readFile(f.path), before);
		} finally {
			await rm(f.parent, { recursive: true, force: true });
		}
	});
}

test("schema12 maintenance rejects unsupported future manifests and catalog identity", async () => {
	const f = await fixture();
	try {
		const { manifest } = await backupStore(f);
		assert.throws(() => parseBackupManifest(Buffer.from(JSON.stringify({ ...manifest, catalogSchema: 13 }))), {
			code: "UNSUPPORTED_SCHEMA",
		});
		const database = new DatabaseSync(f.path);
		try {
			database.exec("UPDATE identity SET version=13");
		} finally {
			database.close();
		}
		assert.throws(() => inspectCatalog(f.path), { code: "UNSUPPORTED_SCHEMA" });
		await assert.rejects(openTestRuntime(f.source), { code: "STORE_MISMATCH" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
