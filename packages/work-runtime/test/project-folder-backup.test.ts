import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { openRecoveryArchive } from "../src/maintenance/archive.ts";
import { backupStore } from "../src/maintenance/backup.ts";
import { hashFile } from "../src/maintenance/paths.ts";
import { restoreStore } from "../src/maintenance/restore.ts";
import { inspectCatalog } from "../src/maintenance/sqlite.ts";
import { verifyBackup } from "../src/maintenance/verify.ts";
import { openTestRuntime } from "../src/testing.ts";

async function fixture() {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-project-folder-backup-")));
	const source = join(parent, "source");
	const runtime = await openTestRuntime(source);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Bound workspace" });
		await runtime.call("createWorkspace", { workspaceId: "revoked", name: "Revoked workspace" });
	} finally {
		await runtime.close();
	}
	const catalogPath = join(source, "catalog.sqlite");
	const projectPath = join(parent, "offline project");
	const db = new DatabaseSync(catalogPath);
	try {
		// Keep the schema6 compatibility fixture independent of later catalog migrations.
		db.exec(
			"DROP TABLE sidebar_pin_commands; DROP TABLE sidebar_pin_order; DROP TABLE sidebar_pin_state; DROP TABLE project_commands; DROP TABLE project_memberships; DROP TABLE project_presentations; DROP TABLE project_presentation_state; DROP TABLE project_catalog_state; DROP TABLE projects; DROP TABLE navigation_sources; DROP TABLE navigation_publication; DROP TABLE navigation_state; DROP TABLE search_chunks; DROP TABLE search_sources; DROP TABLE search_state; DROP TABLE conversation_presentations; DROP TABLE presentation_state; DROP TABLE presentation_commands; UPDATE identity SET version=6",
		);
		db.prepare("INSERT INTO project_folders VALUES ('work','binding-current',3,?,?,?,'Offline project',0)").run(
			projectPath,
			"18446744073709551615",
			"1234567890123456789012345678901234567890",
		);
		db.exec("INSERT INTO project_folders VALUES ('revoked','binding-revoked',4,NULL,NULL,NULL,'Former project',1)");
	} finally {
		db.close();
	}
	return { parent, source, catalogPath, projectPath, destination: join(parent, "backup") };
}

test("schema6 snapshots preserve bound and revoked metadata but recovery never restores project access", async () => {
	const f = await fixture();
	try {
		const sourceBefore = await readFile(f.catalogPath);
		const result = await backupStore(f);
		assert.equal(result.manifest.catalogSchema, 6);
		assert.deepEqual(await readFile(f.catalogPath), sourceBefore);
		assert.equal((await verifyBackup({ directory: result.directory })).manifest.catalogSchema, 6);
		const db = new DatabaseSync(join(result.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.deepEqual(
				db
					.prepare("SELECT * FROM project_folders ORDER BY workspace_id")
					.all()
					.map((row) => ({ ...row })),
				[
					{
						workspace_id: "revoked",
						binding_id: "binding-revoked",
						revision: 4,
						canonical_path: null,
						device: null,
						inode: null,
						display_name: "Former project",
						revoked: 1,
					},
					{
						workspace_id: "work",
						binding_id: "binding-current",
						revision: 3,
						canonical_path: f.projectPath,
						device: "18446744073709551615",
						inode: "1234567890123456789012345678901234567890",
						display_name: "Offline project",
						revoked: 0,
					},
				],
			);
		} finally {
			db.close();
		}
		const restored = await restoreStore({ source: result.directory, destination: join(f.parent, "archive") });
		const recovered = new DatabaseSync(join(restored.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(recovered.prepare("SELECT version FROM identity").get()?.version, 4);
			assert.equal(
				recovered.prepare("SELECT name FROM sqlite_schema WHERE name='project_folders'").get(),
				undefined,
			);
		} finally {
			recovered.close();
		}
		assert.equal(
			(await readFile(join(restored.directory, "recovery-manifest.json"), "utf8")).includes(f.projectPath),
			false,
		);
		const archive = await openRecoveryArchive({ directory: restored.directory });
		try {
			assert.equal((await archive.listWorkspaces({ storeId: restored.storeId })).items.length, 2);
			for (const method of ["getProjectFolder", "bindProjectFolder", "unbindProjectFolder", "listRoots"])
				assert.equal(method in archive, false);
		} finally {
			await archive.close();
		}
		await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
		await assert.rejects(backupStore({ source: restored.directory, destination: join(f.parent, "archive-backup") }), {
			code: "UNSUPPORTED_SCHEMA",
		});
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

for (const version of [3, 5]) {
	test(`existing schema${version} backups remain verifiable and restore without project bindings`, async () => {
		const f = await fixture();
		try {
			const db = new DatabaseSync(f.catalogPath);
			try {
				db.exec("DROP TABLE project_folders");
				if (version === 3) db.exec("DROP TABLE custom_providers; DROP TABLE provider_commands");
				db.prepare("UPDATE identity SET version=?").run(version);
			} finally {
				db.close();
			}
			assert.equal(inspectCatalog(f.catalogPath).catalogSchema, version);
			const result = await backupStore(f);
			assert.equal(result.manifest.catalogSchema, version);
			assert.equal((await verifyBackup({ directory: result.directory })).manifest.catalogSchema, version);
			const restored = await restoreStore({ source: result.directory, destination: join(f.parent, "archive") });
			const archive = await openRecoveryArchive({ directory: restored.directory });
			try {
				assert.equal((await archive.listWorkspaces({ storeId: restored.storeId })).items.length, 2);
			} finally {
				await archive.close();
			}
			await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
		} finally {
			await rm(f.parent, { recursive: true, force: true });
		}
	});
}

test("schema6 validates bound and revoked records, ready workspace ownership and safe revisions", async () => {
	const f = await fixture();
	const db = new DatabaseSync(f.catalogPath);
	try {
		const cases: [string, SQLInputValue][] = [
			["workspace_id", "missing"],
			["workspace_id", null],
			["binding_id", ""],
			["binding_id", "binding/path"],
			["binding_id", new Uint8Array([97])],
			["revision", 0],
			["revision", -1],
			["revision", 1.5],
			["revision", 9007199254740992n],
			["canonical_path", null],
			["canonical_path", "relative/path"],
			["canonical_path", "/nul\0path"],
			["canonical_path", `/${"a".repeat(4096)}`],
			["device", null],
			["device", "-1"],
			["device", "01"],
			["device", "1.2"],
			["inode", null],
			["inode", "1e3"],
			["inode", new Uint8Array([49])],
			["display_name", ""],
			["display_name", "unsafe/path"],
			["display_name", "unsafe\\path"],
			["display_name", "unsafe\nname"],
			["display_name", "unsafe\u202ename"],
			["display_name", "a".repeat(256)],
		];
		for (const [column, value] of cases) {
			db.exec("BEGIN IMMEDIATE");
			try {
				db.prepare(`UPDATE project_folders SET ${column}=? WHERE workspace_id='work'`).run(value);
				db.exec("COMMIT");
				assert.throws(() => inspectCatalog(f.catalogPath), { code: "IDENTITY_MISMATCH" }, column);
			} finally {
				// Reload the exact valid row rather than asking the runtime to repair corrupt metadata.
				db.exec("DELETE FROM project_folders WHERE revoked=0");
				db.prepare("INSERT INTO project_folders VALUES ('work','binding-current',3,?,'0','1','Project',0)").run(
					f.projectPath,
				);
			}
		}
		db.exec("UPDATE workspaces SET ready=0 WHERE workspace_id='work'");
		assert.throws(() => inspectCatalog(f.catalogPath), { code: "IDENTITY_MISMATCH" });
		db.exec("UPDATE workspaces SET ready=1 WHERE workspace_id='work'");
		for (const column of ["canonical_path", "device", "inode"]) {
			db.prepare(`UPDATE project_folders SET ${column}=? WHERE revoked=1`).run("retained-private-value");
			assert.throws(() => inspectCatalog(f.catalogPath), { code: "IDENTITY_MISMATCH" });
			db.prepare(`UPDATE project_folders SET ${column}=NULL WHERE revoked=1`).run();
		}
		db.exec("UPDATE project_folders SET display_name=NULL WHERE revoked=0");
		assert.equal(inspectCatalog(f.catalogPath).catalogSchema, 6);
		for (const path of ["/missing/posix/project", "C:\\missing\\windows\\project", "\\\\server\\share\\project"]) {
			db.prepare("UPDATE project_folders SET canonical_path=? WHERE revoked=0").run(path);
			assert.equal(inspectCatalog(f.catalogPath).catalogSchema, 6);
		}
	} finally {
		db.close();
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("schema6 project metadata is byte-budgeted and row-count bounded before materialization", async () => {
	const f = await fixture();
	const db = new DatabaseSync(f.catalogPath);
	try {
		for (const [column, value] of [
			["workspace_id", "a".repeat(129)],
			["binding_id", "a".repeat(129)],
			["canonical_path", `/${"界".repeat(4096)}`],
			["device", "1".repeat(41)],
			["inode", "1".repeat(41)],
			["display_name", "界".repeat(341)],
		] as const) {
			db.prepare(`UPDATE project_folders SET ${column}=? WHERE revoked=0`).run(value);
			assert.throws(() => inspectCatalog(f.catalogPath), { code: "CAPACITY_EXCEEDED" }, column);
			db.exec("DELETE FROM project_folders WHERE revoked=0");
			db.prepare("INSERT INTO project_folders VALUES ('work','binding-current',3,?,'0','1','Project',0)").run(
				f.projectPath,
			);
		}
		db.prepare("UPDATE project_folders SET display_name=? WHERE revoked=0").run("😀".repeat(255));
		db.prepare("UPDATE project_folders SET canonical_path=?,revision=? WHERE revoked=0").run(
			`/${"界".repeat(4095)}`,
			Number.MAX_SAFE_INTEGER,
		);
		assert.equal(inspectCatalog(f.catalogPath).catalogSchema, 6);
		db.exec("DELETE FROM project_folders");
		db.exec(
			"WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<10001) INSERT INTO project_folders SELECT 'extra_'||n,'binding',1,NULL,NULL,NULL,NULL,1 FROM ids",
		);
		assert.throws(() => inspectCatalog(f.catalogPath), { code: "CAPACITY_EXCEEDED" });
	} finally {
		db.close();
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("schema6 verification rejects invalid project metadata even after its file digest is recomputed", async () => {
	const f = await fixture();
	try {
		const result = await backupStore(f);
		const catalog = join(result.directory, "catalog.sqlite");
		const db = new DatabaseSync(catalog);
		try {
			db.prepare("UPDATE project_folders SET canonical_path=? WHERE revoked=1").run(f.projectPath);
		} finally {
			db.close();
		}
		const file = result.manifest.files.find((file) => file.path === "catalog.sqlite");
		assert.ok(file);
		Object.assign(file, await hashFile(catalog));
		await writeFile(join(result.directory, "manifest.json"), JSON.stringify(result.manifest));
		await assert.rejects(verifyBackup({ directory: result.directory }), { code: "IDENTITY_MISMATCH" });
		await assert.rejects(restoreStore({ source: result.directory, destination: join(f.parent, "archive") }), {
			code: "IDENTITY_MISMATCH",
		});
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
