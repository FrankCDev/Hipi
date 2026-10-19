export const MAINTENANCE_LIMITS = {
	manifestBytes: 8 * 1024 * 1024,
	workspaces: 10_000,
	totalBytes: 64 * 1024 ** 3,
} as const;
export type MaintenanceCode =
	| "BUSY"
	| "INVALID_PATH"
	| "TARGET_EXISTS"
	| "UNSUPPORTED_SCHEMA"
	| "INCOMPLETE_BACKUP"
	| "INTEGRITY_FAILED"
	| "IDENTITY_MISMATCH"
	| "SOURCE_CHANGED"
	| "CAPACITY_EXCEEDED"
	| "NO_SPACE"
	| "PERMISSION_DENIED"
	| "CANCELLED"
	| "DURABILITY_UNVERIFIED"
	| "RECOVERY_ARCHIVE_READ_ONLY";
export class MaintenanceError extends Error {
	readonly code: MaintenanceCode;
	readonly operationId: string;
	readonly phase: string;
	constructor(code: MaintenanceCode, operationId = "", phase = "validate", cause?: unknown) {
		super(`Store maintenance failed: ${code}`, { cause });
		this.name = "MaintenanceError";
		this.code = code;
		this.operationId = operationId;
		this.phase = phase;
	}
}
export type BackupFile = { path: string; bytes: number; sha256: string };
export type BackupWorkspace = {
	workspaceId: string;
	name: string;
	registration: "ready" | "reserved" | "unregistered";
	generation: string | null;
};
export type BackupReservation = { workspaceId: string; name: string };
export type BackupManifest = {
	formatVersion: 1;
	backupId: string;
	createdAt: string;
	sourceStoreId: string;
	sourceRoot: string;
	catalogSchema: 3;
	piSchema: 2;
	producer: string;
	files: BackupFile[];
	workspaces: BackupWorkspace[];
	reservations: BackupReservation[];
	excludedFiles: number;
};
export function maintenanceError(error: unknown, operationId: string, phase: string): MaintenanceError {
	if (error instanceof MaintenanceError) return new MaintenanceError(error.code, operationId, phase, error);
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	return new MaintenanceError(
		code === "READONLY_CAPACITY_EXCEEDED"
			? "CAPACITY_EXCEEDED"
			: code === "WORKSPACE_BUSY"
				? "BUSY"
				: code === "ENOSPC"
					? "NO_SPACE"
					: code === "EACCES" || code === "EPERM"
						? "PERMISSION_DENIED"
						: code === "EEXIST"
							? "TARGET_EXISTS"
							: "INTEGRITY_FAILED",
		operationId,
		phase,
		error,
	);
}

export function isConnectionCloseFailure(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		if ("code" in current && (current.code === "READONLY_CLOSE_FAILED" || current.code === "RECOVERY_CLOSE_FAILED"))
			return true;
		current = current.cause;
	}
	return false;
}
