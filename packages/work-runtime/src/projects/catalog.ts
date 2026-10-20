import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { AppError, type Conversation, type Params, type Scope, type Workspace } from "../contracts.ts";
import type { SidebarPins } from "../sidebar-pins/catalog.ts";
import {
	type ConversationMembership,
	isProjectMutationMethod,
	type Project,
	type ProjectCatalogState,
	type ProjectCommandResult,
	type ProjectMethods,
	type ProjectMutationMethod,
	type ProjectPresentation,
	type ProjectRequest,
	type ProjectResponse,
	parseConversationMembership,
	parseProject,
	parseProjectParams,
	parseProjectPresentation,
	parseProjectResult,
	projectCommandPayload,
} from "./contracts.ts";
import type { ProjectCreationPorts } from "./ports.ts";

type CatalogPorts = {
	getProjectConversationSummary?(
		input: ProjectMethods["getProjectConversationSummary"]["params"],
	): ProjectMethods["getProjectConversationSummary"]["result"];
	getWorkspace(input: { workspaceId: string }): Promise<Workspace>;
	verifyWorkspace(workspaceId: string): Promise<void>;
	getConversation(scope: Scope): Promise<Conversation>;
	prepareWorkspace(workspaceId: string): Promise<boolean>;
	getConversationCommandResult(input: Params<"getConversationCommandResult">): Promise<{
		method: string;
		result: Conversation;
	} | null>;
};
type CommandRow = {
	method: ProjectMutationMethod;
	params: unknown;
	reserved: Record<string, unknown>;
	stage: string;
	result: unknown;
};
const LIMIT = 50;
export const PINNED_PROJECT_CANDIDATES =
	"SELECT s.project_id AS projectId,p.name,p.revision,p.home_workspace_id AS homeWorkspaceId,p.status,s.pin_ordinal AS position FROM project_presentations s INDEXED BY project_pin_order LEFT JOIN projects p ON p.project_id=s.project_id WHERE s.pin_ordinal IS NOT NULL AND s.pin_ordinal>? ORDER BY s.pin_ordinal LIMIT ?";
export const UNPINNED_PROJECT_CANDIDATES =
	"SELECT p.project_id AS projectId,p.name,p.revision,p.home_workspace_id AS homeWorkspaceId,p.status,s.pinned,9007199254740991 AS position FROM projects p LEFT JOIN project_presentations s ON s.project_id=p.project_id WHERE p.project_id>? ORDER BY p.project_id LIMIT ?";
export type ProjectFailpoint = "after_reserve" | "after_physical" | "after_commit" | "adoption_batch";
function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("STORE_MISMATCH");
	return value;
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new AppError("STORE_MISMATCH");
	return value;
}
function next(value: unknown): number {
	const result = number(value) + 1;
	if (!Number.isSafeInteger(result)) throw new AppError("CAPACITY_EXCEEDED");
	return result;
}
/** Authoritative metadata in the root catalog, never an execution or permission owner. */
export class ProjectCatalog {
	readonly #db: DatabaseSync;
	readonly #pins?: SidebarPins;
	readonly #storeId: string;
	readonly #ports: CatalogPorts;
	readonly #failpoint?: (point: ProjectFailpoint) => void | Promise<void>;
	#pending: Promise<unknown> = Promise.resolve();
	#queued = 0;
	#stopping = false;
	constructor(
		db: DatabaseSync,
		storeId: string,
		ports: CatalogPorts,
		failpoint?: (point: ProjectFailpoint) => void | Promise<void>,
		pins?: SidebarPins,
	) {
		this.#db = db;
		this.#pins = pins;
		this.#storeId = storeId;
		this.#ports = ports;
		this.#failpoint = failpoint;
	}
	#transaction<T>(operation: () => T): T {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}
	#state() {
		const row = this.#db.prepare("SELECT * FROM project_catalog_state WHERE singleton=1").get();
		if (!row) throw new AppError("STORE_MISMATCH");
		return row;
	}
	state(): ProjectCatalogState {
		const row = this.#state();
		return parseProjectResult("getProjectCatalogState", {
			state: row.state,
			generation: number(row.generation),
			defaultWorkspaceId: row.default_workspace_id,
			...(row.state === "recovery_required" ? { reason: "legacy_default_conflict" } : {}),
		});
	}
	#bump(column: "generation" | "membership_generation" | "metadata_generation") {
		const value = next(this.#state()[column]);
		this.#db.prepare(`UPDATE project_catalog_state SET ${column}=? WHERE singleton=1`).run(value);
	}
	/** Called inside the directory owner's transaction. Never replaces an explicit assignment. */
	recordConversation(scope: Scope): void {
		if (
			this.#db
				.prepare("SELECT 1 FROM project_memberships WHERE workspace_id=? AND conversation_id=?")
				.get(scope.workspaceId, scope.conversationId)
		)
			return;
		const project = this.#workspaceProject(scope.workspaceId);
		if (project === undefined) return; // A journaled creation has not committed its logical identity yet.
		this.#db
			.prepare("INSERT INTO project_memberships VALUES (?,?,?,?,?)")
			.run(scope.workspaceId, scope.conversationId, project, 1, "legacy");
		this.#bump("membership_generation");
	}
	/** Backfill existing projections in bounded batches, including unchanged pre-upgrade directory checkpoints. */
	recordDirectory(workspaceId: string): boolean {
		return this.#transaction(() => {
			if (this.#workspaceProject(workspaceId) === undefined) return true;
			const rows = this.#db
				.prepare(
					"SELECT c.public_id FROM conversations c LEFT JOIN project_memberships m ON m.workspace_id=c.workspace_id AND m.conversation_id=c.public_id WHERE c.workspace_id=? AND m.conversation_id IS NULL ORDER BY c.public_id LIMIT 128",
				)
				.all(workspaceId);
			for (const row of rows) this.recordConversation({ workspaceId, conversationId: string(row.public_id) });
			return rows.length < 128;
		});
	}
	#workspaceProject(workspaceId: string): string | null | undefined {
		const state = this.#state();
		if (state.default_workspace_id === workspaceId) return null;
		const existing = this.#db
			.prepare("SELECT project_id,status FROM projects WHERE home_workspace_id=?")
			.get(workspaceId);
		if (existing) return existing.status === "default" ? null : string(existing.project_id);
		if (
			this.#db
				.prepare(
					"SELECT 1 FROM project_commands WHERE stage!='complete' AND method IN ('createProject','createProjectConversation') AND json_extract(reserved_ids,'$.workspaceId')=? LIMIT 1",
				)
				.get(workspaceId)
		)
			return undefined;
		const workspace = this.#db
			.prepare("SELECT name FROM workspaces WHERE workspace_id=? AND ready=1")
			.get(workspaceId);
		if (!workspace) return undefined;
		// This stable migration mapping preserves every existing renderer project-order ID.
		this.#db
			.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
			.run(workspaceId, string(workspace.name), 1, workspaceId, "legacy", "ready");
		this.#bump("metadata_generation");
		return workspaceId;
	}
	recordWorkspace(workspaceId: string): void {
		this.#transaction(() => this.#workspaceProject(workspaceId));
	}
	get(projectId: string): Project {
		this.#transaction(() => this.#workspaceProject(projectId));
		const row = this.#db
			.prepare(
				"SELECT project_id AS projectId,name,revision,home_workspace_id AS homeWorkspaceId FROM projects WHERE project_id=? AND status='ready'",
			)
			.get(projectId);
		if (!row) throw new AppError("NOT_FOUND");
		return parseProject(row);
	}
	ensureMembership(scope: Scope): ConversationMembership {
		this.#transaction(() => this.recordConversation(scope));
		return this.membership(scope);
	}
	membership(scope: Scope): ConversationMembership {
		const row = this.#db
			.prepare(
				"SELECT workspace_id AS workspaceId,conversation_id AS conversationId,project_id AS projectId,revision FROM project_memberships WHERE workspace_id=? AND conversation_id=?",
			)
			.get(scope.workspaceId, scope.conversationId);
		if (!row) throw new AppError("INDEX_RECOVERY_REQUIRED");
		return parseConversationMembership(row);
	}
	presentation(projectId: string): ProjectPresentation {
		return this.#presentation(projectId);
	}
	#presentation(projectId: string): ProjectPresentation {
		const row = this.#db
			.prepare("SELECT pinned,revision FROM project_presentations WHERE project_id=?")
			.get(projectId);
		return parseProjectPresentation({
			projectId,
			pinned: row ? number(row.pinned) === 1 : false,
			revision: row ? number(row.revision) : 0,
		});
	}
	list(input: ProjectMethods["listProjects"]["params"]): ProjectMethods["listProjects"]["result"] {
		const metadataGeneration = number(this.#state().metadata_generation);
		const orderGeneration = number(
			this.#db.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1").get()
				?.order_generation,
		);
		let after: [number, string] | undefined;
		if (input.cursor) {
			try {
				const p: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
				if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error();
				const c = p as Record<string, unknown>;
				if (
					Object.keys(c).sort().join() !== "after,metadataGeneration,orderGeneration,storeId,version" ||
					c.version !== 1 ||
					c.storeId !== this.#storeId ||
					!Array.isArray(c.after) ||
					c.after.length !== 2 ||
					typeof c.after[0] !== "number" ||
					!Number.isSafeInteger(c.after[0]) ||
					c.after[0] < 0 ||
					typeof c.after[1] !== "string" ||
					!/^([A-Za-z0-9_-]{1,128})?$/.test(c.after[1])
				)
					throw new Error();
				if (c.metadataGeneration !== metadataGeneration || c.orderGeneration !== orderGeneration)
					throw new AppError("CURSOR_STALE");
				after = [c.after[0], c.after[1]];
			} catch (error) {
				if (error instanceof AppError) throw error;
				throw new AppError("INVALID_REQUEST");
			}
		}
		const items: ProjectMethods["listProjects"]["result"]["items"] = [];
		let remaining = LIMIT;
		let nextAfter: [number, string] | null = null;
		// Bound candidates, not just visible rows. Sparse exclusions may produce an empty continuation page.
		if (!after || after[0] !== Number.MAX_SAFE_INTEGER) {
			const rows = this.#db.prepare(PINNED_PROJECT_CANDIDATES).all(after?.[0] ?? 0, remaining + 1);
			for (const row of rows.slice(0, remaining)) {
				if (row.status === "ready")
					items.push({
						project: parseProject({
							projectId: row.projectId,
							name: row.name,
							revision: row.revision,
							homeWorkspaceId: row.homeWorkspaceId,
						}),
						presentation: this.#presentation(string(row.projectId)),
					});
				nextAfter = [number(row.position), string(row.projectId)];
			}
			if (rows.length > remaining) remaining = 0;
			else {
				remaining -= rows.length;
				after = [Number.MAX_SAFE_INTEGER, ""];
				nextAfter = remaining ? null : after;
			}
		}
		if (remaining > 0) {
			const rows = this.#db.prepare(UNPINNED_PROJECT_CANDIDATES).all(after?.[1] ?? "", remaining + 1);
			const candidates = rows.slice(0, remaining);
			for (const row of candidates)
				if (row.status === "ready" && row.pinned !== 1)
					items.push({
						project: parseProject({
							projectId: row.projectId,
							name: row.name,
							revision: row.revision,
							homeWorkspaceId: row.homeWorkspaceId,
						}),
						presentation: this.#presentation(string(row.projectId)),
					});
			const last = candidates.at(-1);
			nextAfter = rows.length > remaining && last ? [Number.MAX_SAFE_INTEGER, string(last.projectId)] : null;
		}
		return {
			items,
			metadataGeneration,
			orderGeneration,
			nextCursor: nextAfter
				? Buffer.from(
						JSON.stringify({
							version: 1,
							storeId: this.#storeId,
							metadataGeneration,
							orderGeneration,
							after: nextAfter,
						}),
					).toString("base64url")
				: null,
		};
	}

	#command(requestId: string): CommandRow | null {
		const row = this.#db.prepare("SELECT * FROM project_commands WHERE request_id=?").get(requestId);
		if (!row) return null;
		if (!isProjectMutationMethod(row.method)) throw new AppError("STORE_MISMATCH");
		const params = parseProjectParams(row.method, JSON.parse(string(row.params)));
		return {
			method: row.method,
			params,
			reserved: JSON.parse(string(row.reserved_ids)) as Record<string, unknown>,
			stage: string(row.stage),
			result: row.result === null ? null : JSON.parse(string(row.result)),
		};
	}
	command(requestId: string): ProjectCommandResult | null {
		const row = this.#command(requestId);
		if (!row) return null;
		return parseProjectResult(
			"getProjectCommandResult",
			row.stage === "complete"
				? { status: "completed", method: row.method, params: row.params, result: row.result }
				: { status: "pending", method: row.method, params: row.params, stage: row.stage, reserved: row.reserved },
		);
	}
	#digest(method: ProjectMutationMethod, params: unknown): string {
		return createHash("sha256")
			.update(projectCommandPayload(method, parseProjectParams(method, params)))
			.digest("hex");
	}
	#prior(method: ProjectMutationMethod, params: { requestId: string }): CommandRow | null {
		const prior = this.#command(params.requestId);
		if (
			prior &&
			(prior.method !== method || this.#digest(prior.method, prior.params) !== this.#digest(method, params))
		)
			throw new AppError("IDEMPOTENCY_CONFLICT");
		return prior;
	}
	#reserve(method: ProjectMutationMethod, params: { requestId: string }, reserved: object, stage: string): void {
		this.#db
			.prepare("INSERT INTO project_commands VALUES (?,?,?,?,?,?,?)")
			.run(
				params.requestId,
				method,
				this.#digest(method, params),
				JSON.stringify(params),
				JSON.stringify(reserved),
				stage,
				null,
			);
	}
	#finish(method: ProjectMutationMethod, params: { requestId: string }, result: unknown): void {
		const parsed = parseProjectResult(method, result);
		if (!this.#prior(method, params)) this.#reserve(method, params, {}, "complete");
		this.#db
			.prepare("UPDATE project_commands SET stage='complete',result=? WHERE request_id=?")
			.run(JSON.stringify(parsed), params.requestId);
	}
	async execute(request: ProjectRequest, creation: ProjectCreationPorts): Promise<ProjectResponse> {
		if (this.#stopping) throw new AppError("CLOSED");
		switch (request.method) {
			case "getProjectCatalogState":
				return this.state();
			case "listProjects":
				return this.list(request.params);
			case "getProject":
				return this.get(request.params.projectId);
			case "getProjectPresentation":
				this.get(request.params.projectId);
				return this.#presentation(request.params.projectId);
			case "getProjectConversationSummary":
				this.get(request.params.projectId);
				if (!this.#ports.getProjectConversationSummary) throw new AppError("INDEX_RECOVERY_REQUIRED");
				return this.#ports.getProjectConversationSummary(request.params);
			case "getProjectCommandResult":
				return this.command(request.params.requestId);
			case "getConversationMembership": {
				const conversation = await this.#ports.getConversation(request.params);
				this.#transaction(() => this.recordConversation(conversation));
				return this.membership(conversation);
			}
		}
		if (this.#queued >= 16) throw new AppError("CAPACITY_EXCEEDED");
		this.#queued++;
		const result = this.#pending
			.then(async () => {
				const result = await this.#mutate(request, creation);
				await this.#failpoint?.("after_commit");
				return result;
			})
			.finally(() => {
				this.#queued--;
			});
		this.#pending = result.catch(() => undefined);
		return result;
	}
	async #mutate(
		request: Extract<ProjectRequest, { method: ProjectMutationMethod }>,
		creation: ProjectCreationPorts,
	): Promise<ProjectResponse> {
		if (this.#stopping) throw new AppError("CLOSED");
		const prior = this.#prior(request.method, request.params);
		if (prior?.stage === "complete") return parseProjectResult(request.method, prior.result);
		if (request.method === "createProject") {
			if (!prior)
				this.#transaction(() =>
					this.#reserve(
						request.method,
						request.params,
						{ projectId: randomUUID(), workspaceId: randomUUID() },
						"reserved",
					),
				);
			const saved = this.#command(request.params.requestId);
			if (!saved) throw new AppError("INTERNAL");
			await this.#failpoint?.("after_reserve");
			const projectId = string(saved.reserved.projectId),
				workspaceId = string(saved.reserved.workspaceId);
			await creation.createWorkspace({ workspaceId, name: request.params.name });
			this.#db
				.prepare("UPDATE project_commands SET stage='physical_created' WHERE request_id=?")
				.run(request.params.requestId);
			await this.#failpoint?.("after_physical");
			const project = { projectId, name: request.params.name, revision: 1, homeWorkspaceId: workspaceId };
			this.#transaction(() => {
				this.#db
					.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
					.run(projectId, project.name, 1, workspaceId, "created", "ready");
				this.#bump("metadata_generation");
				this.#finish(request.method, request.params, project);
			});
			return project;
		}
		if (request.method === "createProjectConversation") {
			if (!prior) {
				const role = this.#state();
				if (request.params.projectId === null && this.#pendingDefault())
					throw new AppError("INDEX_RECOVERY_REQUIRED");
				if (request.params.projectId === null && role.state !== "ready")
					throw new AppError("INDEX_RECOVERY_REQUIRED");
				const createDefault = request.params.projectId === null && role.default_workspace_id === null;
				const workspaceId =
					request.params.projectId === null
						? createDefault
							? randomUUID()
							: string(role.default_workspace_id)
						: this.get(request.params.projectId).homeWorkspaceId;
				this.#transaction(() =>
					this.#reserve(
						request.method,
						request.params,
						{ workspaceId, innerRequestId: randomUUID(), createDefault },
						"reserved",
					),
				);
			}
			const saved = this.#command(request.params.requestId);
			if (!saved) throw new AppError("INTERNAL");
			await this.#failpoint?.("after_reserve");
			const workspaceId = string(saved.reserved.workspaceId),
				innerRequestId = string(saved.reserved.innerRequestId);
			if (saved.reserved.createDefault === true) {
				await creation.createWorkspace({ workspaceId, name: "Chats" });
				this.#transaction(() => {
					const role = this.#state();
					if (role.default_workspace_id !== null && role.default_workspace_id !== workspaceId)
						throw new AppError("IDEMPOTENCY_CONFLICT");
					if (role.default_workspace_id === null) {
						this.#db
							.prepare(
								"UPDATE project_catalog_state SET default_workspace_id=?,default_provenance=? WHERE singleton=1",
							)
							.run(workspaceId, JSON.stringify({ kind: "created", requestId: request.params.requestId }));
						this.#bump("generation");
					}
					this.#db
						.prepare("UPDATE project_commands SET stage='workspace_created' WHERE request_id=?")
						.run(request.params.requestId);
				});
			}
			const physical = {
				workspaceId,
				requestId: innerRequestId,
				title: request.params.title,
				...(request.params.model ? { model: request.params.model } : {}),
			};
			const existing = await this.#ports.getConversationCommandResult({ workspaceId, requestId: innerRequestId });
			if (existing && existing.method !== "createConversation") throw new AppError("IDEMPOTENCY_CONFLICT");
			const conversation = existing?.result ?? (await creation.createConversation(physical));
			this.#db
				.prepare("UPDATE project_commands SET stage='physical_created' WHERE request_id=?")
				.run(request.params.requestId);
			await this.#failpoint?.("after_physical");
			const membership: ConversationMembership = {
				...conversation,
				projectId: request.params.projectId,
				revision: 1,
			};
			const result = {
				conversation,
				membership: parseConversationMembership({
					workspaceId,
					conversationId: conversation.conversationId,
					projectId: membership.projectId,
					revision: 1,
				}),
			};
			this.#transaction(() => {
				const previous = this.#db
					.prepare("SELECT project_id FROM project_memberships WHERE workspace_id=? AND conversation_id=?")
					.get(workspaceId, conversation.conversationId);
				if (previous && previous.project_id !== membership.projectId) throw new AppError("IDEMPOTENCY_CONFLICT");
				this.#db
					.prepare(
						"INSERT INTO project_memberships VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,conversation_id) DO UPDATE SET provenance='created'",
					)
					.run(workspaceId, conversation.conversationId, membership.projectId, 1, "created");
				if (!previous) this.#bump("membership_generation");
				this.#finish(request.method, request.params, result);
			});
			return result;
		}
		if (request.method === "adoptLegacyDefaultWorkspace") return this.#adopt(request.params, prior);
		if (request.method === "renameProject") {
			const project = this.get(request.params.projectId);
			return this.#transaction(() => {
				if (project.revision !== request.params.expectedRevision) throw new AppError("IDEMPOTENCY_CONFLICT");
				const result = {
					...project,
					name: request.params.name,
					revision: project.name === request.params.name ? project.revision : next(project.revision),
				};
				this.#db
					.prepare("UPDATE projects SET name=?,revision=? WHERE project_id=?")
					.run(result.name, result.revision, result.projectId);
				if (result.revision !== project.revision) this.#bump("metadata_generation");
				this.#finish(request.method, request.params, result);
				return result;
			});
		}
		if (request.method === "setProjectPinned") {
			this.get(request.params.projectId);
			return this.#transaction(() => {
				const previous = this.#presentation(request.params.projectId);
				if (previous.revision !== request.params.expectedPresentationRevision)
					throw new AppError("IDEMPOTENCY_CONFLICT");
				const state = this.#db.prepare("SELECT * FROM project_presentation_state WHERE singleton=1").get();
				if (!state) throw new AppError("STORE_MISMATCH");
				const changed = previous.pinned !== request.params.pinned;
				const result = {
					...previous,
					pinned: request.params.pinned,
					revision: changed ? next(previous.revision) : previous.revision,
				};
				if (changed) {
					const ordinal = result.pinned ? next(state.next_ordinal) : null;
					this.#db
						.prepare(
							"INSERT INTO project_presentations VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET pinned=excluded.pinned,revision=excluded.revision,pin_ordinal=excluded.pin_ordinal",
						)
						.run(result.projectId, Number(result.pinned), result.revision, ordinal);
					this.#db
						.prepare("UPDATE project_presentation_state SET order_generation=?,next_ordinal=? WHERE singleton=1")
						.run(next(state.order_generation), ordinal ?? number(state.next_ordinal));
					this.#pins?.changed({ kind: "project", projectId: result.projectId }, result.pinned);
				}
				this.#finish(request.method, request.params, result);
				return result;
			});
		}
		return this.#reorder(request.params);
	}
	async #adopt(
		input: ProjectMethods["adoptLegacyDefaultWorkspace"]["params"],
		prior: CommandRow | null,
	): Promise<ProjectCatalogState> {
		if (input.provenance.storeId !== this.#storeId) throw new AppError("STORE_MISMATCH");
		if (!prior && this.#pendingDefault()) throw new AppError("INDEX_RECOVERY_REQUIRED");
		await this.#ports.verifyWorkspace(input.workspaceId);
		if (!prior)
			this.#transaction(() => {
				const state = this.#state();
				if (
					state.generation !== input.expectedCatalogGeneration ||
					state.default_workspace_id !== input.expectedDefaultWorkspaceId ||
					(state.default_workspace_id !== null && state.default_workspace_id !== input.workspaceId) ||
					state.adoption_request_id !== null
				)
					throw new AppError("IDEMPOTENCY_CONFLICT");
				const project = this.#db
					.prepare("SELECT provenance FROM projects WHERE home_workspace_id=?")
					.get(input.workspaceId);
				if (project?.provenance === "created") throw new AppError("IDEMPOTENCY_CONFLICT");
				if (
					this.#db
						.prepare(
							"SELECT 1 FROM project_memberships m JOIN projects p ON p.project_id=m.project_id WHERE p.home_workspace_id=? AND m.provenance='created' LIMIT 1",
						)
						.get(input.workspaceId)
				)
					throw new AppError("IDEMPOTENCY_CONFLICT");
				this.#reserve("adoptLegacyDefaultWorkspace", input, { workspaceId: input.workspaceId }, "backfilling");
				this.#db
					.prepare(
						"UPDATE project_catalog_state SET state='adopting',default_workspace_id=?,default_provenance=?,adoption_request_id=?,adoption_workspace_after='',adoption_conversation_after='' WHERE singleton=1",
					)
					.run(input.workspaceId, JSON.stringify(input.provenance), input.requestId);
				const hidden = this.#db
					.prepare("SELECT project_id,status FROM projects WHERE home_workspace_id=?")
					.get(input.workspaceId);
				if (hidden) {
					const id = string(hidden.project_id),
						pin = this.#presentation(id);
					if (pin.pinned) {
						this.#db
							.prepare(
								"UPDATE project_presentations SET pinned=0,revision=?,pin_ordinal=NULL WHERE project_id=?",
							)
							.run(next(pin.revision), id);
						const order = this.#db
							.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1")
							.get();
						this.#db
							.prepare("UPDATE project_presentation_state SET order_generation=? WHERE singleton=1")
							.run(next(order?.order_generation));
						// Schema11 could retain a pin on an already-hidden default project. Schema12
						// intentionally excludes that ineligible identity from the mixed authority.
						if (hidden.status === "ready") this.#pins?.changed({ kind: "project", projectId: id }, false);
					}
				}
				this.#db.prepare("UPDATE projects SET status='default' WHERE home_workspace_id=?").run(input.workspaceId);
				this.#bump("generation");
				this.#bump("metadata_generation");
			});
		for (;;) {
			if (this.#stopping) throw new AppError("CLOSED");
			const rows = this.#db
				.prepare(
					"SELECT workspace_id,conversation_id FROM project_memberships WHERE workspace_id=? AND project_id IS NOT NULL AND provenance='legacy' LIMIT 128",
				)
				.all(input.workspaceId);
			if (!rows.length) break;
			this.#transaction(() => {
				for (const row of rows)
					this.#db
						.prepare(
							"UPDATE project_memberships SET project_id=NULL,revision=revision+1 WHERE workspace_id=? AND conversation_id=?",
						)
						.run(row.workspace_id, row.conversation_id);
				this.#bump("membership_generation");
			});
			await this.#failpoint?.("adoption_batch");
			await setImmediate();
		}
		for (;;) {
			if (this.#stopping) throw new AppError("CLOSED");
			const state = this.#state();
			const row = this.#db
				.prepare(
					"SELECT workspace_id FROM workspaces WHERE ready=1 AND workspace_id>? ORDER BY workspace_id LIMIT 1",
				)
				.get(string(state.adoption_workspace_after));
			if (!row) break;
			const workspaceId = string(row.workspace_id);
			while (!(await this.#ports.prepareWorkspace(workspaceId))) {
				if (this.#stopping) throw new AppError("CLOSED");
			}
			if (this.#stopping) throw new AppError("CLOSED");
			let after = string(state.adoption_conversation_after);
			for (;;) {
				if (this.#stopping) throw new AppError("CLOSED");
				const members = this.#db
					.prepare(
						"SELECT public_id FROM conversations WHERE workspace_id=? AND public_id>? ORDER BY public_id LIMIT 128",
					)
					.all(workspaceId, after);
				if (!members.length) break;
				this.#transaction(() => {
					for (const member of members)
						this.recordConversation({ workspaceId, conversationId: string(member.public_id) });
					after = string(members[members.length - 1].public_id);
					this.#db
						.prepare("UPDATE project_catalog_state SET adoption_conversation_after=? WHERE singleton=1")
						.run(after);
				});
				await this.#failpoint?.("adoption_batch");
				await setImmediate();
			}
			this.#db
				.prepare(
					"UPDATE project_catalog_state SET adoption_workspace_after=?,adoption_conversation_after='' WHERE singleton=1",
				)
				.run(workspaceId);
		}
		return this.#transaction(() => {
			this.#db
				.prepare(
					"UPDATE project_catalog_state SET state='ready',adoption_request_id=NULL,adoption_workspace_after='',adoption_conversation_after='' WHERE singleton=1",
				)
				.run();
			this.#bump("generation");
			const result = this.state();
			this.#finish("adoptLegacyDefaultWorkspace", input, result);
			return result;
		});
	}
	#reorder(input: ProjectMethods["reorderPinnedProject"]["params"]): { orderGeneration: number } {
		this.get(input.movedProjectId);
		if (input.beforeProjectId !== null) this.get(input.beforeProjectId);
		return this.#transaction(() => {
			const state = this.#db
				.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1")
				.get();
			let orderGeneration = number(state?.order_generation);
			if (orderGeneration !== input.expectedOrderGeneration) throw new AppError("IDEMPOTENCY_CONFLICT");
			if (this.#pins) {
				this.#pins.reorderInside(
					{ kind: "project", projectId: input.movedProjectId },
					input.beforeProjectId === null ? null : { kind: "project", projectId: input.beforeProjectId },
				);
				const result = {
					orderGeneration: number(
						this.#db.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1").get()
							?.order_generation,
					),
				};
				this.#finish("reorderPinnedProject", input, result);
				return result;
			}
			const moved = this.#db
				.prepare("SELECT pin_ordinal FROM project_presentations WHERE project_id=? AND pinned=1")
				.get(input.movedProjectId);
			const anchor =
				input.beforeProjectId === null
					? null
					: this.#db
							.prepare("SELECT pin_ordinal FROM project_presentations WHERE project_id=? AND pinned=1")
							.get(input.beforeProjectId);
			if (!moved || (input.beforeProjectId !== null && !anchor)) throw new AppError("IDEMPOTENCY_CONFLICT");
			const from = number(moved.pin_ordinal),
				before = anchor ? number(anchor.pin_ordinal) : null;
			const to =
				before !== null && before < from
					? before
					: number(
							this.#db
								.prepare(
									`SELECT max(pin_ordinal) AS position FROM project_presentations WHERE pinned=1 ${before === null ? "" : "AND pin_ordinal<?"}`,
								)
								.get(...(before === null ? [] : [before]))?.position,
						);
			if (from !== to) {
				const low = Math.min(from, to),
					high = Math.max(from, to);
				this.#db
					.prepare(
						`WITH positions AS MATERIALIZED (SELECT project_id,CASE WHEN pin_ordinal=? THEN ? ELSE ${to < from ? "lead" : "lag"}(pin_ordinal) OVER (ORDER BY pin_ordinal) END AS target FROM project_presentations WHERE pin_ordinal BETWEEN ? AND ?) UPDATE project_presentations SET pin_ordinal=-(SELECT target FROM positions WHERE positions.project_id=project_presentations.project_id) WHERE pin_ordinal BETWEEN ? AND ?`,
					)
					.run(from, to, low, high, low, high);
				this.#db
					.prepare("UPDATE project_presentations SET pin_ordinal=-pin_ordinal WHERE pin_ordinal BETWEEN ? AND ?")
					.run(-high, -low);
				orderGeneration = next(orderGeneration);
				this.#db
					.prepare("UPDATE project_presentation_state SET order_generation=? WHERE singleton=1")
					.run(orderGeneration);
			}
			const result = { orderGeneration };
			this.#finish("reorderPinnedProject", input, result);
			return result;
		});
	}
	stop(): void {
		this.#stopping = true;
	}
	#pendingDefault(): boolean {
		return !!this.#db
			.prepare(
				"SELECT 1 FROM project_commands WHERE method='createProjectConversation' AND stage!='complete' AND json_extract(reserved_ids,'$.createDefault')=1 LIMIT 1",
			)
			.get();
	}
	async close(): Promise<void> {
		this.stop();
		await this.#pending;
	}
}
