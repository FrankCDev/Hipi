import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ReadonlySqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { StoreOwnerLease } from "../store-owner.ts";
import { isConnectionCloseFailure } from "./contracts.ts";

// Native close failure is not evidence of release. Keep both handles and ownership
// reachable until the maintenance process exits; never retry by replacing an owner.
const failedResources: object[] = [];
class RecoveryCloseError extends Error {
	readonly code = "RECOVERY_CLOSE_FAILED";
	constructor(cause: unknown) {
		super("Recovery resource close failed", { cause });
	}
}
export function retainOwnerOnCloseFailure(error: unknown, owner: StoreOwnerLease): boolean {
	if (isConnectionCloseFailure(error)) {
		failedResources.push(owner);
		return true;
	}
	return false;
}
export function closeRecoveryDatabase(db: DatabaseSync): void {
	try {
		db.close();
	} catch (error) {
		failedResources.push(db);
		throw new RecoveryCloseError(error);
	}
}
export async function closeRecoveryStorage(storage: ReadonlySqliteStorage): Promise<void> {
	try {
		await storage.close(context);
	} catch (error) {
		failedResources.push(storage);
		throw new RecoveryCloseError(error);
	}
}
