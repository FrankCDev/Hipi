import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { openNodeSqliteStorageReadOnly } from "@earendil-works/pi-durable/storage/sqlite/node";
import { StoreOwnerLease } from "../store-owner.ts";
import { archiveConversations } from "./archive-history.ts";
import { MAINTENANCE_LIMITS, MaintenanceError, maintenanceError } from "./contracts.ts";
import { allocateDirectory, assertRegularFile, hashFile, syncPath } from "./paths.ts";
import { digest, RECOVERY_TABLES, type RecoveryManifest, recoveryBytes, verifyRecovery } from "./recovery-format.ts";
import { closeRecoveryStorage, retainOwnerOnCloseFailure } from "./recovery-resources.ts";
import { verifyBackup } from "./verify.ts";

// A failed native close cannot prove that ownership is safe to release. Retain until process exit.
const failedCloses: { db: DatabaseSync; owner?: StoreOwnerLease }[] = [];

function closeRestore(db: DatabaseSync | undefined, owner: StoreOwnerLease | undefined): void {
	if (db) {
		try {
			db.close();
		} catch (error) {
			failedCloses.push({ db, owner });
			throw error;
		}
	}
	owner?.close();
}

export type RestoreOptions = { source: string; destination: string; signal?: AbortSignal };
export type RestoreResult = {
	directory: string;
	storeId: string;
	restoreId: string;
	backupId: string;
	mode: "recovery_archive";
};
export type RestorePhase =
	| "allocate_target"
	| "lock_target"
	| "prepare_catalog"
	| "copy_workspaces"
	| "verify_target"
	| "sync_payload"
	| "commit_ready"
	| "complete";
/** Injection is confined to this explicit test seam; production callers use restoreStore. */
export async function restoreStoreForTest(
	options: RestoreOptions,
	checkpoint: (phase: RestorePhase, directory: string) => Promise<void>,
): Promise<RestoreResult> {
	return restore(options, checkpoint);
}
export async function restoreStore(options: RestoreOptions): Promise<RestoreResult> {
	return restore(options);
}
async function restore(
	options: RestoreOptions,
	checkpoint?: (phase: RestorePhase, directory: string) => Promise<void>,
): Promise<RestoreResult> {
	const restoreId = randomUUID();
	let phase = "verify_backup";
	let owner: StoreOwnerLease | undefined;
	let db: DatabaseSync | undefined;
	let retainOwner = false;
	try {
		if (options.signal?.aborted) throw new MaintenanceError("CANCELLED");
		const backup = await verifyBackup({ directory: options.source });
		phase = "allocate_target";
		const root = await allocateDirectory(backup.directory, options.destination);
		const step = async (next: RestorePhase) => {
			phase = next;
			if (options.signal?.aborted) throw new MaintenanceError("CANCELLED");
			await checkpoint?.(next, root);
		};
		await step("allocate_target");
		owner = await StoreOwnerLease.acquire(root);
		await step("lock_target");
		// A competitor may acquire and release the lock between mkdir and our acquisition.
		// Every non-owner artifact, including an empty catalog or any sidecar, is a collision.
		for (const entry of await readdir(root))
			if (entry !== "store-owner.sqlite" && entry !== "store-owner.sqlite-journal")
				throw new MaintenanceError("TARGET_EXISTS");
		const storeId = randomUUID();
		const manifest: RecoveryManifest = {
			formatVersion: 1,
			mode: "recovery_archive",
			storeId,
			restoreId,
			sourceBackupManifestDigest: backup.manifestDigest,
			backupManifest: backup.manifest,
		};
		const bytes = recoveryBytes(manifest);
		if (bytes.length > MAINTENANCE_LIMITS.manifestBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
		const catalogPath = join(root, "catalog.sqlite");
		const exclusive = await open(catalogPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		await exclusive.close();
		db = new DatabaseSync(catalogPath, { allowExtension: false });
		db.exec("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
		try {
			for (const sql of RECOVERY_TABLES) db.exec(sql);
			db.prepare("INSERT INTO identity VALUES (1,4,?,?)").run(storeId, root);
			db.prepare("INSERT INTO recovery_state VALUES (1,'recovery_archive','preparing',?,?,?,?,?)").run(
				restoreId,
				backup.manifest.backupId,
				backup.manifest.sourceStoreId,
				digest(bytes),
				backup.manifestDigest,
			);
			for (const workspace of backup.manifest.workspaces)
				db.prepare("INSERT INTO workspaces VALUES (?,?,1)").run(workspace.workspaceId, workspace.name);
			for (const workspace of backup.manifest.reservations)
				db.prepare("INSERT INTO workspaces VALUES (?,?,0)").run(workspace.workspaceId, workspace.name);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		await step("prepare_catalog");
		await writeFile(join(root, "recovery-manifest.json"), bytes, { flag: "wx", mode: 0o600 });
		for (const workspace of backup.manifest.workspaces) {
			await step("copy_workspaces");
			const source = join(backup.directory, "workspaces", `${workspace.workspaceId}.sqlite`);
			const before = await assertRegularFile(source);
			const directory = join(root, workspace.workspaceId);
			await mkdir(directory, { mode: 0o700 });
			const target = join(directory, "workspace.sqlite");
			await pipeline(
				createReadStream(source, { highWaterMark: 1024 * 1024 }),
				createWriteStream(target, { flags: "wx", mode: 0o600 }),
			);
			const after = await lstat(source);
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				throw new MaintenanceError("SOURCE_CHANGED");
			const expected = backup.manifest.files.find(
				(file) => file.path === `workspaces/${workspace.workspaceId}.sqlite`,
			);
			const actual = await hashFile(target);
			if (!expected || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
				throw new MaintenanceError("SOURCE_CHANGED");
			const storage = await openNodeSqliteStorageReadOnly(target);
			try {
				for await (const conversation of archiveConversations(storage, workspace.workspaceId)) {
					const { durableId, ...value } = conversation;
					db.prepare("INSERT INTO archive_conversations VALUES (?,?,?,?)").run(
						workspace.workspaceId,
						conversation.conversationId,
						durableId,
						JSON.stringify(value),
					);
				}
			} finally {
				await closeRecoveryStorage(storage);
			}
			await syncPath(target);
			await syncPath(directory);
		}
		await step("verify_target");
		const rechecked = await verifyBackup({ directory: backup.directory });
		if (!backup.manifestBytes.equals(rechecked.manifestBytes)) throw new MaintenanceError("SOURCE_CHANGED");
		await verifyRecovery(root, "preparing");
		await step("sync_payload");
		await syncPath(join(root, "recovery-manifest.json"));
		await syncPath(catalogPath);
		await syncPath(root);
		await step("commit_ready");
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = db
				.prepare(
					"UPDATE recovery_state SET state='ready' WHERE state='preparing' AND restore_id=? AND manifest_digest=?",
				)
				.run(restoreId, digest(bytes));
			if (result.changes !== 1) throw new MaintenanceError("INTEGRITY_FAILED");
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		db.close();
		db = undefined;
		await syncPath(catalogPath);
		await syncPath(root);
		await syncPath(dirname(root));
		await verifyRecovery(root);
		await step("complete");
		return { directory: root, storeId, restoreId, backupId: backup.manifest.backupId, mode: "recovery_archive" };
	} catch (error) {
		if (owner) retainOwner = retainOwnerOnCloseFailure(error, owner);
		throw maintenanceError(error, restoreId, phase);
	} finally {
		closeRestore(db, retainOwner ? undefined : owner);
	}
}
