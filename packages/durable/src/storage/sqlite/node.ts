import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import {
	type NodeSqliteDatabaseOptions,
	type NodeSqliteDatabaseReadOnlyOptions,
	openNodeSqliteDatabase,
	openNodeSqliteDatabaseReadOnly,
} from "@earendil-works/chord/sqlite/node";
import {
	type ReadonlySqliteStorage,
	SqliteStorage,
	type SqliteStorageOptions,
	type SqliteStorageReadOnlyOptions,
} from "./storage.ts";

export {
	NodeSqliteDatabase,
	type NodeSqliteDatabaseOptions,
	type NodeSqliteDatabaseReadOnlyOptions,
	openNodeSqliteDatabase,
	openNodeSqliteDatabaseReadOnly,
} from "@earendil-works/chord/sqlite/node";
export { ReadonlyCapacityError, ReadonlyCloseError, type SqliteReadOnlyLimits } from "./readonly.ts";
export type { ReadonlySqliteStorage } from "./storage.ts";

/** Node SQLite connection settings plus durable storage options. */
export type NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & SqliteStorageOptions;
export type NodeSqliteStorageReadOnlyOptions = NodeSqliteDatabaseReadOnlyOptions & SqliteStorageReadOnlyOptions;

/** Open existing current-schema storage without migrations, writes, directory creation, or checkpoints. */
export async function openNodeSqliteStorageReadOnly(
	path: string,
	options: NodeSqliteStorageReadOnlyOptions = {},
): Promise<ReadonlySqliteStorage> {
	const { prefix, limits, ...databaseOptions } = options;
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	return SqliteStorage.openReadOnly(await openNodeSqliteDatabaseReadOnly(path, databaseOptions), { prefix, limits });
}

/** Open or create file-backed durable storage using Node's built-in SQLite, optionally under a table prefix. */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	const { prefix, ...databaseOptions } = options;
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	return SqliteStorage.open(await openNodeSqliteDatabase(path, databaseOptions), { prefix });
}
