import { posix, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import {
	openNodeSqliteStorageReadOnly,
	type ReadonlySqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { AppError, CUSTOM_PROVIDER_LIMITS, parseResult } from "../contracts.ts";
import {
	PRESENTATION_ORDER_SCHEMA,
	PRESENTATION_SCHEMA,
	validatePresentationStore,
} from "../conversation-presentation.ts";
import { NAVIGATION_SCHEMA, validateNavigationStore } from "../navigation/schema.ts";
import { PROJECT_SCHEMA, validateProjectStore } from "../projects/schema.ts";
import { SEARCH_SCHEMA, validateSearchStore } from "../search/schema.ts";
import { SIDEBAR_PIN_SCHEMA, validateSidebarPinStore } from "../sidebar-pins/schema.ts";
import { checkDatabasePath } from "../store-owner.ts";
import { MAINTENANCE_LIMITS, MaintenanceError } from "./contracts.ts";
import { assertRegularFile, validateWorkspaceId } from "./paths.ts";

/** A close failure leaves ownership retained; only process termination proves release. */
export class SourceCloseError extends Error {
	readonly code = "READONLY_CLOSE_FAILED";
}
const retainedConnections = new Set<DatabaseSync | ReadonlySqliteStorage>();
async function closeStorage(storage: ReadonlySqliteStorage): Promise<void> {
	try {
		await storage.close(BACKGROUND_CONTEXT);
	} catch {
		retainedConnections.add(storage);
		throw new SourceCloseError("Source storage close failed");
	}
}
let expectedPiSchema: string | undefined;
let expectedCatalogSchema: string | undefined;
let expectedConfiguredCatalogSchema: string | undefined;
let expectedProjectCatalogSchema: string | undefined;
let expectedPresentationCatalogSchema: string | undefined;
let expectedSearchCatalogSchema: string | undefined;
let expectedOrderedCatalogSchema: string | undefined;
let expectedNavigationCatalogSchema: string | undefined;
let expectedLogicalProjectCatalogSchema: string | undefined;
let expectedSidebarPinCatalogSchema: string | undefined;
function assertSchemaBudget(db: DatabaseSync): void {
	const count = db.prepare("SELECT count(*) AS total FROM sqlite_schema").get()?.total;
	if (
		typeof count !== "number" ||
		count > 64 ||
		db
			.prepare(
				"SELECT 1 FROM sqlite_schema WHERE length(CAST(sql AS BLOB))>65536 OR length(CAST(name AS BLOB))>256 OR length(CAST(tbl_name AS BLOB))>256 OR length(CAST(type AS BLOB))>16 LIMIT 1",
			)
			.get()
	)
		throw new MaintenanceError("CAPACITY_EXCEEDED");
}
function schemaSignature(db: DatabaseSync): string {
	assertSchemaBudget(db);
	return JSON.stringify(
		db
			.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
			.all()
			.map((row) => ({ ...row, sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, "") : row.sql })),
	);
}
function assertPiSchema(db: DatabaseSync): void {
	if (expectedPiSchema === undefined) {
		// Build the expected schema only from shipped migrations in a fresh in-memory database.
		// No statement obtained from the input database is ever executed.
		const reference = new DatabaseSync(":memory:");
		try {
			reference.exec(
				"CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version >= 0)) STRICT",
			);
			for (const migration of SQLITE_MIGRATIONS)
				for (const statement of migration.statements) reference.exec(statement);
			expectedPiSchema = schemaSignature(reference);
		} finally {
			reference.close();
		}
	}
	if (schemaSignature(db) !== expectedPiSchema) throw new MaintenanceError("UNSUPPORTED_SCHEMA");
}
export function closeDatabase(db: DatabaseSync): void {
	try {
		db.close();
	} catch {
		retainedConnections.add(db);
		throw new SourceCloseError("Source connection close failed");
	}
}
export function openReadOnly(path: string): DatabaseSync {
	const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
	try {
		db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=0");
		return db;
	} catch (error) {
		closeDatabase(db);
		throw error;
	}
}
export function assertSqliteIntegrity(path: string, standalone = false): void {
	const db = openReadOnly(path);
	try {
		assertSchemaBudget(db);
		if (standalone && db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete")
			throw new MaintenanceError("INTEGRITY_FAILED");
		for (const row of db.prepare("SELECT type,sql FROM sqlite_schema").iterate()) {
			if (row.type !== "table" && row.type !== "index") throw new MaintenanceError("UNSUPPORTED_SCHEMA");
			if (typeof row.sql === "string" && /CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql))
				throw new MaintenanceError("UNSUPPORTED_SCHEMA");
		}
		const result = db.prepare("PRAGMA integrity_check(1)").get();
		if (!result || Object.values(result)[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").get())
			throw new MaintenanceError("INTEGRITY_FAILED");
	} finally {
		closeDatabase(db);
	}
}
function assertCatalogSchema(db: DatabaseSync): 3 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 {
	if (expectedCatalogSchema === undefined) {
		const reference = new DatabaseSync(":memory:");
		try {
			reference.exec(
				"CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, store_id TEXT NOT NULL, root TEXT NOT NULL); CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1))); CREATE TABLE conversations (workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, ordinal INTEGER NOT NULL, revision INTEGER NOT NULL, archived INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace_id,public_id)); CREATE INDEX conversation_page ON conversations(workspace_id,archived,ordinal,public_id); CREATE TABLE directory_checkpoints (workspace_id TEXT PRIMARY KEY,generation TEXT NOT NULL,seq INTEGER NOT NULL)",
			);
			expectedCatalogSchema = schemaSignature(reference);
			reference.exec(
				"CREATE TABLE custom_providers (provider TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE provider_commands (request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL)",
			);
			expectedConfiguredCatalogSchema = schemaSignature(reference);
			reference.exec(
				"CREATE TABLE project_folders (workspace_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, revision INTEGER NOT NULL, canonical_path TEXT, device TEXT, inode TEXT, display_name TEXT, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)))",
			);
			expectedProjectCatalogSchema = schemaSignature(reference);
			reference.exec(PRESENTATION_SCHEMA);
			expectedPresentationCatalogSchema = schemaSignature(reference);
			reference.exec(SEARCH_SCHEMA);
			expectedSearchCatalogSchema = schemaSignature(reference);
			reference.exec(PRESENTATION_ORDER_SCHEMA);
			expectedOrderedCatalogSchema = schemaSignature(reference);
			reference.exec(NAVIGATION_SCHEMA);
			expectedNavigationCatalogSchema = schemaSignature(reference);
			reference.exec(PROJECT_SCHEMA);
			expectedLogicalProjectCatalogSchema = schemaSignature(reference);
			reference.exec(SIDEBAR_PIN_SCHEMA);
			expectedSidebarPinCatalogSchema = schemaSignature(reference);
		} finally {
			reference.close();
		}
	}
	const signature = schemaSignature(db);
	if (signature === expectedCatalogSchema) return 3;
	if (signature === expectedConfiguredCatalogSchema) return 5;
	if (signature === expectedProjectCatalogSchema) return 6;
	if (signature === expectedPresentationCatalogSchema) return 7;
	if (signature === expectedSearchCatalogSchema) return 8;
	if (signature === expectedOrderedCatalogSchema) return 9;
	if (signature === expectedNavigationCatalogSchema) return 10;
	if (signature === expectedLogicalProjectCatalogSchema) return 11;
	if (signature === expectedSidebarPinCatalogSchema) return 12;
	throw new MaintenanceError("UNSUPPORTED_SCHEMA");
}
function assertProjectFolders(db: DatabaseSync): void {
	const count = db
		.prepare("SELECT count(*) AS total FROM (SELECT 1 FROM project_folders LIMIT ?)")
		.get(MAINTENANCE_LIMITS.workspaces + 1)?.total;
	if (
		typeof count !== "number" ||
		count > MAINTENANCE_LIMITS.workspaces ||
		db
			.prepare(
				"SELECT 1 FROM project_folders WHERE length(CAST(workspace_id AS BLOB))>128 OR length(CAST(binding_id AS BLOB))>128 OR length(CAST(canonical_path AS BLOB))>12288 OR length(CAST(device AS BLOB))>40 OR length(CAST(inode AS BLOB))>40 OR length(CAST(display_name AS BLOB))>1020 LIMIT 1",
			)
			.get()
	)
		throw new MaintenanceError("CAPACITY_EXCEEDED");
	if (
		db
			.prepare(
				"SELECT 1 FROM project_folders WHERE typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991 OR typeof(revoked)!='integer' OR revoked NOT IN (0,1) OR NOT EXISTS (SELECT 1 FROM workspaces WHERE workspaces.workspace_id=project_folders.workspace_id AND ready=1) LIMIT 1",
			)
			.get()
	)
		throw new MaintenanceError("IDENTITY_MISMATCH");
	for (const row of db
		.prepare("SELECT workspace_id,binding_id,canonical_path,device,inode,display_name,revoked FROM project_folders")
		.iterate()) {
		if (
			typeof row.workspace_id !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(row.workspace_id) ||
			typeof row.binding_id !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(row.binding_id) ||
			(row.display_name !== null &&
				(typeof row.display_name !== "string" ||
					!row.display_name ||
					[...row.display_name].length > 255 ||
					/[\p{Cc}\p{Cf}\p{Cs}/\\]/u.test(row.display_name)))
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		// A backup can be verified on another platform. Paths remain inert metadata:
		// never resolve them, inspect their filesystem identity, or grant access here.
		if (row.revoked === 1) {
			if (row.canonical_path !== null || row.device !== null || row.inode !== null)
				throw new MaintenanceError("IDENTITY_MISMATCH");
		} else if (
			typeof row.canonical_path !== "string" ||
			row.canonical_path.length > 4096 ||
			row.canonical_path.includes("\0") ||
			(!posix.isAbsolute(row.canonical_path) && !win32.isAbsolute(row.canonical_path)) ||
			typeof row.device !== "string" ||
			!/^(0|[1-9][0-9]{0,39})$/.test(row.device) ||
			typeof row.inode !== "string" ||
			!/^(0|[1-9][0-9]{0,39})$/.test(row.inode)
		) {
			throw new MaintenanceError("IDENTITY_MISMATCH");
		}
	}
}
export function inspectCatalog(path: string, expectedRoot?: string) {
	const db = openReadOnly(path);
	try {
		const version = assertCatalogSchema(db);
		const allowed = new Set([
			"identity",
			"workspaces",
			"conversations",
			"directory_checkpoints",
			...(version >= 5 ? ["custom_providers", "provider_commands"] : []),
			...(version >= 6 ? ["project_folders"] : []),
			...(version >= 7 ? ["conversation_presentations", "presentation_state", "presentation_commands"] : []),
			...(version >= 8 ? ["search_state", "search_sources", "search_chunks"] : []),
			...(version >= 10 ? ["navigation_state", "navigation_sources", "navigation_publication"] : []),
			...(version >= 12 ? ["sidebar_pin_order", "sidebar_pin_state", "sidebar_pin_commands"] : []),
			...(version >= 11
				? [
						"projects",
						"project_memberships",
						"project_catalog_state",
						"project_presentations",
						"project_presentation_state",
						"project_commands",
					]
				: []),
		]);
		for (const row of db.prepare("SELECT type,name,sql FROM sqlite_schema").iterate()) {
			if (row.type === "table" && typeof row.name === "string" && allowed.delete(row.name)) continue;
			if (
				row.type === "index" &&
				typeof row.name === "string" &&
				(row.name === "conversation_page" ||
					(version >= 7 && row.name === "presentation_pin_order") ||
					(version >= 8 && row.name === "search_chunk_scope") ||
					(version >= 10 && (row.name === "navigation_recent" || row.name === "navigation_workspace")) ||
					(version >= 11 && (row.name === "project_membership_scope" || row.name === "project_pin_order")) ||
					(version >= 12 &&
						["sidebar_pin_ordinal", "sidebar_pin_project", "sidebar_pin_conversation"].includes(row.name)) ||
					row.name.startsWith("sqlite_autoindex_"))
			)
				continue;
			throw new MaintenanceError("UNSUPPORTED_SCHEMA");
		}
		if (allowed.size) throw new MaintenanceError("UNSUPPORTED_SCHEMA");
		// Return only bounded scalars/sentinels before materializing catalog-owned strings.
		// Names use the protocol's 128 UTF-16 units: valid UTF-8 needs at most 3 bytes per unit.
		const workspaceCount = db
			.prepare("SELECT count(*) AS total FROM (SELECT 1 FROM workspaces LIMIT ?)")
			.get(MAINTENANCE_LIMITS.workspaces + 1)?.total;
		if (
			typeof workspaceCount !== "number" ||
			workspaceCount > MAINTENANCE_LIMITS.workspaces ||
			db
				.prepare(
					"SELECT 1 FROM identity WHERE length(CAST(store_id AS BLOB))>128 OR length(CAST(root AS BLOB))>32768 LIMIT 1",
				)
				.get() ||
			db
				.prepare(
					"SELECT 1 FROM workspaces WHERE length(CAST(workspace_id AS BLOB))>128 OR length(CAST(name AS BLOB))>384 LIMIT 1",
				)
				.get()
		)
			throw new MaintenanceError("CAPACITY_EXCEEDED");
		if (
			db.prepare("SELECT 1 FROM identity WHERE typeof(version)!='integer' LIMIT 1").get() ||
			db.prepare("SELECT 1 FROM workspaces WHERE typeof(ready)!='integer' LIMIT 1").get()
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		const identities = db.prepare("SELECT singleton,version,store_id,root FROM identity LIMIT 2").all();
		const identity = identities[0];
		if (identities.length !== 1 || identity.singleton !== 1 || identity.version !== version)
			throw new MaintenanceError("UNSUPPORTED_SCHEMA");
		if (
			typeof identity.store_id !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(identity.store_id) ||
			typeof identity.root !== "string" ||
			!identity.root ||
			(expectedRoot !== undefined && identity.root !== expectedRoot)
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		if (version >= 6) assertProjectFolders(db);
		if (version >= 7) {
			try {
				validatePresentationStore(db, version >= 9);
				if (version >= 8) validateSearchStore(db);
				if (version >= 10) validateNavigationStore(db);
				if (version >= 11) validateProjectStore(db);
				if (version >= 12) validateSidebarPinStore(db);
			} catch (error) {
				throw new MaintenanceError(
					error instanceof AppError && error.code === "CAPACITY_EXCEEDED"
						? "CAPACITY_EXCEEDED"
						: "IDENTITY_MISMATCH",
				);
			}
		}
		if (version >= 5) {
			const providerCount = db
				.prepare("SELECT count(*) AS total FROM (SELECT 1 FROM custom_providers LIMIT ?)")
				.get(CUSTOM_PROVIDER_LIMITS.providers + 1)?.total;
			if (
				typeof providerCount !== "number" ||
				providerCount > CUSTOM_PROVIDER_LIMITS.providers ||
				db
					.prepare(
						"SELECT 1 FROM custom_providers WHERE length(CAST(provider AS BLOB))>71 OR length(CAST(value AS BLOB))>? LIMIT 1",
					)
					.get(CUSTOM_PROVIDER_LIMITS.configurationBytes) ||
				db
					.prepare(
						"SELECT 1 FROM provider_commands WHERE length(CAST(request_id AS BLOB))>128 OR length(CAST(digest AS BLOB))!=64 OR length(CAST(result AS BLOB))>? LIMIT 1",
					)
					.get(CUSTOM_PROVIDER_LIMITS.configurationBytes)
			)
				throw new MaintenanceError("CAPACITY_EXCEEDED");
			try {
				const providers = db.prepare("SELECT provider,value FROM custom_providers").all();
				for (const row of providers) {
					if (typeof row.value !== "string") throw new Error("Invalid configuration");
					const provider = parseResult("saveCustomProvider", JSON.parse(row.value));
					if (provider.provider !== row.provider) throw new Error("Identity mismatch");
				}
				for (const row of db.prepare("SELECT request_id,digest,result FROM provider_commands").iterate()) {
					if (
						typeof row.request_id !== "string" ||
						!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(row.request_id) ||
						typeof row.digest !== "string" ||
						!/^[a-f0-9]{64}$/.test(row.digest) ||
						typeof row.result !== "string"
					)
						throw new Error("Invalid command");
					const result: unknown = JSON.parse(row.result);
					if (result && typeof result === "object" && "removed" in result)
						parseResult("removeCustomProvider", result);
					else parseResult("saveCustomProvider", result);
				}
			} catch {
				throw new MaintenanceError("IDENTITY_MISMATCH");
			}
		}
		const workspaces: { workspaceId: string; name: string; ready: 0 | 1 }[] = [];
		const seen = new Set<string>();
		for (const row of db.prepare("SELECT workspace_id,name,ready FROM workspaces").iterate()) {
			if (
				typeof row.workspace_id !== "string" ||
				typeof row.name !== "string" ||
				row.name.length < 1 ||
				row.name.length > 128 ||
				(row.ready !== 0 && row.ready !== 1)
			)
				throw new MaintenanceError("IDENTITY_MISMATCH");
			validateWorkspaceId(row.workspace_id);
			if (seen.has(row.workspace_id.toLowerCase())) throw new MaintenanceError("IDENTITY_MISMATCH");
			seen.add(row.workspace_id.toLowerCase());
			workspaces.push({ workspaceId: row.workspace_id, name: row.name, ready: row.ready });
			if (workspaces.length > MAINTENANCE_LIMITS.workspaces) throw new MaintenanceError("CAPACITY_EXCEEDED");
		}
		return { sourceStoreId: identity.store_id, sourceRoot: identity.root, catalogSchema: version, workspaces };
	} finally {
		closeDatabase(db);
	}
}
export async function inspectWorkspace(
	path: string,
	workspaceId: string,
): Promise<{ workspaceId: string; name: string; generation: string | null }> {
	validateWorkspaceId(workspaceId);
	await assertRegularFile(path);
	await checkDatabasePath(path);
	assertSqliteIntegrity(path);
	const schema = openReadOnly(path);
	try {
		assertPiSchema(schema);
	} finally {
		closeDatabase(schema);
	}
	const storage = await openNodeSqliteStorageReadOnly(path);
	try {
		const read = async (kind: string) => {
			const found = await storage.findDocument({ kind, scope: { kind: "session" } }, "current", BACKGROUND_CONTEXT);
			if (!found) return undefined;
			const doc = await storage.document(found.id, "current", BACKGROUND_CONTEXT);
			if (doc?.version !== 1) throw new MaintenanceError("UNSUPPORTED_SCHEMA");
			return doc.value;
		};
		const header = await read("hipi.workspace-directory");
		const value = header?.initialized === true ? header : await read("hipi.workspace");
		if (
			!value ||
			value.workspaceId !== workspaceId ||
			typeof value.name !== "string" ||
			!value.name ||
			value.name.length > 128
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
		const generation = header?.initialized === true ? header.generation : null;
		if (generation !== null && (typeof generation !== "string" || !generation || generation.length > 128))
			throw new MaintenanceError("IDENTITY_MISMATCH");
		return { workspaceId, name: value.name, generation };
	} finally {
		await closeStorage(storage);
	}
}
