import type { DatabaseSync } from "node:sqlite";
import { SEARCH_LIMITS } from "./contracts.ts";

/** Pure schema/validation module: maintenance must not import runtime readers or scheduling. */
export const SEARCH_SCHEMA =
	"CREATE TABLE IF NOT EXISTS search_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL, cycle TEXT NOT NULL, revision INTEGER NOT NULL, workspace_after TEXT NOT NULL, workspace_id TEXT, conversation_after TEXT NOT NULL, current_id TEXT, completed_at INTEGER, active INTEGER NOT NULL CHECK(active IN (0,1))); CREATE TABLE IF NOT EXISTS search_sources (workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, generation TEXT NOT NULL, cycle TEXT NOT NULL, durable_id INTEGER NOT NULL, title TEXT NOT NULL, workspace_name TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)), revision INTEGER NOT NULL, indexed_entry INTEGER NOT NULL, pending_entry INTEGER NOT NULL, pending_slot INTEGER NOT NULL, pending_offset INTEGER NOT NULL, upper_entry INTEGER NOT NULL, PRIMARY KEY(workspace_id,public_id)); CREATE TABLE IF NOT EXISTS search_chunks (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, message_id TEXT NOT NULL, offset INTEGER NOT NULL, text_length INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE(workspace_id,public_id,message_id,offset)); CREATE INDEX IF NOT EXISTS search_chunk_scope ON search_chunks(workspace_id,public_id)";

export function validateSearchStore(database: DatabaseSync): void {
	if (
		database
			.prepare(
				"SELECT 1 FROM search_state WHERE completed_at IS NOT NULL AND (typeof(completed_at)!='integer' OR completed_at<0 OR completed_at>9007199254740991) LIMIT 1",
			)
			.get()
	)
		throw new Error("Invalid search completion time");
	const tables = [
		{
			table: "search_state",
			integers: ["singleton", "revision", "active"],
			strings: [
				["generation", 36],
				["cycle", 36],
				["workspace_after", 128],
				["workspace_id", 128],
				["conversation_after", 128],
				["current_id", 128],
			],
		},
		{
			table: "search_sources",
			integers: [
				"durable_id",
				"revision",
				"archived",
				"indexed_entry",
				"pending_entry",
				"pending_slot",
				"pending_offset",
				"upper_entry",
			],
			strings: [
				["workspace_id", 128],
				["public_id", 128],
				["generation", 256],
				["cycle", 36],
				["title", 128],
				["workspace_name", 128],
			],
		},
		{
			table: "search_chunks",
			integers: ["id", "offset", "text_length"],
			strings: [
				["workspace_id", 128],
				["public_id", 128],
				["message_id", 256],
				["text", SEARCH_LIMITS.chunk],
			],
		},
	] as const;
	// Only scalar sentinels are materialized before the encoded-byte checks.
	for (const spec of tables) {
		for (const column of spec.integers) {
			if (
				database
					.prepare(
						`SELECT 1 FROM ${spec.table} WHERE typeof(${column})!='integer' OR ${column}<0 OR ${column}>9007199254740991 LIMIT 1`,
					)
					.get()
			)
				throw new Error("Invalid search integer");
		}
		for (const [column, maximum] of spec.strings) {
			const nullable = spec.table === "search_state" && (column === "workspace_id" || column === "current_id");
			if (
				database
					.prepare(
						`SELECT 1 FROM ${spec.table} WHERE ${nullable ? `${column} IS NOT NULL AND ` : ""}(typeof(${column})!='text' OR length(CAST(${column} AS BLOB))>?) LIMIT 1`,
					)
					.get(maximum * 4)
			)
				throw new Error("Invalid search text");
		}
		for (const row of database.prepare(`SELECT * FROM ${spec.table}`).iterate()) {
			for (const [column, maximum] of spec.strings) {
				const value = row[column];
				if (value !== null && (typeof value !== "string" || value.length > maximum))
					throw new Error("Invalid search text length");
			}
			if (spec.table === "search_chunks") {
				const offset = Number(row.offset),
					length = Number(row.text_length),
					text = row.text;
				if (
					typeof text !== "string" ||
					offset + text.length > length ||
					!Number.isSafeInteger(offset + text.length)
				)
					throw new Error("Invalid search chunk");
				if (
					typeof row.message_id !== "string" ||
					(row.message_id !== "" && !/^[1-9]\d*_(0|[1-9]\d*)$/.test(row.message_id))
				)
					throw new Error("Invalid search message identity");
			}
			for (const column of ["workspace_id", "public_id"] as const) {
				if (
					column in row &&
					row[column] !== null &&
					(typeof row[column] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row[column]))
				)
					throw new Error("Invalid search scope");
			}
		}
	}
	if (
		database.prepare("SELECT count(*) AS total FROM (SELECT 1 FROM search_state LIMIT 2)").get()?.total !== 1 ||
		database
			.prepare(
				"SELECT 1 FROM search_state WHERE singleton!=1 OR length(generation)!=36 OR length(cycle)!=36 OR active NOT IN (0,1) OR (completed_at IS NOT NULL AND (typeof(completed_at)!='integer' OR completed_at<0 OR completed_at>9007199254740991)) LIMIT 1",
			)
			.get() ||
		database
			.prepare(
				"SELECT 1 FROM search_sources WHERE durable_id<1 OR revision<1 OR upper_entry<indexed_entry OR archived NOT IN (0,1) OR (pending_entry=0 AND (pending_slot!=0 OR pending_offset!=0)) OR pending_entry>upper_entry OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.workspace_id=search_sources.workspace_id AND w.ready=1) LIMIT 1",
			)
			.get() ||
		database
			.prepare(
				"SELECT 1 FROM search_chunks WHERE id<1 OR NOT EXISTS (SELECT 1 FROM search_sources s WHERE s.workspace_id=search_chunks.workspace_id AND s.public_id=search_chunks.public_id) LIMIT 1",
			)
			.get()
	)
		throw new Error("Invalid search projection relationships");
}
