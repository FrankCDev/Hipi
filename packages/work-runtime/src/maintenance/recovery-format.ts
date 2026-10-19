import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteStorageReadOnly } from "@earendil-works/pi-durable/storage/sqlite/node";
import { archiveConversations } from "./archive-history.ts";
import { type BackupManifest, MAINTENANCE_LIMITS, MaintenanceError } from "./contracts.ts";
import { assertRegularFile, boundedDirectoryNames, canonicalDirectory, hashFile, readBoundedFile } from "./paths.ts";
import { closeRecoveryDatabase, closeRecoveryStorage } from "./recovery-resources.ts";
import { assertSqliteIntegrity, inspectWorkspace } from "./sqlite.ts";
import { parseBackupManifest } from "./verify.ts";

export const RECOVERY_TABLES = [
	"CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, store_id TEXT NOT NULL, root TEXT NOT NULL)",
	"CREATE TABLE recovery_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT NOT NULL, state TEXT NOT NULL, restore_id TEXT NOT NULL, backup_id TEXT NOT NULL, source_store_id TEXT NOT NULL, manifest_digest TEXT NOT NULL, source_backup_manifest_digest TEXT NOT NULL)",
	"CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)))",
	"CREATE TABLE archive_conversations (workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, durable_id INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace_id,public_id))",
] as const;
export type RecoveryManifest = {
	formatVersion: 1;
	mode: "recovery_archive";
	storeId: string;
	restoreId: string;
	sourceBackupManifestDigest: string;
	backupManifest: BackupManifest;
};
export function recoveryBytes(manifest: RecoveryManifest): Buffer {
	return Buffer.from(`${JSON.stringify(manifest)}\n`);
}
export function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
export function openRecoveryCatalog(path: string): DatabaseSync {
	const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
	try {
		db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON");
		const objects = db
			.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
			.all();
		if (
			objects.length !== RECOVERY_TABLES.length ||
			objects.some(
				(row) => row.type !== "table" || !RECOVERY_TABLES.includes(row.sql as (typeof RECOVERY_TABLES)[number]),
			)
		)
			throw new MaintenanceError("UNSUPPORTED_SCHEMA");
		return db;
	} catch (error) {
		closeRecoveryDatabase(db);
		throw error;
	}
}
export async function verifyRecovery(root: string, state: "preparing" | "ready" = "ready"): Promise<RecoveryManifest> {
	const manifestPath = join(root, "recovery-manifest.json");
	if ((await assertRegularFile(manifestPath)).size > MAINTENANCE_LIMITS.manifestBytes)
		throw new MaintenanceError("CAPACITY_EXCEEDED");
	const bytes = await readBoundedFile(manifestPath, MAINTENANCE_LIMITS.manifestBytes);
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaintenanceError("INTEGRITY_FAILED");
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).sort().join() !==
			"backupManifest,formatVersion,mode,restoreId,sourceBackupManifestDigest,storeId" ||
		row.formatVersion !== 1 ||
		row.mode !== "recovery_archive" ||
		typeof row.storeId !== "string" ||
		typeof row.restoreId !== "string" ||
		typeof row.sourceBackupManifestDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(row.sourceBackupManifestDigest)
	)
		throw new MaintenanceError("INTEGRITY_FAILED");
	const manifest: RecoveryManifest = {
		formatVersion: 1,
		mode: "recovery_archive",
		storeId: row.storeId,
		restoreId: row.restoreId,
		sourceBackupManifestDigest: row.sourceBackupManifestDigest,
		backupManifest: parseBackupManifest(Buffer.from(JSON.stringify(row.backupManifest))),
	};
	if (!bytes.equals(recoveryBytes(manifest))) throw new MaintenanceError("INTEGRITY_FAILED");
	await assertRegularFile(join(root, "catalog.sqlite"));
	const db = openRecoveryCatalog(join(root, "catalog.sqlite"));
	try {
		const ids = db.prepare("SELECT * FROM identity").all();
		const states = db.prepare("SELECT * FROM recovery_state").all();
		const id = ids[0];
		const recovery = states[0];
		if (
			ids.length !== 1 ||
			id.singleton !== 1 ||
			id.version !== 4 ||
			id.store_id !== manifest.storeId ||
			id.root !== root ||
			states.length !== 1 ||
			recovery.singleton !== 1 ||
			recovery.mode !== "recovery_archive" ||
			recovery.state !== state ||
			recovery.restore_id !== manifest.restoreId ||
			recovery.backup_id !== manifest.backupManifest.backupId ||
			recovery.source_store_id !== manifest.backupManifest.sourceStoreId ||
			recovery.manifest_digest !== digest(bytes) ||
			recovery.source_backup_manifest_digest !== manifest.sourceBackupManifestDigest
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		if (
			db
				.prepare(
					"SELECT 1 FROM archive_conversations WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE ready=1) LIMIT 1",
				)
				.get()
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		const workspaces = db.prepare("SELECT workspace_id,name,ready FROM workspaces ORDER BY workspace_id").all();
		const expected = [
			...manifest.backupManifest.workspaces.map((w) => ({ workspace_id: w.workspaceId, name: w.name, ready: 1 })),
			...manifest.backupManifest.reservations.map((w) => ({ workspace_id: w.workspaceId, name: w.name, ready: 0 })),
		].sort((a, b) => (a.workspace_id < b.workspace_id ? -1 : a.workspace_id > b.workspace_id ? 1 : 0));
		if (JSON.stringify(workspaces.map((w) => ({ ...w }))) !== JSON.stringify(expected))
			throw new MaintenanceError("IDENTITY_MISMATCH");
	} finally {
		closeRecoveryDatabase(db);
	}
	assertSqliteIntegrity(join(root, "catalog.sqlite"));
	const allowed = new Set([
		"catalog.sqlite",
		"store-owner.sqlite",
		"store-owner.sqlite-journal",
		"recovery-manifest.json",
		...manifest.backupManifest.workspaces.map((w) => w.workspaceId),
	]);
	for (const entry of await boundedDirectoryNames(root, MAINTENANCE_LIMITS.workspaces + 4))
		if (!allowed.has(entry)) throw new MaintenanceError("INTEGRITY_FAILED");
	for (const workspace of manifest.backupManifest.workspaces) {
		const directory = join(root, workspace.workspaceId);
		await canonicalDirectory(directory);
		if ((await boundedDirectoryNames(directory, 1)).join() !== "workspace.sqlite")
			throw new MaintenanceError("INTEGRITY_FAILED");
		const path = join(directory, "workspace.sqlite");
		const expected = manifest.backupManifest.files.find(
			(f) => f.path === `workspaces/${workspace.workspaceId}.sqlite`,
		);
		const actual = await hashFile(path);
		if (!expected || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256)
			throw new MaintenanceError("INTEGRITY_FAILED");
		const identity = await inspectWorkspace(path, workspace.workspaceId);
		if (identity.name !== workspace.name || identity.generation !== workspace.generation)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		const storage = await openNodeSqliteStorageReadOnly(path);
		let index: DatabaseSync | undefined;
		try {
			index = openRecoveryCatalog(join(root, "catalog.sqlite"));
			let count = 0;
			for await (const conversation of archiveConversations(storage, workspace.workspaceId)) {
				const { durableId, ...value } = conversation;
				const indexed = index
					.prepare("SELECT durable_id,value FROM archive_conversations WHERE workspace_id=? AND public_id=?")
					.get(workspace.workspaceId, conversation.conversationId);
				if (!indexed || indexed.durable_id !== durableId || indexed.value !== JSON.stringify(value))
					throw new MaintenanceError("IDENTITY_MISMATCH");
				count++;
			}
			if (
				index
					.prepare("SELECT count(*) AS total FROM archive_conversations WHERE workspace_id=?")
					.get(workspace.workspaceId)?.total !== count
			)
				throw new MaintenanceError("IDENTITY_MISMATCH");
		} finally {
			try {
				if (index) closeRecoveryDatabase(index);
			} finally {
				await closeRecoveryStorage(storage);
			}
		}
	}
	return manifest;
}
