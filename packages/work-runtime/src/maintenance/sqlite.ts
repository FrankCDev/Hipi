import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import {
	openNodeSqliteStorageReadOnly,
	type ReadonlySqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
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
function assertCatalogSchema(db: DatabaseSync): void {
	if (expectedCatalogSchema === undefined) {
		const reference = new DatabaseSync(":memory:");
		try {
			reference.exec(
				"CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, store_id TEXT NOT NULL, root TEXT NOT NULL); CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1))); CREATE TABLE conversations (workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, ordinal INTEGER NOT NULL, revision INTEGER NOT NULL, archived INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace_id,public_id)); CREATE INDEX conversation_page ON conversations(workspace_id,archived,ordinal,public_id); CREATE TABLE directory_checkpoints (workspace_id TEXT PRIMARY KEY,generation TEXT NOT NULL,seq INTEGER NOT NULL)",
			);
			expectedCatalogSchema = schemaSignature(reference);
		} finally {
			reference.close();
		}
	}
	if (schemaSignature(db) !== expectedCatalogSchema) throw new MaintenanceError("UNSUPPORTED_SCHEMA");
}
export function inspectCatalog(path: string, expectedRoot?: string) {
	const db = openReadOnly(path);
	try {
		assertCatalogSchema(db);
		const allowed = new Set(["identity", "workspaces", "conversations", "directory_checkpoints"]);
		for (const row of db.prepare("SELECT type,name,sql FROM sqlite_schema").iterate()) {
			if (row.type === "table" && typeof row.name === "string" && allowed.delete(row.name)) continue;
			if (
				row.type === "index" &&
				typeof row.name === "string" &&
				(row.name === "conversation_page" || row.name.startsWith("sqlite_autoindex_"))
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
		if (identities.length !== 1 || identity.singleton !== 1 || identity.version !== 3)
			throw new MaintenanceError("UNSUPPORTED_SCHEMA");
		if (
			typeof identity.store_id !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(identity.store_id) ||
			typeof identity.root !== "string" ||
			!identity.root ||
			(expectedRoot !== undefined && identity.root !== expectedRoot)
		)
			throw new MaintenanceError("IDENTITY_MISMATCH");
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
		return { sourceStoreId: identity.store_id, sourceRoot: identity.root, workspaces };
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
