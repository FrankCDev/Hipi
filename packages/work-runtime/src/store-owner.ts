import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./contracts.ts";

/** Local cooperative ownership only; never replace or unlink an owner file. */
export async function checkDatabasePath(path: string): Promise<void> {
	for (const suffix of ["", "-wal", "-shm", "-journal"]) {
		try {
			const info = await lstat(`${path}${suffix}`);
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new AppError("INVALID_REQUEST");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
	}
}

const retainedLeases = new Set<StoreOwnerLease>();

export class StoreOwnerLease {
	readonly #database: DatabaseSync;
	#closed = false;
	private constructor(database: DatabaseSync) {
		this.#database = database;
	}
	static acquire(root: string): Promise<StoreOwnerLease> {
		return StoreOwnerLease.acquirePath(join(root, "store-owner.sqlite"));
	}
	static async acquirePath(path: string): Promise<StoreOwnerLease> {
		await checkDatabasePath(path);
		const database = new DatabaseSync(path);
		try {
			database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
		} catch {
			database.close();
			throw new AppError("WORKSPACE_BUSY");
		}
		return new StoreOwnerLease(database);
	}
	retainUntilExit(): void {
		retainedLeases.add(this);
	}
	close(): void {
		if (this.#closed) return;
		try {
			this.#database.close();
		} catch (error) {
			this.retainUntilExit();
			throw error;
		}
		this.#closed = true;
	}
}
