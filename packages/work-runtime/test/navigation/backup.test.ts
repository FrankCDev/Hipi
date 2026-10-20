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
import { verifyBackup } from "../../src/maintenance/verify.ts";
import { openTestRuntime } from "../../src/testing.ts";

test("genuine schema9 migration preserves identity and PI bytes; schema12 backup restores only an archive", async () => {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-navigation-backup-")));
	const source = join(parent, "source");
	const path = join(source, "catalog.sqlite");
	let runtime = await openTestRuntime(source);
	try {
		await runtime.call("createWorkspace", { workspaceId: "w", name: "Workspace" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "w",
			requestId: "create",
			title: "Preserved",
		});
		const identity = await runtime.call("handshake", {});
		await runtime.close();
		const legacy = new DatabaseSync(path);
		try {
			legacy.exec(
				"DROP TABLE sidebar_pin_commands; DROP TABLE sidebar_pin_order; DROP TABLE sidebar_pin_state; DROP TABLE project_commands; DROP TABLE project_memberships; DROP TABLE project_presentations; DROP TABLE project_presentation_state; DROP TABLE project_catalog_state; DROP TABLE projects; DROP TABLE navigation_sources; DROP TABLE navigation_publication; DROP TABLE navigation_state; UPDATE identity SET version=9",
			);
		} finally {
			legacy.close();
		}
		assert.equal(inspectCatalog(path).catalogSchema, 9);
		const workspacePath = join(source, "w", "workspace.sqlite");
		const before = await readFile(workspacePath);
		runtime = await openTestRuntime(source);
		assert.deepEqual(await runtime.call("handshake", {}), identity);
		assert.deepEqual(
			await runtime.call("getConversation", { workspaceId: "w", conversationId: conversation.conversationId }),
			conversation,
		);
		await runtime.close();
		assert.deepEqual(await readFile(workspacePath), before);
		assert.equal(inspectCatalog(path).catalogSchema, 12);
		const catalogBefore = await readFile(path);
		const backup = await backupStore({ source, destination: join(parent, "backup") });
		assert.equal(backup.manifest.catalogSchema, 12);
		assert.deepEqual(await readFile(path), catalogBefore);
		assert.equal((await verifyBackup({ directory: backup.directory })).manifest.catalogSchema, 12);
		const restored = await restoreStore({ source: backup.directory, destination: join(parent, "archive") });
		const archive = new DatabaseSync(join(restored.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(archive.prepare("SELECT version FROM identity").get()?.version, 4);
			assert.equal(archive.prepare("SELECT 1 FROM sqlite_schema WHERE name='navigation_state'").get(), undefined);
		} finally {
			archive.close();
		}
		await assert.rejects(openTestRuntime(restored.directory), { code: "STORE_MISMATCH" });
		const backupPath = join(backup.directory, "catalog.sqlite");
		const invalid = new DatabaseSync(backupPath);
		try {
			invalid.exec("UPDATE navigation_state SET inventory_generation=-1");
		} finally {
			invalid.close();
		}
		const catalogFile = backup.manifest.files.find((file) => file.path === "catalog.sqlite");
		assert.ok(catalogFile);
		Object.assign(catalogFile, await hashFile(backupPath));
		await writeFile(join(backup.directory, "manifest.json"), JSON.stringify(backup.manifest));
		await assert.rejects(verifyBackup({ directory: backup.directory }), { code: "IDENTITY_MISMATCH" });
		await assert.rejects(restoreStore({ source: backup.directory, destination: join(parent, "rejected-archive") }), {
			code: "IDENTITY_MISMATCH",
		});
	} finally {
		await runtime.close();
		await rm(parent, { recursive: true, force: true });
	}
});

test("schema10 missing required navigation index fails runtime and maintenance preflight", async () => {
	const source = await mkdtemp(join(tmpdir(), "hipi-navigation-index-"));
	const runtime = await openTestRuntime(source);
	try {
		await runtime.close();
		const path = join(source, "catalog.sqlite"),
			db = new DatabaseSync(path);
		try {
			db.exec("DROP INDEX navigation_recent");
		} finally {
			db.close();
		}
		assert.throws(() => inspectCatalog(path), { code: "UNSUPPORTED_SCHEMA" });
		await assert.rejects(openTestRuntime(source), { code: "STORE_MISMATCH" });
	} finally {
		await runtime.close();
		await rm(source, { recursive: true, force: true });
	}
});

test("schema10 rejects old generated keys and same-name malformed keyset indexes before opening runtime", async () => {
	for (const corruption of ["recent", "workspace", "expression", "legacy"] as const) {
		const source = await mkdtemp(join(tmpdir(), "hipi-navigation-keyset-"));
		const runtime = await openTestRuntime(source);
		try {
			await runtime.close();
			const path = join(source, "catalog.sqlite");
			const db = new DatabaseSync(path);
			try {
				if (corruption === "recent") {
					db.exec(
						"DROP INDEX navigation_recent; CREATE INDEX navigation_recent ON navigation_sources(cycle,recency_at DESC,workspace_id,ordinal,public_id)",
					);
				} else if (corruption === "workspace") {
					db.exec(
						"DROP INDEX navigation_workspace; CREATE INDEX navigation_workspace ON navigation_sources(cycle,recency_key,workspace_id,ordinal,public_id)",
					);
				} else {
					const original = db.prepare("SELECT sql FROM sqlite_schema WHERE name='navigation_sources'").get()?.sql;
					assert.ok(typeof original === "string");
					db.exec("DROP TABLE navigation_sources");
					if (corruption === "expression") {
						db.exec(original.replace("-coalesce(recency_at,-1)", "-coalesce(recency_at,0)"));
						db.exec(
							"CREATE INDEX navigation_recent ON navigation_sources(cycle,recency_key,workspace_id,ordinal,public_id); CREATE INDEX navigation_workspace ON navigation_sources(cycle,workspace_id,recency_key,ordinal,public_id)",
						);
					} else {
						db.exec(
							original.replace(
								"recency_key INTEGER GENERATED ALWAYS AS (-coalesce(recency_at,-1)) VIRTUAL, ",
								"",
							),
						);
						db.exec(
							"CREATE INDEX navigation_recent ON navigation_sources(cycle,recency_at DESC,workspace_id,ordinal,public_id)",
						);
					}
				}
			} finally {
				db.close();
			}
			const before = await readFile(path);
			assert.throws(() => inspectCatalog(path), { code: "UNSUPPORTED_SCHEMA" });
			await assert.rejects(openTestRuntime(source), { code: "STORE_MISMATCH" });
			assert.deepEqual(await readFile(path), before);
		} finally {
			await runtime.close();
			await rm(source, { recursive: true, force: true });
		}
	}
});
test("failed real schema9 migration retains version9 and can be retried after removing the failure", async () => {
	const source = await realpath(await mkdtemp(join(tmpdir(), "hipi-navigation-migration-")));
	let runtime = await openTestRuntime(source);
	try {
		await runtime.call("createWorkspace", { workspaceId: "w", name: "Workspace" });
		await runtime.close();
		const path = join(source, "catalog.sqlite");
		const workspaceBefore = await readFile(join(source, "w", "workspace.sqlite"));
		const db = new DatabaseSync(path);
		try {
			db.exec(
				"DROP TABLE sidebar_pin_commands; DROP TABLE sidebar_pin_order; DROP TABLE sidebar_pin_state; DROP TABLE project_commands; DROP TABLE project_memberships; DROP TABLE project_presentations; DROP TABLE project_presentation_state; DROP TABLE project_catalog_state; DROP TABLE projects; DROP TABLE navigation_sources; DROP TABLE navigation_publication; DROP TABLE navigation_state; UPDATE identity SET version=9; CREATE TRIGGER reject_navigation BEFORE UPDATE OF version ON identity WHEN NEW.version=10 BEGIN SELECT RAISE(ABORT,'navigation migration failure'); END",
			);
		} finally {
			db.close();
		}
		await assert.rejects(openTestRuntime(source), /navigation migration failure/);
		const failed = new DatabaseSync(path);
		try {
			assert.equal(failed.prepare("SELECT version FROM identity").get()?.version, 9);
			assert.equal(failed.prepare("SELECT 1 FROM sqlite_schema WHERE name='navigation_state'").get(), undefined);
			assert.equal(failed.prepare("SELECT 1 FROM sqlite_schema WHERE name='navigation_sources'").get(), undefined);
			assert.equal(
				failed.prepare("SELECT 1 FROM sqlite_schema WHERE name='navigation_publication'").get(),
				undefined,
			);
			failed.exec("DROP TRIGGER reject_navigation");
		} finally {
			failed.close();
		}
		assert.deepEqual(await readFile(join(source, "w", "workspace.sqlite")), workspaceBefore);
		assert.equal(inspectCatalog(path).catalogSchema, 9);
		runtime = await openTestRuntime(source);
		await runtime.close();
		assert.equal(inspectCatalog(path).catalogSchema, 12);
	} finally {
		await runtime.close();
		await rm(source, { recursive: true, force: true });
	}
});
