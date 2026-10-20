import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../contracts.ts";
import {
	parseSidebarPinParams,
	parseSidebarPinResult,
	type ReorderSidebarPin,
	sidebarPinCommandPayload,
} from "./contracts.ts";

const DEFINITIONS = [
	[
		"table",
		"sidebar_pin_order",
		"CREATE TABLE sidebar_pin_order (kind TEXT NOT NULL CHECK(kind IN ('project','conversation')), project_id TEXT, workspace_id TEXT, conversation_id TEXT, ordinal INTEGER NOT NULL, CHECK((kind='project' AND project_id IS NOT NULL AND workspace_id IS NULL AND conversation_id IS NULL) OR (kind='conversation' AND project_id IS NULL AND workspace_id IS NOT NULL AND conversation_id IS NOT NULL)))",
	],
	[
		"index",
		"sidebar_pin_project",
		"CREATE UNIQUE INDEX sidebar_pin_project ON sidebar_pin_order(project_id) WHERE kind='project'",
	],
	[
		"index",
		"sidebar_pin_conversation",
		"CREATE UNIQUE INDEX sidebar_pin_conversation ON sidebar_pin_order(workspace_id,conversation_id) WHERE kind='conversation'",
	],
	["index", "sidebar_pin_ordinal", "CREATE UNIQUE INDEX sidebar_pin_ordinal ON sidebar_pin_order(ordinal)"],
	[
		"table",
		"sidebar_pin_state",
		"CREATE TABLE sidebar_pin_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), order_revision INTEGER NOT NULL, next_ordinal INTEGER NOT NULL)",
	],
	[
		"table",
		"sidebar_pin_commands",
		"CREATE TABLE sidebar_pin_commands (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, params TEXT NOT NULL, result TEXT NOT NULL)",
	],
] as const;

/** One root-owned ordering authority; individual presentation rows retain pin membership and revisions. */
export const SIDEBAR_PIN_SCHEMA = DEFINITIONS.map(([, , sql]) =>
	sql.replace(/^CREATE (TABLE|UNIQUE INDEX)/, "$& IF NOT EXISTS"),
).join("; ");

/** Runs in the root's schema11→12 transaction. No historical interleaving is inferred. */
export function initializeSidebarPinStore(database: DatabaseSync): void {
	database.exec(SIDEBAR_PIN_SCHEMA);
	database.exec(
		"INSERT INTO sidebar_pin_order(kind,project_id,workspace_id,conversation_id,ordinal) SELECT 'conversation',NULL,workspace_id,public_id,row_number() OVER (ORDER BY pin_ordinal) FROM conversation_presentations WHERE pin_ordinal IS NOT NULL",
	);
	database.exec(
		"INSERT INTO sidebar_pin_order(kind,project_id,workspace_id,conversation_id,ordinal) SELECT 'project',s.project_id,NULL,NULL,(SELECT count(*) FROM sidebar_pin_order)+row_number() OVER (ORDER BY s.pin_ordinal) FROM project_presentations s JOIN projects p ON p.project_id=s.project_id WHERE s.pinned=1 AND p.status='ready'",
	);
	database.exec(
		"INSERT INTO sidebar_pin_state SELECT 1,CASE WHEN count(*)=0 THEN 0 ELSE 1 END,count(*) FROM sidebar_pin_order",
	);
}

export function sidebarPinCommandDigest(params: ReorderSidebarPin): string {
	return createHash("sha256").update(sidebarPinCommandPayload("reorderSidebarPin", params)).digest("hex");
}

function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$(?![\s\S])/u.test(value);
}

/** Metadata-only verification; derived conversation-directory rows and execution/grant stores are not authority. */
export function validateSidebarPinStore(database: DatabaseSync): void {
	try {
		validateMetadata(database);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError("STORE_MISMATCH");
	}
}

function validateMetadata(database: DatabaseSync): void {
	for (const [type, name, expected] of DEFINITIONS) {
		const row = database
			.prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=? AND length(CAST(sql AS BLOB))<=4096")
			.get(type, name);
		if (typeof row?.sql !== "string" || row.sql.replace(/\s+/g, "") !== expected.replace(/\s+/g, ""))
			throw new AppError("STORE_MISMATCH");
	}
	if (
		database
			.prepare(
				"SELECT 1 FROM sidebar_pin_order WHERE typeof(kind)!='text' OR length(CAST(kind AS BLOB))>12 OR (project_id IS NOT NULL AND (typeof(project_id)!='text' OR length(CAST(project_id AS BLOB))>128)) OR (workspace_id IS NOT NULL AND (typeof(workspace_id)!='text' OR length(CAST(workspace_id AS BLOB))>128)) OR (conversation_id IS NOT NULL AND (typeof(conversation_id)!='text' OR length(CAST(conversation_id AS BLOB))>128)) LIMIT 1",
			)
			.get() ||
		database
			.prepare(
				"SELECT 1 FROM sidebar_pin_commands WHERE typeof(request_id)!='text' OR length(CAST(request_id AS BLOB))>128 OR typeof(digest)!='text' OR length(CAST(digest AS BLOB))!=64 OR typeof(params)!='text' OR length(CAST(params AS BLOB))>8192 OR typeof(result)!='text' OR length(CAST(result AS BLOB))>1024 LIMIT 1",
			)
			.get()
	)
		throw new AppError("CAPACITY_EXCEEDED");
	for (const [table, columns] of [
		["sidebar_pin_state", ["singleton", "order_revision", "next_ordinal"]],
		["sidebar_pin_order", ["ordinal"]],
	] as const)
		for (const column of columns)
			if (
				database
					.prepare(
						`SELECT 1 FROM ${table} WHERE typeof(${column})!='integer' OR ${column}<0 OR ${column}>9007199254740991 LIMIT 1`,
					)
					.get()
			)
				throw new AppError("STORE_MISMATCH");
	const states = database.prepare("SELECT * FROM sidebar_pin_state LIMIT 2").all();
	const state = states[0];
	if (
		states.length !== 1 ||
		state.singleton !== 1 ||
		!integer(state.order_revision) ||
		!integer(state.next_ordinal) ||
		(state.order_revision === 0 && state.next_ordinal !== 0)
	)
		throw new AppError("STORE_MISMATCH");
	let conversationOrdinal = 0;
	let projectOrdinal = 0;
	for (const row of database
		.prepare(
			"SELECT o.*,c.pin_ordinal AS conversation_ordinal,p.pin_ordinal AS project_ordinal,p.pinned AS project_pinned,j.status AS project_status FROM sidebar_pin_order o LEFT JOIN conversation_presentations c ON o.kind='conversation' AND c.workspace_id=o.workspace_id AND c.public_id=o.conversation_id LEFT JOIN project_presentations p ON o.kind='project' AND p.project_id=o.project_id LEFT JOIN projects j ON j.project_id=p.project_id ORDER BY o.ordinal",
		)
		.iterate()) {
		if (!integer(row.ordinal) || row.ordinal < 1 || row.ordinal > state.next_ordinal || state.order_revision === 0)
			throw new AppError("STORE_MISMATCH");
		if (row.kind === "project") {
			if (
				!identifier(row.project_id) ||
				row.workspace_id !== null ||
				row.conversation_id !== null ||
				row.project_pinned !== 1 ||
				row.project_status !== "ready" ||
				!integer(row.project_ordinal) ||
				row.project_ordinal <= projectOrdinal
			)
				throw new AppError("STORE_MISMATCH");
			projectOrdinal = row.project_ordinal;
		} else if (row.kind === "conversation") {
			if (
				row.project_id !== null ||
				!identifier(row.workspace_id) ||
				!identifier(row.conversation_id) ||
				!integer(row.conversation_ordinal) ||
				row.conversation_ordinal <= conversationOrdinal
			)
				throw new AppError("STORE_MISMATCH");
			conversationOrdinal = row.conversation_ordinal;
		} else throw new AppError("STORE_MISMATCH");
	}
	if (
		database
			.prepare(
				"SELECT 1 FROM conversation_presentations p WHERE p.pin_ordinal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sidebar_pin_order o WHERE o.kind='conversation' AND o.workspace_id=p.workspace_id AND o.conversation_id=p.public_id) LIMIT 1",
			)
			.get() ||
		database
			.prepare(
				"SELECT 1 FROM project_presentations p JOIN projects j ON j.project_id=p.project_id WHERE p.pinned=1 AND j.status='ready' AND NOT EXISTS (SELECT 1 FROM sidebar_pin_order o WHERE o.kind='project' AND o.project_id=p.project_id) LIMIT 1",
			)
			.get()
	)
		throw new AppError("STORE_MISMATCH");
	for (const row of database.prepare("SELECT * FROM sidebar_pin_commands").iterate()) {
		if (
			!identifier(row.request_id) ||
			typeof row.digest !== "string" ||
			!/^[a-f0-9]{64}$(?![\s\S])/u.test(row.digest) ||
			typeof row.params !== "string" ||
			typeof row.result !== "string"
		)
			throw new AppError("STORE_MISMATCH");
		const params = parseSidebarPinParams("reorderSidebarPin", JSON.parse(row.params));
		const receipt = parseSidebarPinResult("getSidebarPinCommandResult", {
			method: "reorderSidebarPin",
			params,
			result: JSON.parse(row.result),
		});
		if (
			!receipt ||
			params.expectedOrderRevision < 1 ||
			params.requestId !== row.request_id ||
			JSON.stringify(params) !== row.params ||
			sidebarPinCommandDigest(params) !== row.digest ||
			receipt.result.orderRevision > state.order_revision
		)
			throw new AppError("STORE_MISMATCH");
		// Later unpin, archive, or default adoption may remove eligibility, but not this historical identity.
		for (const key of [params.moved, params.before]) {
			if (key === null) continue;
			const current =
				key.kind === "project"
					? database
							.prepare(
								"SELECT s.revision FROM project_presentations s JOIN projects p ON p.project_id=s.project_id WHERE s.project_id=?",
							)
							.get(key.projectId)
					: database
							.prepare("SELECT revision FROM conversation_presentations WHERE workspace_id=? AND public_id=?")
							.get(key.workspaceId, key.conversationId);
			if (!current || !integer(current.revision) || current.revision < 1) throw new AppError("STORE_MISMATCH");
		}
	}
}
