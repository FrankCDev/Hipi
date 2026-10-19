import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, rename, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { checkDatabasePath, StoreOwnerLease } from "../store-owner.ts";
import {
	type BackupManifest,
	type BackupReservation,
	type BackupWorkspace,
	isConnectionCloseFailure,
	MAINTENANCE_LIMITS,
	MaintenanceError,
	maintenanceError,
} from "./contracts.ts";
import {
	allocateDirectory,
	assertRegularFile,
	canonicalDirectory,
	hashFile,
	syncPath,
	validateWorkspaceId,
} from "./paths.ts";
import { assertSqliteIntegrity, closeDatabase, inspectCatalog, inspectWorkspace, openReadOnly } from "./sqlite.ts";
import { verifyBackup } from "./verify.ts";

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
async function writeNew(path: string, value: string): Promise<void> {
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(value);
		await file.sync();
	} finally {
		await file.close();
	}
}
function releaseOwners(leases: StoreOwnerLease[], operationId: string): void {
	for (const lease of leases.reverse()) {
		try {
			lease.close();
		} catch (error) {
			throw maintenanceError(error, operationId, "release_owner");
		}
	}
}
/** Offline cooperative snapshot. Cancellation waits for the in-flight SQLite backup before releasing ownership. */
export async function backupStore({
	source,
	destination,
	signal,
}: {
	source: string;
	destination: string;
	signal?: AbortSignal;
}) {
	const operationId = randomUUID();
	let phase = "validate";
	let retainOwnership = false;
	const leases: StoreOwnerLease[] = [];
	const cancelled = () => {
		if (signal?.aborted) throw new MaintenanceError("CANCELLED");
	};
	try {
		cancelled();
		const root = await canonicalDirectory(source);
		await assertRegularFile(join(root, "store-owner.sqlite"));
		await checkDatabasePath(join(root, "catalog.sqlite"));
		await assertRegularFile(join(root, "catalog.sqlite"));
		phase = "acquire_owner";
		leases.push(await StoreOwnerLease.acquire(root));
		phase = "inventory";
		assertSqliteIntegrity(join(root, "catalog.sqlite"));
		const catalog = inspectCatalog(join(root, "catalog.sqlite"), root);
		const ids = new Map(catalog.workspaces.map((w) => [w.workspaceId.toLowerCase(), w.workspaceId]));
		const directories = new Set<string>();
		let excludedFiles = 0;
		for await (const entry of await opendir(root)) {
			const path = join(root, entry.name);
			if (entry.isDirectory()) {
				validateWorkspaceId(entry.name);
				await canonicalDirectory(path);
				const prior = ids.get(entry.name.toLowerCase());
				if (prior !== undefined && prior !== entry.name) throw new MaintenanceError("IDENTITY_MISMATCH");
				ids.set(entry.name.toLowerCase(), entry.name);
				directories.add(entry.name);
			} else {
				await assertRegularFile(path);
				if (entry.name !== "catalog.sqlite") excludedFiles++;
				if (excludedFiles > 100_000) throw new MaintenanceError("CAPACITY_EXCEEDED");
			}
			if (ids.size > MAINTENANCE_LIMITS.workspaces) throw new MaintenanceError("CAPACITY_EXCEEDED");
		}
		const workspaces: BackupWorkspace[] = [];
		const reservations: BackupReservation[] = [];
		const sources = [{ path: "catalog.sqlite", source: join(root, "catalog.sqlite") }];
		for (const id of [...ids.values()].sort()) {
			cancelled();
			const registered = catalog.workspaces.find((w) => w.workspaceId === id);
			const directory = join(root, id);
			if (directories.has(id)) {
				for await (const entry of await opendir(directory)) {
					if (entry.isDirectory()) throw new MaintenanceError("INVALID_PATH");
					await assertRegularFile(join(directory, entry.name));
					if (entry.name !== "workspace.sqlite") excludedFiles++;
					if (excludedFiles > 100_000) throw new MaintenanceError("CAPACITY_EXCEEDED");
				}
				const ownerPath = join(directory, "owner.sqlite");
				if (await exists(ownerPath)) {
					const workspaceLease = await StoreOwnerLease.acquirePath(ownerPath);
					try {
						workspaceLease.close();
					} catch (error) {
						retainOwnership = true;
						throw error;
					}
				}
			}
			const databasePath = join(directory, "workspace.sqlite");
			if (!(await exists(databasePath))) {
				if (!registered || registered.ready === 1) throw new MaintenanceError("INTEGRITY_FAILED");
				reservations.push({ workspaceId: id, name: registered.name });
				continue;
			}
			await checkDatabasePath(databasePath);
			const identity = await inspectWorkspace(databasePath, id);
			if (registered && registered.name !== identity.name) throw new MaintenanceError("IDENTITY_MISMATCH");
			workspaces.push({
				...identity,
				registration: registered ? (registered.ready === 1 ? "ready" : "reserved") : "unregistered",
			});
			sources.push({ path: `workspaces/${id}.sqlite`, source: databasePath });
		}
		let estimate = 0,
			largest = 0;
		for (const file of sources) {
			const db = openReadOnly(file.source);
			try {
				const pages = db.prepare("PRAGMA page_count").get()?.page_count,
					size = db.prepare("PRAGMA page_size").get()?.page_size;
				if (typeof pages !== "number" || typeof size !== "number" || !Number.isSafeInteger(pages * size))
					throw new MaintenanceError("CAPACITY_EXCEEDED");
				estimate += pages * size;
				largest = Math.max(largest, pages * size);
			} finally {
				closeDatabase(db);
			}
		}
		if (estimate > MAINTENANCE_LIMITS.totalBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
		phase = "allocate";
		const target = await allocateDirectory(root, destination);
		await mkdir(join(target, "workspaces"), { mode: 0o700 });
		const space = await statfs(target, { bigint: true });
		if (space.bavail * space.bsize < BigInt(Math.ceil(estimate + largest + Math.max(estimate / 10, 64 * 1024 ** 2))))
			throw new MaintenanceError("NO_SPACE");
		const createdAt = new Date().toISOString();
		await writeNew(
			join(target, "operation.json"),
			JSON.stringify({ formatVersion: 1, backupId: operationId, createdAt }),
		);
		const manifest: BackupManifest = {
			formatVersion: 1,
			backupId: operationId,
			createdAt,
			sourceStoreId: catalog.sourceStoreId,
			sourceRoot: root,
			catalogSchema: 3,
			piSchema: 2,
			producer: "hipi-work/0.0.1",
			files: [],
			workspaces,
			reservations,
			excludedFiles,
		};
		let total = 0;
		phase = "snapshot";
		for (const file of sources) {
			cancelled();
			const output = join(target, file.path);
			const db = openReadOnly(file.source);
			try {
				await backup(db, output);
			} finally {
				closeDatabase(db);
			}
			// Only the freshly allocated output is normalized. Never checkpoint or alter a source DB/WAL.
			const result = new DatabaseSync(output, { allowExtension: false });
			try {
				result.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE");
			} finally {
				result.close();
			}
			for (const suffix of ["-wal", "-shm", "-journal"])
				if (await exists(output + suffix)) throw new MaintenanceError("INTEGRITY_FAILED");
			assertSqliteIntegrity(output);
			if (file.path === "catalog.sqlite") {
				const snapshot = inspectCatalog(output, root);
				if (snapshot.sourceStoreId !== catalog.sourceStoreId) throw new MaintenanceError("IDENTITY_MISMATCH");
			} else {
				const expected = workspaces[sources.indexOf(file) - 1];
				const snapshot = await inspectWorkspace(output, expected.workspaceId);
				if (snapshot.name !== expected.name || snapshot.generation !== expected.generation)
					throw new MaintenanceError("IDENTITY_MISMATCH");
			}
			const digest = await hashFile(output);
			total += digest.bytes;
			if (total > MAINTENANCE_LIMITS.totalBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
			manifest.files.push({ path: file.path, ...digest });
			await syncPath(output);
		}
		cancelled();
		manifest.files.push({ path: "operation.json", ...(await hashFile(join(target, "operation.json"))) });
		phase = "publish_manifest";
		const bytes = JSON.stringify(manifest);
		if (Buffer.byteLength(bytes) > MAINTENANCE_LIMITS.manifestBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
		await syncPath(join(target, "workspaces"));
		await syncPath(target);
		await writeNew(join(target, "manifest.pending"), bytes);
		await rename(join(target, "manifest.pending"), join(target, "manifest.json"));
		await syncPath(target);
		await syncPath(dirname(target));
		phase = "verify";
		const verified = await verifyBackup({ directory: target });
		return {
			...verified,
			bytes: total,
			workspaceCount: workspaces.length,
			durability: "verified_and_flushed_platform_unqualified" as const,
		};
	} catch (error) {
		if (isConnectionCloseFailure(error)) retainOwnership = true;
		throw maintenanceError(error, operationId, phase);
	} finally {
		if (retainOwnership) for (const lease of leases) lease.retainUntilExit();
		else releaseOwners(leases, operationId);
	}
}
