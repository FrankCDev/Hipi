import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../contracts.ts";
import {
	isProjectMutationMethod,
	type ProjectMutationMethod,
	type ProjectMutations,
	parseProjectParams,
	parseProjectResult,
	projectCommandPayload,
} from "./contracts.ts";

const DEFINITIONS = [
	[
		"table",
		"projects",
		"CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, home_workspace_id TEXT NOT NULL UNIQUE, provenance TEXT NOT NULL CHECK(provenance IN ('created','legacy')), status TEXT NOT NULL CHECK(status IN ('ready','default')))",
	],
	[
		"table",
		"project_memberships",
		"CREATE TABLE project_memberships (workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL, project_id TEXT, revision INTEGER NOT NULL, provenance TEXT NOT NULL CHECK(provenance IN ('created','legacy')), PRIMARY KEY(workspace_id,conversation_id))",
	],
	[
		"index",
		"project_membership_scope",
		"CREATE INDEX project_membership_scope ON project_memberships(project_id,workspace_id,conversation_id)",
	],
	[
		"table",
		"project_catalog_state",
		"CREATE TABLE project_catalog_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL CHECK(state IN ('ready','adopting','recovery_required')), generation INTEGER NOT NULL, default_workspace_id TEXT, default_provenance TEXT, adoption_request_id TEXT, membership_generation INTEGER NOT NULL, metadata_generation INTEGER NOT NULL, adoption_workspace_after TEXT NOT NULL DEFAULT '', adoption_conversation_after TEXT NOT NULL DEFAULT '')",
	],
	[
		"table",
		"project_presentations",
		"CREATE TABLE project_presentations (project_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL CHECK(pinned IN (0,1)), revision INTEGER NOT NULL, pin_ordinal INTEGER)",
	],
	[
		"index",
		"project_pin_order",
		"CREATE UNIQUE INDEX project_pin_order ON project_presentations(pin_ordinal) WHERE pin_ordinal IS NOT NULL",
	],
	[
		"table",
		"project_presentation_state",
		"CREATE TABLE project_presentation_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), order_generation INTEGER NOT NULL, next_ordinal INTEGER NOT NULL)",
	],
	[
		"table",
		"project_commands",
		"CREATE TABLE project_commands (request_id TEXT PRIMARY KEY, method TEXT NOT NULL, digest TEXT NOT NULL, params TEXT NOT NULL, reserved_ids TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('reserved','workspace_created','physical_created','backfilling','complete')), result TEXT)",
	],
] as const;

/** Only the root StoreCatalog owner creates these authoritative logical records. */
export const PROJECT_SCHEMA = DEFINITIONS.map(([, , sql]) =>
	sql.replace(/^CREATE (TABLE|(?:UNIQUE )?INDEX)/, "$& IF NOT EXISTS"),
).join("; ");

/** Run inside the caller's schema migration transaction; this does not infer a legacy default role. */
export function initializeProjectStore(database: DatabaseSync, _options: { pristine: boolean }): void {
	database.exec(PROJECT_SCHEMA);
	database
		.prepare(
			"INSERT INTO project_catalog_state(singleton,state,generation,default_workspace_id,default_provenance,adoption_request_id,membership_generation,metadata_generation) VALUES (1,?,0,NULL,NULL,NULL,0,0)",
		)
		.run("ready");
	database.exec("INSERT INTO project_presentation_state VALUES (1,0,0)");
}

/** Exact request identity excludes the transport envelope and retains normalized parameter order. */
export function projectCommandDigest<M extends ProjectMutationMethod>(
	method: M,
	params: ProjectMutations[M]["params"],
): string {
	return createHash("sha256").update(projectCommandPayload(method, params)).digest("hex");
}

function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$(?![\s\S])/u.test(value);
}

function jsonObject(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string") throw new AppError("STORE_MISMATCH");
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("STORE_MISMATCH");
	return value as Record<string, unknown>;
}

/** Pure schema and metadata verification: never opens PI storage or restores execution authority. */
export function validateProjectStore(database: DatabaseSync): void {
	try {
		validateProjectMetadata(database);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError("STORE_MISMATCH");
	}
}

function validateProjectMetadata(database: DatabaseSync): void {
	for (const [type, name, expected] of DEFINITIONS) {
		const row = database
			.prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=? AND length(CAST(sql AS BLOB))<=4096")
			.get(type, name);
		if (typeof row?.sql !== "string" || row.sql.replace(/\s+/g, "") !== expected.replace(/\s+/g, ""))
			throw new AppError("STORE_MISMATCH");
	}
	const specifications = [
		{
			table: "projects",
			integers: ["revision"],
			strings: [
				["project_id", 128],
				["name", 128],
				["home_workspace_id", 128],
				["provenance", 16],
				["status", 16],
			],
			nullable: [],
		},
		{
			table: "project_memberships",
			integers: ["revision"],
			strings: [
				["workspace_id", 128],
				["conversation_id", 128],
				["project_id", 128],
				["provenance", 16],
			],
			nullable: ["project_id"],
		},
		{
			table: "project_catalog_state",
			integers: ["singleton", "generation", "membership_generation", "metadata_generation"],
			strings: [
				["state", 32],
				["default_workspace_id", 128],
				["default_provenance", 4096],
				["adoption_request_id", 128],
				["adoption_workspace_after", 128],
				["adoption_conversation_after", 128],
			],
			nullable: ["default_workspace_id", "default_provenance", "adoption_request_id"],
		},
		{
			table: "project_presentations",
			integers: ["pinned", "revision", "pin_ordinal"],
			strings: [["project_id", 128]],
			nullable: ["pin_ordinal"],
		},
		{
			table: "project_presentation_state",
			integers: ["singleton", "order_generation", "next_ordinal"],
			strings: [],
			nullable: [],
		},
		{
			table: "project_commands",
			integers: [],
			strings: [
				["request_id", 128],
				["method", 64],
				["digest", 64],
				["params", 8192],
				["reserved_ids", 4096],
				["stage", 32],
				["result", 16384],
			],
			nullable: ["result"],
		},
	] as const;
	for (const spec of specifications) {
		for (const column of spec.integers) {
			const nullable = (spec.nullable as readonly string[]).includes(column);
			if (
				database
					.prepare(
						`SELECT 1 FROM ${spec.table} WHERE ${nullable ? `${column} IS NOT NULL AND ` : ""}(typeof(${column})!='integer' OR ${column}<0 OR ${column}>9007199254740991) LIMIT 1`,
					)
					.get()
			)
				throw new AppError("STORE_MISMATCH");
		}
		for (const [column, maximum] of spec.strings) {
			const nullable = (spec.nullable as readonly string[]).includes(column);
			if (
				database
					.prepare(
						`SELECT 1 FROM ${spec.table} WHERE ${nullable ? `${column} IS NOT NULL AND ` : ""}(typeof(${column})!='text' OR length(CAST(${column} AS BLOB))>?) LIMIT 1`,
					)
					.get(maximum * 3)
			)
				throw new AppError("CAPACITY_EXCEEDED");
		}
		for (const row of database.prepare(`SELECT * FROM ${spec.table}`).iterate()) {
			for (const [column, maximum] of spec.strings)
				if (row[column] !== null && (typeof row[column] !== "string" || row[column].length > maximum))
					throw new AppError("STORE_MISMATCH");
		}
	}
	const states = database.prepare("SELECT * FROM project_catalog_state LIMIT 2").all();
	const state = states[0];
	const presentations = database.prepare("SELECT * FROM project_presentation_state LIMIT 2").all();
	const presentation = presentations[0];
	if (states.length !== 1 || state.singleton !== 1 || presentations.length !== 1 || presentation.singleton !== 1)
		throw new AppError("STORE_MISMATCH");
	if (
		!integer(presentation.next_ordinal) ||
		!integer(presentation.order_generation) ||
		presentation.next_ordinal > presentation.order_generation
	)
		throw new AppError("STORE_MISMATCH");
	if (
		!["ready", "adopting", "recovery_required"].includes(String(state.state)) ||
		(state.default_workspace_id === null) !== (state.default_provenance === null) ||
		(state.default_workspace_id !== null && !identifier(state.default_workspace_id)) ||
		(state.adoption_request_id !== null && !identifier(state.adoption_request_id)) ||
		(state.adoption_workspace_after !== "" && !identifier(state.adoption_workspace_after)) ||
		(state.adoption_conversation_after !== "" && !identifier(state.adoption_conversation_after)) ||
		(state.state === "adopting" && (state.adoption_request_id === null || state.default_workspace_id === null)) ||
		(state.state === "ready" &&
			(state.adoption_request_id !== null ||
				state.adoption_workspace_after !== "" ||
				state.adoption_conversation_after !== ""))
	)
		throw new AppError("STORE_MISMATCH");
	if (state.default_provenance !== null) {
		const provenance = jsonObject(state.default_provenance);
		if (provenance.kind === "created") {
			if (Object.keys(provenance).sort().join() !== "kind,requestId" || !identifier(provenance.requestId))
				throw new AppError("STORE_MISMATCH");
			const command = database
				.prepare("SELECT method,reserved_ids FROM project_commands WHERE request_id=?")
				.get(provenance.requestId);
			const reserved = jsonObject(command?.reserved_ids);
			if (
				command?.method !== "createProjectConversation" ||
				reserved.createDefault !== true ||
				reserved.workspaceId !== state.default_workspace_id
			)
				throw new AppError("STORE_MISMATCH");
		} else if (
			Object.keys(provenance).sort().join() !== "markerVersion,role,storeId,workspaceId" ||
			provenance.markerVersion !== 1 ||
			provenance.role !== "default-chat-workspace" ||
			provenance.workspaceId !== state.default_workspace_id ||
			provenance.storeId !== database.prepare("SELECT store_id FROM identity WHERE singleton=1").get()?.store_id
		)
			throw new AppError("STORE_MISMATCH");
	}
	if (
		state.default_workspace_id !== null &&
		database.prepare("SELECT ready FROM workspaces WHERE workspace_id=?").get(state.default_workspace_id)?.ready !== 1
	)
		throw new AppError("STORE_MISMATCH");
	for (const row of database.prepare("SELECT * FROM projects").iterate()) {
		if (
			!identifier(row.project_id) ||
			!identifier(row.home_workspace_id) ||
			typeof row.name !== "string" ||
			!row.name ||
			!integer(row.revision) ||
			row.revision < 1 ||
			(row.provenance !== "created" && row.provenance !== "legacy") ||
			(row.status !== "ready" && row.status !== "default") ||
			(row.status === "default" && row.home_workspace_id !== state.default_workspace_id) ||
			(row.home_workspace_id === state.default_workspace_id && row.status !== "default") ||
			database.prepare("SELECT ready FROM workspaces WHERE workspace_id=?").get(row.home_workspace_id)?.ready !== 1
		)
			throw new AppError("STORE_MISMATCH");
	}
	for (const row of database.prepare("SELECT * FROM project_memberships").iterate()) {
		if (
			!identifier(row.workspace_id) ||
			!identifier(row.conversation_id) ||
			!integer(row.revision) ||
			row.revision < 1 ||
			(row.provenance !== "created" && row.provenance !== "legacy") ||
			(row.project_id !== null &&
				(!identifier(row.project_id) ||
					!database.prepare("SELECT 1 FROM projects WHERE project_id=?").get(row.project_id))) ||
			database.prepare("SELECT ready FROM workspaces WHERE workspace_id=?").get(row.workspace_id)?.ready !== 1
		)
			throw new AppError("STORE_MISMATCH");
	}
	if (
		state.state === "ready" &&
		database
			.prepare(
				"SELECT 1 FROM project_memberships m JOIN projects p ON p.project_id=m.project_id WHERE p.status='default' LIMIT 1",
			)
			.get()
	)
		throw new AppError("STORE_MISMATCH");
	for (const row of database.prepare("SELECT * FROM project_presentations").iterate()) {
		if (
			!identifier(row.project_id) ||
			(row.pinned !== 0 && row.pinned !== 1) ||
			(row.pinned === 0) !== (row.pin_ordinal === null) ||
			(row.pin_ordinal !== null &&
				(!integer(row.pin_ordinal) ||
					row.pin_ordinal < 1 ||
					!integer(row.revision) ||
					row.revision < 1 ||
					!integer(presentation.next_ordinal) ||
					row.pin_ordinal > presentation.next_ordinal)) ||
			!database.prepare("SELECT 1 FROM projects WHERE project_id=?").get(row.project_id)
		)
			throw new AppError("STORE_MISMATCH");
	}
	for (const row of database.prepare("SELECT * FROM project_commands").iterate()) {
		if (
			!identifier(row.request_id) ||
			!isProjectMutationMethod(row.method) ||
			typeof row.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(row.digest)
		)
			throw new AppError("STORE_MISMATCH");
		const params = parseProjectParams(row.method, jsonObject(row.params));
		if (
			params.requestId !== row.request_id ||
			JSON.stringify(params) !== row.params ||
			projectCommandDigest(row.method, params) !== row.digest
		)
			throw new AppError("STORE_MISMATCH");
		if (
			row.method === "adoptLegacyDefaultWorkspace" &&
			parseProjectParams(row.method, params).provenance.storeId !==
				database.prepare("SELECT store_id FROM identity WHERE singleton=1").get()?.store_id
		)
			throw new AppError("STORE_MISMATCH");
		const reserved = jsonObject(row.reserved_ids);
		const completed = row.stage === "complete";
		if (completed !== (row.result !== null)) throw new AppError("STORE_MISMATCH");
		// Completed multi-store commands retain their original reserved identities too.
		if (
			row.method === "createProject" ||
			row.method === "createProjectConversation" ||
			row.method === "adoptLegacyDefaultWorkspace"
		) {
			parseProjectResult("getProjectCommandResult", {
				status: "pending",
				method: row.method,
				params,
				stage: completed ? (row.method === "adoptLegacyDefaultWorkspace" ? "backfilling" : "reserved") : row.stage,
				reserved,
			});
		} else if (!completed || Object.keys(reserved).length !== 0) throw new AppError("STORE_MISMATCH");
		if (!completed) continue;
		const command = parseProjectResult("getProjectCommandResult", {
			status: "completed",
			method: row.method,
			params,
			result: jsonObject(row.result),
		});
		if (!command || command.status !== "completed") throw new AppError("STORE_MISMATCH");
		switch (command.method) {
			case "createProject":
			case "renameProject": {
				const current = database
					.prepare("SELECT revision,name,home_workspace_id FROM projects WHERE project_id=?")
					.get(command.result.projectId);
				if (
					!current ||
					!integer(current.revision) ||
					current.revision < command.result.revision ||
					(current.revision === command.result.revision && current.name !== command.result.name) ||
					current.home_workspace_id !== command.result.homeWorkspaceId ||
					(command.method === "createProject" &&
						(reserved.projectId !== command.result.projectId ||
							reserved.workspaceId !== command.result.homeWorkspaceId))
				)
					throw new AppError("STORE_MISMATCH");
				break;
			}
			case "createProjectConversation": {
				const membership = command.result.membership;
				const current = database
					.prepare(
						"SELECT revision,project_id FROM project_memberships WHERE workspace_id=? AND conversation_id=?",
					)
					.get(membership.workspaceId, membership.conversationId);
				if (
					!current ||
					!integer(current.revision) ||
					current.revision < membership.revision ||
					(current.revision === membership.revision && current.project_id !== membership.projectId) ||
					reserved.workspaceId !== membership.workspaceId
				)
					throw new AppError("STORE_MISMATCH");
				break;
			}
			case "setProjectPinned": {
				const current = database
					.prepare("SELECT revision,pinned FROM project_presentations WHERE project_id=?")
					.get(command.result.projectId);
				// An initial no-op unpin has no presentation row and revision zero.
				if (
					current
						? !integer(current.revision) ||
							current.revision < command.result.revision ||
							(current.revision === command.result.revision && current.pinned !== Number(command.result.pinned))
						: command.result.revision !== 0
				)
					throw new AppError("STORE_MISMATCH");
				break;
			}
			case "reorderPinnedProject":
				if (
					!integer(presentation.order_generation) ||
					command.result.orderGeneration > presentation.order_generation
				)
					throw new AppError("STORE_MISMATCH");
				for (const projectId of [command.params.movedProjectId, command.params.beforeProjectId])
					if (projectId !== null && !database.prepare("SELECT 1 FROM projects WHERE project_id=?").get(projectId))
						throw new AppError("STORE_MISMATCH");
				break;
			case "adoptLegacyDefaultWorkspace":
				if (
					!integer(state.generation) ||
					command.result.generation > state.generation ||
					command.params.provenance.storeId !==
						database.prepare("SELECT store_id FROM identity WHERE singleton=1").get()?.store_id
				)
					throw new AppError("STORE_MISMATCH");
		}
	}
	if (state.state === "adopting") {
		const command = database
			.prepare("SELECT method,stage,params FROM project_commands WHERE request_id=?")
			.get(state.adoption_request_id);
		if (command?.method !== "adoptLegacyDefaultWorkspace" || command.stage !== "backfilling")
			throw new AppError("STORE_MISMATCH");
		const params = parseProjectParams("adoptLegacyDefaultWorkspace", jsonObject(command.params));
		if (params.workspaceId !== state.default_workspace_id || jsonObject(state.default_provenance).kind === "created")
			throw new AppError("STORE_MISMATCH");
	}
}
