import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type BackupManifest,
	type BackupWorkspace,
	MAINTENANCE_LIMITS,
	MaintenanceError,
	maintenanceError,
} from "./contracts.ts";
import { boundedDirectoryNames, canonicalDirectory, hashFile, readBoundedFile, validateWorkspaceId } from "./paths.ts";
import { assertSqliteIntegrity, inspectCatalog, inspectWorkspace } from "./sqlite.ts";

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new MaintenanceError("INCOMPLETE_BACKUP");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
	if (typeof value !== "string" || !value || value.length > max) throw new MaintenanceError("INCOMPLETE_BACKUP");
	return value;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new MaintenanceError("INCOMPLETE_BACKUP");
	return value;
}
export function parseBackupManifest(bytes: Uint8Array): BackupManifest {
	if (bytes.byteLength > MAINTENANCE_LIMITS.manifestBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
	const m = object(JSON.parse(Buffer.from(bytes).toString("utf8")), [
		"formatVersion",
		"backupId",
		"createdAt",
		"sourceStoreId",
		"sourceRoot",
		"catalogSchema",
		"piSchema",
		"producer",
		"files",
		"workspaces",
		"reservations",
		"excludedFiles",
	]);
	if (m.formatVersion !== 1 || (m.catalogSchema !== 3 && m.catalogSchema !== 5) || m.piSchema !== 2)
		throw new MaintenanceError("UNSUPPORTED_SCHEMA");
	const producer = text(m.producer, 128);
	const version =
		/^hipi-work\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			producer,
		);
	if (!version || version[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
		throw new MaintenanceError("INCOMPLETE_BACKUP");
	const backupId = text(m.backupId, 128),
		sourceStoreId = text(m.sourceStoreId, 128),
		createdAt = text(m.createdAt, 64),
		sourceRoot = text(m.sourceRoot, 32768);
	if (
		!/^[a-f0-9-]{36}$/.test(backupId) ||
		!/^[A-Za-z0-9_-]+$/.test(sourceStoreId) ||
		new Date(createdAt).toISOString() !== createdAt
	)
		throw new MaintenanceError("INCOMPLETE_BACKUP");
	if (
		!Array.isArray(m.workspaces) ||
		!Array.isArray(m.files) ||
		!Array.isArray(m.reservations) ||
		m.workspaces.length + m.reservations.length > MAINTENANCE_LIMITS.workspaces ||
		m.files.length !== m.workspaces.length + 2
	)
		throw new MaintenanceError("INCOMPLETE_BACKUP");
	const ids = new Set<string>();
	const identity = (raw: unknown, keys: string[]) => {
		const item = object(raw, keys);
		const workspaceId = text(item.workspaceId, 128);
		validateWorkspaceId(workspaceId);
		if (ids.has(workspaceId.toLowerCase())) throw new MaintenanceError("INCOMPLETE_BACKUP");
		ids.add(workspaceId.toLowerCase());
		return { item, workspaceId, name: text(item.name) };
	};
	const workspaces = m.workspaces.map((raw): BackupWorkspace => {
		const { item, workspaceId, name } = identity(raw, ["workspaceId", "name", "registration", "generation"]);
		const registration = item.registration;
		if (registration !== "ready" && registration !== "reserved" && registration !== "unregistered")
			throw new MaintenanceError("INCOMPLETE_BACKUP");
		return {
			workspaceId,
			name,
			registration,
			generation: item.generation === null ? null : text(item.generation, 128),
		};
	});
	const reservations = m.reservations.map((raw) => {
		const { workspaceId, name } = identity(raw, ["workspaceId", "name"]);
		return { workspaceId, name };
	});
	const expected = new Set([
		"catalog.sqlite",
		"operation.json",
		...workspaces.map((w) => `workspaces/${w.workspaceId}.sqlite`),
	]);
	let total = 0;
	const files = m.files.map((raw) => {
		const f = object(raw, ["path", "bytes", "sha256"]);
		const path = text(f.path, 256),
			bytes = integer(f.bytes),
			sha256 = text(f.sha256, 64);
		if (!expected.delete(path) || !/^[0-9a-f]{64}$/.test(sha256)) throw new MaintenanceError("INCOMPLETE_BACKUP");
		if (path === "operation.json" && bytes > 1024) throw new MaintenanceError("CAPACITY_EXCEEDED");
		total += bytes;
		if (total > MAINTENANCE_LIMITS.totalBytes) throw new MaintenanceError("CAPACITY_EXCEEDED");
		return { path, bytes, sha256 };
	});
	return {
		formatVersion: 1,
		backupId,
		createdAt,
		sourceStoreId,
		sourceRoot,
		catalogSchema: m.catalogSchema,
		piSchema: 2,
		producer,
		files,
		workspaces,
		reservations,
		excludedFiles: integer(m.excludedFiles),
	};
}
export async function verifyBackup({ directory }: { directory: string }) {
	const operationId = randomUUID();
	try {
		const root = await canonicalDirectory(directory);
		const manifestPath = join(root, "manifest.json");
		const manifestBytes = await readBoundedFile(manifestPath, MAINTENANCE_LIMITS.manifestBytes).catch((error) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				throw new MaintenanceError("INCOMPLETE_BACKUP");
			throw error;
		});
		const manifest = parseBackupManifest(manifestBytes);
		const rootNames = await boundedDirectoryNames(root, 4);
		if (
			rootNames.length !== 4 ||
			!["manifest.json", "catalog.sqlite", "operation.json", "workspaces"].every((n) => rootNames.includes(n))
		)
			throw new MaintenanceError("INCOMPLETE_BACKUP");
		await canonicalDirectory(join(root, "workspaces"));
		const children = await boundedDirectoryNames(join(root, "workspaces"), manifest.workspaces.length);
		if (
			children.length !== manifest.workspaces.length ||
			children.some((n) => !manifest.workspaces.some((w) => n === `${w.workspaceId}.sqlite`))
		)
			throw new MaintenanceError("INCOMPLETE_BACKUP");
		for (const file of manifest.files) {
			const actual = await hashFile(join(root, file.path));
			if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
				throw new MaintenanceError("INTEGRITY_FAILED");
		}
		const op = object(JSON.parse((await readBoundedFile(join(root, "operation.json"), 1024)).toString("utf8")), [
			"formatVersion",
			"backupId",
			"createdAt",
		]);
		if (op.formatVersion !== 1 || op.backupId !== manifest.backupId || op.createdAt !== manifest.createdAt)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		assertSqliteIntegrity(join(root, "catalog.sqlite"), true);
		const catalog = inspectCatalog(join(root, "catalog.sqlite"), manifest.sourceRoot);
		if (catalog.sourceStoreId !== manifest.sourceStoreId || catalog.catalogSchema !== manifest.catalogSchema)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		for (const workspace of manifest.workspaces) {
			assertSqliteIntegrity(join(root, `workspaces/${workspace.workspaceId}.sqlite`), true);
			const identity = await inspectWorkspace(
				join(root, `workspaces/${workspace.workspaceId}.sqlite`),
				workspace.workspaceId,
			);
			if (identity.name !== workspace.name || identity.generation !== workspace.generation)
				throw new MaintenanceError("IDENTITY_MISMATCH");
			const row = catalog.workspaces.find((w) => w.workspaceId === workspace.workspaceId);
			if (
				workspace.registration === "unregistered"
					? row !== undefined
					: !row || row.name !== workspace.name || row.ready !== (workspace.registration === "ready" ? 1 : 0)
			)
				throw new MaintenanceError("IDENTITY_MISMATCH");
		}
		for (const reservation of manifest.reservations) {
			const row = catalog.workspaces.find((w) => w.workspaceId === reservation.workspaceId);
			if (!row || row.ready !== 0 || row.name !== reservation.name) throw new MaintenanceError("IDENTITY_MISMATCH");
		}
		if (
			catalog.workspaces.length !==
			manifest.reservations.length + manifest.workspaces.filter((w) => w.registration !== "unregistered").length
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		return {
			directory: root,
			manifest,
			manifestBytes,
			manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
		};
	} catch (error) {
		throw maintenanceError(error, operationId, "verify");
	}
}
