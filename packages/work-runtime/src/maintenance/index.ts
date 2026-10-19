/** Trusted Node-only maintenance surface; never expose arbitrary host paths through the renderer AppClient. */
export { type ArchiveInfo, type ArchiveScope, openRecoveryArchive, type RecoveryArchive } from "./archive.ts";
export { backupStore } from "./backup.ts";
export { type BackupManifest, MAINTENANCE_LIMITS, MaintenanceError } from "./contracts.ts";
export { type RestoreOptions, type RestoreResult, restoreStore } from "./restore.ts";
export { verifyBackup } from "./verify.ts";
