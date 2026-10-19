import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import { StorageRequestError } from "../../errors.ts";
import type { SqliteSchema } from "./schema.ts";

const failedReadOnlyDatabases = new Set<SqliteDatabase>();

/** Owners must keep their archive lease on this failure: connection release was not established. */
export class ReadonlyCloseError extends Error {
	readonly code = "READONLY_CLOSE_FAILED";

	constructor(cause: unknown) {
		super("Read-only SQLite storage could not be closed", { cause });
		this.name = "ReadonlyCloseError";
	}
}

export async function closeReadOnlyDatabase(database: SqliteDatabase): Promise<void> {
	try {
		await database.close();
	} catch (error) {
		failedReadOnlyDatabases.add(database);
		throw new ReadonlyCloseError(error);
	}
}

/** A supported archive exceeds this reader's resource envelope; it is not evidence of corruption. */
export class ReadonlyCapacityError extends StorageRequestError {
	readonly code = "READONLY_CAPACITY_EXCEEDED";

	constructor(message: string) {
		super(message);
		this.name = "ReadonlyCapacityError";
	}
}

/** Limits may only be lowered. Oversized archives are rejected, never truncated. */
export type SqliteReadOnlyLimits = {
	/** Maximum encoded bytes of any record or revision JSON; default 1 MiB. */
	readonly maxJsonBytes?: number;
	/** Maximum sum of encoded revision bytes per document, including historical bases; default 8 MiB. */
	readonly maxDocumentBytes?: number;
	/** Maximum revisions per document, including historical bases; default 4,096. */
	readonly maxDocumentRevisions?: number;
};

const DEFAULT_LIMITS = {
	maxJsonBytes: 1024 * 1024,
	maxDocumentBytes: 8 * 1024 * 1024,
	maxDocumentRevisions: 4096,
} as const;

/**
 * O(database size) startup preflight for a caller-owned, quiescent archive. SQL returns only scalar sentinels,
 * not the offending TEXT. This is a resource budget, not a sandbox for hostile SQLite files. The caller must
 * prevent other writers for the entire reader lifetime; a read-only connection alone cannot freeze writers.
 *
 * The existing delta applier introduces only literal payloads (replace/set/splice/append). Reorder validates a
 * bijection; delete/truncate shrink. Therefore the sum of encoded bases and deltas bounds retained payload and
 * every intermediate reconstruction linearly: there is no copy/repeat opcode that multiplies prior content.
 * Checking all revisions, rather than only the latest base, also protects reads at historical sequence points.
 */
export async function validateReadOnlyBudgets(
	executor: SqliteExecutor,
	schema: SqliteSchema,
	limits: SqliteReadOnlyLimits = {},
): Promise<void> {
	const maximums = { ...DEFAULT_LIMITS, ...limits };
	for (const name of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) {
		const value = maximums[name];
		if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name]) {
			throw new StorageRequestError("Invalid read-only SQLite resource limit");
		}
	}
	const { tables } = schema;
	const columns = [
		[tables.conversations, "record"],
		[tables.entries, "record"],
		[tables.tasks, "record"],
		[tables.submissions, "record"],
		[tables.documents, "record"],
		[tables.documentRevisions, "content"],
	] as const;
	for (const [table, column] of columns) {
		const oversized = await executor.get(
			`SELECT 1 FROM ${table} WHERE length(CAST(${column} AS BLOB)) > ? LIMIT 1`,
			maximums.maxJsonBytes,
		);
		if (oversized !== undefined) throw new ReadonlyCapacityError("Read-only SQLite JSON byte budget exceeded");
	}
	const oversizedDocument = await executor.get(
		`SELECT 1 FROM ${tables.documentRevisions} GROUP BY document_id
		 HAVING count(*) > ? OR sum(length(CAST(content AS BLOB))) > ? LIMIT 1`,
		maximums.maxDocumentRevisions,
		maximums.maxDocumentBytes,
	);
	if (oversizedDocument !== undefined) {
		throw new ReadonlyCapacityError("Read-only SQLite document reconstruction budget exceeded");
	}
	const oversizedMetadata = await executor.get(
		`SELECT 1 FROM ${tables.durableMetadata} WHERE length(CAST(next_id AS BLOB)) > 16 LIMIT 1`,
	);
	if (oversizedMetadata !== undefined) throw new StorageRequestError("Invalid durable SQLite metadata");
}
