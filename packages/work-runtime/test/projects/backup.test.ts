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
import { parseProjectParams } from "../../src/projects/contracts.ts";
import { initializeProjectStore, projectCommandDigest } from "../../src/projects/schema.ts";
import { openTestRuntime } from "../../src/testing.ts";

const TABLES = [
	"projects",
	"project_memberships",
	"project_catalog_state",
	"project_presentations",
	"project_presentation_state",
	"project_commands",
] as const;

async function fixture() {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-logical-project-backup-")));
	const source = join(parent, "source");
	const runtime = await openTestRuntime(source);
	try {
		await runtime.call("createWorkspace", { workspaceId: "home", name: "Physical name" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "home",
			requestId: "create",
			title: "Preserved history",
		});
		await runtime.call("archiveConversation", {
			workspaceId: "home",
			conversationId: conversation.conversationId,
			requestId: "archive",
			expectedRevision: 1,
		});
		await runtime.close();
		const path = join(source, "catalog.sqlite");
		const database = new DatabaseSync(path);
		try {
			// This maintenance fixture explicitly installs all logical records; runtime migration is tested separately.
			database.exec(
				"DROP TABLE IF EXISTS sidebar_pin_order; DROP TABLE IF EXISTS sidebar_pin_state; DROP TABLE IF EXISTS sidebar_pin_commands",
			);
			for (const table of TABLES) database.exec(`DROP TABLE IF EXISTS ${table}`);
			initializeProjectStore(database, { pristine: false });
			database.exec(
				"UPDATE identity SET version=11; INSERT INTO projects VALUES ('logical','Logical rename',2,'home','created','ready'); INSERT INTO project_presentations VALUES ('logical',1,1,1); UPDATE project_presentation_state SET order_generation=1,next_ordinal=1; UPDATE project_catalog_state SET membership_generation=1,metadata_generation=2",
			);
			database
				.prepare("INSERT INTO project_memberships VALUES ('home',?,'logical',1,'created')")
				.run(conversation.conversationId);
			const params = parseProjectParams("renameProject", {
				requestId: "rename",
				projectId: "logical",
				expectedRevision: 1,
				name: "Logical rename",
			});
			database
				.prepare("INSERT INTO project_commands VALUES (?,?,?,?,?,'complete',?)")
				.run(
					params.requestId,
					"renameProject",
					projectCommandDigest("renameProject", params),
					JSON.stringify(params),
					"{}",
					JSON.stringify({ projectId: "logical", name: "Logical rename", revision: 2, homeWorkspaceId: "home" }),
				);
			const pending = parseProjectParams("createProject", { requestId: "pending", name: "Not yet created" });
			database
				.prepare("INSERT INTO project_commands VALUES (?,?,?,?,?,'reserved',NULL)")
				.run(
					pending.requestId,
					"createProject",
					projectCommandDigest("createProject", pending),
					JSON.stringify(pending),
					JSON.stringify({ projectId: "reserved_project", workspaceId: "reserved_workspace" }),
				);
		} finally {
			database.close();
		}
		return { parent, source, path, destination: join(parent, "backup") };
	} finally {
		await runtime.close();
	}
}

test("schema11 backup retains complete logical catalog records; restore remains a schema4 read-only history archive", async () => {
	const f = await fixture();
	try {
		assert.equal(inspectCatalog(f.path).catalogSchema, 11);
		const sourceBytes = await readFile(f.path);
		const workspaceBytes = await readFile(join(f.source, "home", "workspace.sqlite"));
		const result = await backupStore(f);
		assert.equal(result.manifest.catalogSchema, 11);
		assert.equal((await verifyBackup({ directory: result.directory })).manifest.catalogSchema, 11);
		assert.deepEqual(await readFile(f.path), sourceBytes);
		assert.deepEqual(await readFile(join(f.source, "home", "workspace.sqlite")), workspaceBytes);
		const original = new DatabaseSync(f.path, { readOnly: true });
		const copied = new DatabaseSync(join(result.directory, "catalog.sqlite"), { readOnly: true });
		try {
			for (const table of TABLES)
				assert.deepEqual(
					copied.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
					original.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
					table,
				);
		} finally {
			copied.close();
			original.close();
		}
		const restored = await restoreStore({ source: result.directory, destination: join(f.parent, "archive") });
		const archive = new DatabaseSync(join(restored.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(archive.prepare("SELECT version FROM identity").get()?.version, 4);
			for (const table of TABLES)
				assert.equal(archive.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), undefined);
		} finally {
			archive.close();
		}
		await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("rehashed schema11 relationship corruption fails verification and archive restore", async () => {
	const f = await fixture();
	try {
		const result = await backupStore(f);
		const path = join(result.directory, "catalog.sqlite");
		const database = new DatabaseSync(path);
		try {
			database.exec("UPDATE project_memberships SET project_id='missing'");
		} finally {
			database.close();
		}
		const file = result.manifest.files.find((file) => file.path === "catalog.sqlite");
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

test("schema11 maintenance rejects missing or replaced indexes and unsupported future catalog versions", async () => {
	const f = await fixture();
	try {
		const { manifest } = await backupStore(f);
		assert.throws(() => parseBackupManifest(Buffer.from(JSON.stringify({ ...manifest, catalogSchema: 13 }))), {
			code: "UNSUPPORTED_SCHEMA",
		});
		const database = new DatabaseSync(f.path);
		try {
			database.exec("UPDATE identity SET version=13");
			assert.throws(() => inspectCatalog(f.path), { code: "UNSUPPORTED_SCHEMA" });
			database.exec("UPDATE identity SET version=11; DROP INDEX project_membership_scope");
			assert.throws(() => inspectCatalog(f.path), { code: "UNSUPPORTED_SCHEMA" });
			database.exec("CREATE INDEX project_membership_scope ON project_memberships(project_id)");
			assert.throws(() => inspectCatalog(f.path), { code: "UNSUPPORTED_SCHEMA" });
		} finally {
			database.close();
		}
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("genuine schema10 backup remains supported and migration through11 to12 preserves physical data without assigning a default role", async () => {
	const f = await fixture();
	try {
		const database = new DatabaseSync(f.path);
		let storeId: unknown;
		try {
			for (const table of TABLES) database.exec(`DROP TABLE ${table}`);
			database.exec("UPDATE identity SET version=10");
			storeId = database.prepare("SELECT store_id FROM identity").get()?.store_id;
		} finally {
			database.close();
		}
		assert.equal(inspectCatalog(f.path).catalogSchema, 10);
		const backup = await backupStore(f);
		assert.equal(backup.manifest.catalogSchema, 10);
		assert.equal((await verifyBackup({ directory: backup.directory })).manifest.catalogSchema, 10);
		const before = await readFile(join(f.source, "home", "workspace.sqlite"));
		const runtime = await openTestRuntime(f.source);
		try {
			assert.equal((await runtime.call("handshake", {})).storeId, storeId);
			assert.deepEqual(await runtime.call("getProjectCatalogState", {}), {
				state: "ready",
				generation: 0,
				defaultWorkspaceId: null,
			});
		} finally {
			await runtime.close();
		}
		assert.equal(inspectCatalog(f.path).catalogSchema, 12);
		assert.deepEqual(await readFile(join(f.source, "home", "workspace.sqlite")), before);
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("failed schema10 to11 migration rolls back all logical tables and retries under the same owner", async () => {
	const f = await fixture();
	try {
		const database = new DatabaseSync(f.path);
		try {
			for (const table of TABLES) database.exec(`DROP TABLE ${table}`);
			database.exec(
				"UPDATE identity SET version=10; CREATE TRIGGER reject_projects BEFORE UPDATE OF version ON identity WHEN NEW.version=11 BEGIN SELECT RAISE(ABORT,'project migration failure'); END",
			);
		} finally {
			database.close();
		}
		const before = await readFile(join(f.source, "home", "workspace.sqlite"));
		await assert.rejects(openTestRuntime(f.source), /project migration failure/);
		const failed = new DatabaseSync(f.path);
		try {
			assert.equal(failed.prepare("SELECT version FROM identity").get()?.version, 10);
			for (const table of TABLES)
				assert.equal(failed.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), undefined);
			failed.exec("DROP TRIGGER reject_projects");
		} finally {
			failed.close();
		}
		assert.equal(inspectCatalog(f.path).catalogSchema, 10);
		const runtime = await openTestRuntime(f.source);
		await runtime.close();
		assert.equal(inspectCatalog(f.path).catalogSchema, 12);
		assert.deepEqual(await readFile(join(f.source, "home", "workspace.sqlite")), before);
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

for (const table of TABLES) {
	test(`schema11 missing ${table} is rejected before runtime mutates or recreates authoritative data`, async () => {
		const f = await fixture();
		try {
			const database = new DatabaseSync(f.path);
			try {
				database.exec(`DROP TABLE ${table}`);
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
