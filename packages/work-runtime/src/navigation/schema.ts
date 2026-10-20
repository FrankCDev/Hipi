import type { DatabaseSync } from "node:sqlite";
import { ACTIVITY_BASES } from "./contracts.ts";

const SOURCE_SCHEMA =
	"CREATE TABLE navigation_sources (workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, source_generation TEXT NOT NULL, cycle TEXT NOT NULL, ordinal INTEGER NOT NULL, conversation TEXT NOT NULL, recency_at INTEGER, basis TEXT NOT NULL, recency_key INTEGER GENERATED ALWAYS AS (-coalesce(recency_at,-1)) VIRTUAL, PRIMARY KEY(cycle,workspace_id,public_id))";
const RECENT_INDEX =
	"CREATE INDEX navigation_recent ON navigation_sources(cycle,recency_key,workspace_id,ordinal,public_id)";
const WORKSPACE_INDEX =
	"CREATE INDEX navigation_workspace ON navigation_sources(cycle,workspace_id,recency_key,ordinal,public_id)";

/** Derived navigation data only. Maintenance must not import readers, PI definitions or scheduling. */
export const NAVIGATION_SCHEMA =
	"CREATE TABLE IF NOT EXISTS navigation_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL, revision INTEGER NOT NULL, inventory_generation INTEGER NOT NULL, cycle TEXT NOT NULL, workspace_after TEXT NOT NULL, workspace_id TEXT, conversation_after TEXT NOT NULL, current_id TEXT, position TEXT, completed_at INTEGER, active INTEGER NOT NULL CHECK(active IN (0,1))); " +
	SOURCE_SCHEMA.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS") +
	"; CREATE TABLE IF NOT EXISTS navigation_publication (singleton INTEGER PRIMARY KEY CHECK(singleton=1), cycle TEXT, generation TEXT); INSERT OR IGNORE INTO navigation_publication VALUES (1,NULL,NULL); " +
	RECENT_INDEX.replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS") +
	"; " +
	WORKSPACE_INDEX.replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS");

function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function object(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid navigation object");
	return raw as Record<string, unknown>;
}
function scope(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function sourceIdentity(raw: string): void {
	const source: unknown = JSON.parse(raw);
	if (
		!Array.isArray(source) ||
		source.length !== 2 ||
		typeof source[0] !== "string" ||
		!source[0] ||
		source[0].length > 256 ||
		!integer(source[1]) ||
		source[1] < 1
	)
		throw new Error("Invalid navigation source identity");
}
export function validateNavigationStore(database: DatabaseSync): void {
	// Check definitions, not just names: old unpublished schema10 stores and
	// same-name replacement indexes cannot satisfy the indexed keyset contract.
	for (const [type, name, expected] of [
		["table", "navigation_sources", SOURCE_SCHEMA],
		["index", "navigation_recent", RECENT_INDEX],
		["index", "navigation_workspace", WORKSPACE_INDEX],
	]) {
		const row = database
			.prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=? AND length(CAST(sql AS BLOB))<=4096")
			.get(type, name);
		if (typeof row?.sql !== "string" || row.sql.replace(/\s+/g, "") !== expected.replace(/\s+/g, ""))
			throw new Error("Invalid navigation schema");
	}
	if (
		database
			.prepare(
				"SELECT 1 FROM navigation_publication WHERE (cycle IS NOT NULL AND (typeof(cycle)!='text' OR length(CAST(cycle AS BLOB))>36)) OR (generation IS NOT NULL AND (typeof(generation)!='text' OR length(CAST(generation AS BLOB))>36)) LIMIT 1",
			)
			.get()
	)
		throw new Error("Invalid navigation publication");
	const publications = database.prepare("SELECT * FROM navigation_publication LIMIT 2").all();
	const publication = publications[0];
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
	if (
		publications.length !== 1 ||
		publication.singleton !== 1 ||
		(publication.cycle === null) !== (publication.generation === null) ||
		(publication.cycle !== null && (typeof publication.cycle !== "string" || !uuid.test(publication.cycle))) ||
		(publication.generation !== null &&
			(typeof publication.generation !== "string" || !uuid.test(publication.generation)))
	)
		throw new Error("Invalid navigation publication");
	const specifications = [
		{
			table: "navigation_state",
			integers: ["singleton", "revision", "inventory_generation", "active"],
			strings: [
				["generation", 36],
				["cycle", 36],
				["workspace_after", 128],
				["workspace_id", 128],
				["conversation_after", 128],
				["current_id", 128],
				["position", 4096],
			],
			nullable: ["workspace_id", "current_id", "position"],
			time: "completed_at",
		},
		{
			table: "navigation_sources",
			integers: ["ordinal"],
			strings: [
				["workspace_id", 128],
				["public_id", 128],
				["source_generation", 1024],
				["cycle", 36],
				["conversation", 4096],
				["basis", 32],
			],
			nullable: [],
			time: "recency_at",
		},
	] as const;
	for (const spec of specifications) {
		for (const name of spec.integers) {
			if (
				database
					.prepare(
						`SELECT 1 FROM ${spec.table} WHERE typeof(${name})!='integer' OR ${name}<0 OR ${name}>9007199254740991 LIMIT 1`,
					)
					.get()
			)
				throw new Error("Invalid navigation integer");
		}
		if (
			database
				.prepare(
					`SELECT 1 FROM ${spec.table} WHERE ${spec.time} IS NOT NULL AND (typeof(${spec.time})!='integer' OR ${spec.time}<0 OR ${spec.time}>9007199254740991) LIMIT 1`,
				)
				.get()
		)
			throw new Error("Invalid navigation time");
		for (const [name, maximum] of spec.strings) {
			const nullable = (spec.nullable as readonly string[]).includes(name);
			if (
				database
					.prepare(
						`SELECT 1 FROM ${spec.table} WHERE ${nullable ? `${name} IS NOT NULL AND ` : ""}(typeof(${name})!='text' OR length(CAST(${name} AS BLOB))>?) LIMIT 1`,
					)
					.get(maximum * 4)
			)
				throw new Error("Invalid navigation text");
		}
		for (const row of database.prepare(`SELECT * FROM ${spec.table}`).iterate()) {
			for (const [name, maximum] of spec.strings) {
				if (row[name] !== null && (typeof row[name] !== "string" || row[name].length > maximum))
					throw new Error("Invalid navigation text length");
			}
			if (spec.table === "navigation_state") {
				for (const name of ["workspace_after", "conversation_after"] as const)
					if (row[name] !== "" && !scope(row[name])) throw new Error("Invalid navigation continuation");
				for (const name of ["workspace_id", "current_id"] as const)
					if (row[name] !== null && !scope(row[name])) throw new Error("Invalid navigation continuation");
				if (row.position !== null) {
					const p = object(JSON.parse(String(row.position)));
					const expected = ["basis", "entry", "execution", "phase", "recencyAt", "slot", "source", "upper"];
					if (Object.hasOwn(p, "cursor")) expected.push("cursor");
					if (
						Object.keys(p).sort().join() !== expected.sort().join() ||
						(p.phase !== "tasks" && p.phase !== "messages") ||
						typeof p.source !== "string" ||
						p.source.length > 1024 ||
						typeof p.execution !== "boolean" ||
						!integer(p.entry) ||
						!integer(p.slot) ||
						!integer(p.upper) ||
						(p.recencyAt !== null && !integer(p.recencyAt)) ||
						!ACTIVITY_BASES.some((basis) => basis === p.basis) ||
						(p.recencyAt === null) !== (p.basis === "unknown") ||
						(Object.hasOwn(p, "cursor") &&
							(!p.cursor || typeof p.cursor !== "object" || Array.isArray(p.cursor) || p.phase !== "tasks"))
					)
						throw new Error("Invalid navigation activity continuation");
					sourceIdentity(p.source);
				}
			} else {
				if (!scope(row.workspace_id) || !scope(row.public_id) || !row.source_generation)
					throw new Error("Invalid navigation source");
				if (
					!ACTIVITY_BASES.some((basis) => basis === row.basis) ||
					(row.recency_at === null) !== (row.basis === "unknown")
				)
					throw new Error("Invalid navigation activity");
				sourceIdentity(String(row.source_generation));
				const conversation = object(JSON.parse(String(row.conversation)));
				if (
					Object.keys(conversation).sort().join() !==
						"archivedAt,conversationId,createdAt,revision,title,workspaceId" ||
					conversation.workspaceId !== row.workspace_id ||
					conversation.conversationId !== row.public_id ||
					typeof conversation.title !== "string" ||
					conversation.title.length < 1 ||
					conversation.title.length > 128 ||
					!integer(conversation.revision) ||
					conversation.revision < 1 ||
					(conversation.createdAt !== null && !integer(conversation.createdAt)) ||
					(conversation.archivedAt !== null && !integer(conversation.archivedAt))
				)
					throw new Error("Invalid navigation conversation");
			}
		}
	}
	if (
		database.prepare("SELECT count(*) AS total FROM (SELECT 1 FROM navigation_state LIMIT 2)").get()?.total !== 1 ||
		database
			.prepare(
				"SELECT 1 FROM navigation_state WHERE singleton!=1 OR length(generation)!=36 OR length(cycle)!=36 OR active NOT IN (0,1) OR (active=0 AND completed_at IS NULL) OR (current_id IS NOT NULL AND workspace_id IS NULL) OR (position IS NOT NULL AND current_id IS NULL) LIMIT 1",
			)
			.get() ||
		database
			.prepare(
				"SELECT 1 FROM navigation_sources WHERE length(cycle)!=36 OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.workspace_id=navigation_sources.workspace_id AND w.ready=1) LIMIT 1",
			)
			.get()
	)
		throw new Error("Invalid navigation relationships");
}
