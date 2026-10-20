import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import {
	AppError,
	type Conversation,
	LIMITS,
	type Params,
	parseResult,
	type Scope,
	type Workspace,
} from "../contracts.ts";
import {
	type ConversationMembership,
	type ProjectConversationSummary,
	parseConversationMembership,
} from "../projects/contracts.ts";
import {
	type ActivityBasis,
	NAVIGATION_LIMITS,
	type NavigationInvalidation,
	type SidebarConversation,
	type SidebarCoverage,
	type SidebarPage,
} from "./contracts.ts";
import { navigationQuery, PROJECT_SUMMARY_CANDIDATES } from "./query.ts";
import { type ActivityPosition, type NavigationSource, readActivityStep } from "./source.ts";

export type NavigationPorts = {
	nextWorkspace(after: string): Workspace | undefined;
	prepareWorkspace(workspaceId: string): Promise<boolean>;
	nextConversation(workspaceId: string, after: string): { conversation: Conversation; ordinal: number } | undefined;
	read<T>(scope: Scope, operation: (storage: Storage, source: NavigationSource) => Promise<T>): Promise<T>;
	hasWorkspace(workspaceId: string): boolean;
};
type State = {
	generation: string;
	revision: number;
	inventory_generation: number;
	cycle: string;
	workspace_after: string;
	workspace_id: string | null;
	conversation_after: string;
	current_id: string | null;
	position: string | null;
	completed_at: number | null;
	active: number;
};
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	return value;
}
function text(value: unknown): string {
	if (typeof value !== "string") throw new AppError("INDEX_RECOVERY_REQUIRED");
	return value;
}
function encode(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(raw: string, keys: string[]): Record<string, unknown> {
	try {
		if (raw.length > LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
		const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join() !== keys.sort().join()
		)
			throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new AppError("INVALID_REQUEST");
	}
}
/** Catalog-owned derived navigation. A publication callback only marks dirty; this owner does the I/O. */
export class NavigationProjection {
	readonly #db: DatabaseSync;
	readonly #storeId: string;
	readonly #ports: NavigationPorts;
	#pending: Promise<unknown> = Promise.resolve();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;
	#dirty = false;
	#restart = false;
	#resetPublication = false;
	readonly #metadata = new Map<string, NavigationInvalidation["conversations"][number]>();
	#epoch = 0;
	#failure: unknown;
	#queued = 0;
	constructor(database: DatabaseSync, storeId: string, ports: NavigationPorts) {
		this.#db = database;
		this.#storeId = storeId;
		this.#ports = ports;
	}
	#state(): State {
		const row = this.#db.prepare("SELECT * FROM navigation_state WHERE singleton=1").get();
		if (!row) throw new AppError("INDEX_RECOVERY_REQUIRED");
		return {
			generation: text(row.generation),
			revision: integer(row.revision),
			inventory_generation: integer(row.inventory_generation),
			cycle: text(row.cycle),
			workspace_after: text(row.workspace_after),
			workspace_id: row.workspace_id === null ? null : text(row.workspace_id),
			conversation_after: text(row.conversation_after),
			current_id: row.current_id === null ? null : text(row.current_id),
			position: row.position === null ? null : text(row.position),
			completed_at: row.completed_at === null ? null : integer(row.completed_at),
			active: integer(row.active),
		};
	}
	#save(state: State): void {
		if (!Number.isSafeInteger(state.revision + 1)) throw new AppError("CAPACITY_EXCEEDED");
		state.revision++;
		this.#db
			.prepare(
				"UPDATE navigation_state SET generation=?,revision=?,inventory_generation=?,cycle=?,workspace_after=?,workspace_id=?,conversation_after=?,current_id=?,position=?,completed_at=?,active=? WHERE singleton=1",
			)
			.run(
				state.generation,
				state.revision,
				state.inventory_generation,
				state.cycle,
				state.workspace_after,
				state.workspace_id,
				state.conversation_after,
				state.current_id,
				state.position,
				state.completed_at,
				state.active,
			);
	}
	#applyDirty(): void {
		if (!this.#dirty && !this.#restart) return;
		const state = this.#state();
		if (state.active && !this.#restart) return;
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			let changed = false;
			for (const fact of this.#metadata.values()) {
				const value = fact.conversation,
					source = JSON.stringify([fact.generation, fact.durableId]);
				if (
					this.#db
						.prepare(
							"SELECT 1 FROM navigation_sources WHERE workspace_id=? AND public_id=? AND source_generation!=? LIMIT 1",
						)
						.get(value.workspaceId, value.conversationId, source)
				)
					this.#resetPublication = true;
				const result = this.#db
					.prepare(
						"UPDATE navigation_sources SET conversation=? WHERE workspace_id=? AND public_id=? AND source_generation=? AND json_extract(conversation,'$.revision')<=?",
					)
					.run(JSON.stringify(value), value.workspaceId, value.conversationId, source, value.revision);
				changed ||= Number(result.changes) > 0;
			}
			if (this.#resetPublication)
				this.#db.exec("UPDATE navigation_publication SET cycle=NULL,generation=NULL WHERE singleton=1");
			else if (changed)
				this.#db
					.prepare("UPDATE navigation_publication SET generation=? WHERE singleton=1 AND cycle IS NOT NULL")
					.run(randomUUID());
			state.generation = randomUUID();
			state.cycle = randomUUID();
			state.active = 1;
			state.workspace_after = "";
			state.workspace_id = null;
			state.conversation_after = "";
			state.current_id = null;
			state.position = null;
			this.#save(state);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
		this.#dirty = false;
		this.#restart = false;
		this.#resetPublication = false;
		this.#metadata.clear();
	}
	/** Synchronous, constant-size invalidation; never calls PI or materializes rows. */
	invalidate(metadata?: NavigationInvalidation): void {
		if (this.#closed) return;
		if (metadata) {
			this.#restart = true;
			this.#epoch++;
			this.#resetPublication ||= metadata.reset;
			for (const value of metadata.conversations) {
				if (this.#metadata.size >= 256) {
					this.#resetPublication = true;
					this.#metadata.clear();
					break;
				}
				const key = JSON.stringify([value.conversation.workspaceId, value.conversation.conversationId]);
				const previous = this.#metadata.get(key);
				if (previous && (previous.generation !== value.generation || previous.durableId !== value.durableId))
					this.#resetPublication = true;
				if (!previous || previous.conversation.revision <= value.conversation.revision)
					this.#metadata.set(key, value);
			}
		}
		this.#dirty = true;
		this.#failure = undefined;
		this.#schedule();
	}
	inventoryChanged(): void {
		const state = this.#state();
		state.inventory_generation++;
		if (!Number.isSafeInteger(state.inventory_generation)) throw new AppError("CAPACITY_EXCEEDED");
		this.#save(state);
		this.#restart = true;
		this.#epoch++;
		this.invalidate();
	}
	start(): void {
		// Restarted processes never serve the previous process's unverified publication.
		this.#db.exec("UPDATE navigation_publication SET cycle=NULL,generation=NULL WHERE singleton=1");
		this.#restart = true;
		this.#epoch++;
		this.invalidate();
	}
	#publication(): { cycle: string | null; generation: string | null } {
		const row = this.#db.prepare("SELECT cycle,generation FROM navigation_publication WHERE singleton=1").get();
		if (!row) throw new AppError("INDEX_RECOVERY_REQUIRED");
		return {
			cycle: row.cycle === null ? null : text(row.cycle),
			generation: row.generation === null ? null : text(row.generation),
		};
	}
	#cleanup(state = this.#state()): number {
		const published = this.#publication();
		return Number(
			this.#db
				.prepare(
					"DELETE FROM navigation_sources WHERE rowid IN (SELECT rowid FROM navigation_sources WHERE cycle!=? AND (? IS NULL OR cycle!=?) LIMIT ?)",
				)
				.run(state.cycle, published.cycle, published.cycle, NAVIGATION_LIMITS.candidates).changes,
		);
	}
	#schedule(): void {
		if (this.#closed || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			try {
				if (this.#closed) return;
				if (!this.#dirty && !this.#state().active) {
					if (this.#cleanup() === NAVIGATION_LIMITS.candidates) this.#schedule();
					return;
				}
			} catch (error) {
				this.#failure = error;
				return;
			}
			void this.refresh({})
				.then((status) => {
					if (status.state !== "ready" || this.#cleanup() === NAVIGATION_LIMITS.candidates) this.#schedule();
				})
				.catch((error: unknown) => {
					if (error instanceof AppError && error.code === "CURSOR_STALE") this.#schedule();
					else this.#failure = error;
				});
		}, 25);
		this.#timer.unref();
	}
	#status(state = this.#state()): SidebarCoverage {
		const published = this.#publication();
		const active = !!state.active || this.#dirty;
		return {
			generation: published.generation ?? state.generation,
			membershipGeneration: integer(
				this.#db.prepare("SELECT generation FROM presentation_state WHERE singleton=1").get()?.generation,
			),
			state: published.cycle === null ? "building" : active ? "refreshing" : "ready",
			completedAt: published.cycle === null ? null : state.completed_at,
			nextCursor:
				active || published.cycle === null
					? encode({ v: 1, kind: "navigation-refresh", storeId: this.#storeId, revision: state.revision })
					: null,
		};
	}
	refresh(input: Params<"refreshSidebarProjection">, signal?: AbortSignal): Promise<SidebarCoverage> {
		if (this.#closed) return Promise.reject(new AppError("CLOSED"));
		if (this.#queued >= 16) return Promise.reject(new AppError("CAPACITY_EXCEEDED"));
		this.#queued++;
		const result = this.#pending
			.then(() => this.#refresh(input, signal))
			.catch((error: unknown) => {
				if (!(error instanceof AppError) || (error.code !== "CURSOR_STALE" && error.code !== "CLOSED"))
					this.#failure = error;
				throw error;
			})
			.finally(() => {
				this.#queued--;
			});
		this.#pending = result.catch(() => undefined);
		return result;
	}
	async #refresh(input: Params<"refreshSidebarProjection">, signal?: AbortSignal): Promise<SidebarCoverage> {
		if (this.#closed || signal?.aborted) throw new AppError("CLOSED");
		this.#applyDirty();
		const state = this.#state(),
			epoch = this.#epoch;
		if (input.cursor) {
			const p = decode(input.cursor, ["v", "kind", "storeId", "revision"]);
			if (
				p.v !== 1 ||
				p.kind !== "navigation-refresh" ||
				p.storeId !== this.#storeId ||
				!Number.isSafeInteger(p.revision) ||
				Number(p.revision) < 0
			)
				throw new AppError("INVALID_REQUEST");
			if (p.revision !== state.revision) throw new AppError("CURSOR_STALE");
		}
		this.#failure = undefined;
		if (!state.active) {
			state.active = 1;
			state.generation = randomUUID();
			state.cycle = randomUUID();
			state.workspace_after = "";
			state.workspace_id = null;
			state.conversation_after = "";
			state.current_id = null;
			state.position = null;
			this.#save(state);
		}
		const check = () => {
			if (this.#closed || signal?.aborted) throw new AppError("CLOSED");
			if (epoch !== this.#epoch || state.revision !== this.#state().revision) throw new AppError("CURSOR_STALE");
		};
		if (this.#cleanup(state) === NAVIGATION_LIMITS.candidates) {
			this.#save(state);
			return this.#status(state);
		}
		if (state.workspace_id === null) {
			const workspace = this.#ports.nextWorkspace(state.workspace_after);
			if (!workspace) {
				check();
				state.active = 0;
				state.completed_at = Date.now();
				this.#db.exec("BEGIN IMMEDIATE");
				try {
					this.#db
						.prepare("UPDATE navigation_publication SET cycle=?,generation=? WHERE singleton=1")
						.run(state.cycle, state.generation);
					this.#save(state);
					this.#db.exec("COMMIT");
				} catch (error) {
					this.#db.exec("ROLLBACK");
					throw error;
				}
				this.#schedule();
				return this.#status(state);
			}
			const complete = await this.#ports.prepareWorkspace(workspace.workspaceId);
			check();
			if (!complete) {
				this.#save(state);
				return this.#status(state);
			}
			state.workspace_id = workspace.workspaceId;
			state.conversation_after = "";
		}
		const next = this.#ports.nextConversation(state.workspace_id, state.conversation_after);
		if (!next) {
			state.workspace_after = state.workspace_id;
			state.workspace_id = null;
			state.current_id = null;
			state.position = null;
			this.#save(state);
			return this.#status(state);
		}
		if (state.current_id !== null && state.current_id !== next.conversation.conversationId)
			throw new AppError("CURSOR_STALE");
		state.current_id = next.conversation.conversationId;
		const prior = state.position === null ? undefined : (JSON.parse(state.position) as ActivityPosition);
		let batch: Awaited<ReturnType<typeof readActivityStep>>;
		try {
			batch = await this.#ports.read(next.conversation, (storage, source) =>
				readActivityStep(storage, source, next.conversation, prior, signal),
			);
		} catch (error) {
			if (error instanceof AppError && error.code === "CURSOR_STALE") {
				this.#restart = true;
				this.#epoch++;
				this.#db.exec("UPDATE navigation_publication SET cycle=NULL,generation=NULL WHERE singleton=1");
				this.invalidate();
			}
			throw error;
		}
		check();
		state.position = JSON.stringify(batch.position);
		if (state.position.length > 4096) throw new AppError("CAPACITY_EXCEEDED");
		const published = this.#publication();
		if (
			(published.cycle !== null &&
				this.#db
					.prepare(
						"SELECT 1 FROM navigation_sources WHERE cycle=? AND workspace_id=? AND public_id=? AND source_generation!=? LIMIT 1",
					)
					.get(
						published.cycle,
						next.conversation.workspaceId,
						next.conversation.conversationId,
						batch.position.source,
					)) ||
			this.#db
				.prepare(
					"SELECT 1 FROM navigation_sources WHERE cycle=? AND workspace_id=? AND json_extract(source_generation,'$[0]')!=json_extract(?,'$[0]') LIMIT 1",
				)
				.get(state.cycle, next.conversation.workspaceId, batch.position.source)
		) {
			this.#db.exec("UPDATE navigation_publication SET cycle=NULL,generation=NULL WHERE singleton=1");
			this.#restart = true;
			this.#epoch++;
			this.invalidate();
			throw new AppError("CURSOR_STALE");
		}
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			if (batch.complete) {
				const previous = this.#db
					.prepare(
						"SELECT source_generation,recency_at,basis FROM navigation_sources WHERE workspace_id=? AND public_id=? AND source_generation=? ORDER BY recency_at DESC LIMIT 1",
					)
					.get(next.conversation.workspaceId, next.conversation.conversationId, batch.position.source);
				let at = batch.position.recencyAt,
					basis = batch.position.basis;
				if (
					!batch.unversioned &&
					previous?.source_generation === batch.position.source &&
					previous.recency_at !== null &&
					(at === null || integer(previous.recency_at) > at)
				) {
					at = integer(previous.recency_at);
					basis = previous.basis as ActivityBasis;
				}
				this.#db
					.prepare(
						"INSERT INTO navigation_sources VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cycle,workspace_id,public_id) DO UPDATE SET source_generation=excluded.source_generation,ordinal=excluded.ordinal,conversation=excluded.conversation,recency_at=excluded.recency_at,basis=excluded.basis",
					)
					.run(
						next.conversation.workspaceId,
						next.conversation.conversationId,
						batch.position.source,
						state.cycle,
						next.ordinal,
						JSON.stringify(next.conversation),
						at,
						basis,
					);
				state.conversation_after = state.current_id;
				state.current_id = null;
				state.position = null;
			}
			this.#save(state);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
		return this.#status(state);
	}
	projectSummary(input: Params<"getProjectConversationSummary">): ProjectConversationSummary {
		if (this.#closed) throw new AppError("CLOSED");
		this.#applyDirty();
		if (this.#failure) throw this.#failure;
		const catalog = this.#db
			.prepare("SELECT state,membership_generation FROM project_catalog_state WHERE singleton=1")
			.get();
		if (catalog?.state !== "ready") throw new AppError("INDEX_RECOVERY_REQUIRED");
		if (!this.#db.prepare("SELECT 1 FROM projects WHERE project_id=? AND status='ready'").get(input.projectId))
			throw new AppError("NOT_FOUND");
		const status = this.#status(),
			published = this.#publication();
		const coverage = {
			generation: status.generation,
			projectMembershipGeneration: integer(catalog.membership_generation),
			state: status.state,
			completedAt: status.completedAt,
		};
		if (published.cycle === null) {
			this.#schedule();
			return { matchedAtLeast: 0, complete: false, coverage };
		}
		const rows = this.#db
			.prepare(PROJECT_SUMMARY_CANDIDATES)
			.all(published.cycle, input.projectId, NAVIGATION_LIMITS.candidates + 1);
		let matchedAtLeast = 0,
			verified = true;
		for (const row of rows.slice(0, NAVIGATION_LIMITS.candidates)) {
			if (row.conversation === null) {
				verified = false;
				continue;
			}
			let conversation: Conversation;
			try {
				conversation = parseResult("getConversation", JSON.parse(String(row.conversation)));
			} catch {
				throw new AppError("INDEX_RECOVERY_REQUIRED");
			}
			if (conversation.workspaceId !== row.workspace_id || conversation.conversationId !== row.conversation_id)
				throw new AppError("INDEX_RECOVERY_REQUIRED");
			if (input.filter === "all" || (conversation.archivedAt !== null) === (input.filter === "archived"))
				matchedAtLeast++;
		}
		return {
			matchedAtLeast,
			complete: status.state === "ready" && verified && rows.length <= NAVIGATION_LIMITS.candidates,
			coverage,
		};
	}
	list(input: Params<"listSidebarConversations">): SidebarPage {
		if (this.#closed) throw new AppError("CLOSED");
		this.#applyDirty();
		if (this.#failure) throw this.#failure;
		if (input.view.kind === "workspace" && !this.#ports.hasWorkspace(input.view.workspaceId))
			throw new AppError("NOT_FOUND");
		const logical = input.view.kind === "project" || input.view.kind === "project_recent";
		let projectMembership: number | undefined, projectOrderGeneration: number | undefined;
		if (logical) {
			const catalog = this.#db
				.prepare("SELECT state,membership_generation FROM project_catalog_state WHERE singleton=1")
				.get();
			if (catalog?.state !== "ready") throw new AppError("INDEX_RECOVERY_REQUIRED");
			projectMembership = integer(catalog.membership_generation);
			projectOrderGeneration = integer(
				this.#db.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1").get()
					?.order_generation,
			);
			if (
				input.view.kind === "project" &&
				input.view.projectId !== null &&
				!this.#db.prepare("SELECT 1 FROM projects WHERE project_id=? AND status='ready'").get(input.view.projectId)
			)
				throw new AppError("NOT_FOUND");
		}
		const state = this.#state(),
			coverage: SidebarCoverage = {
				...this.#status(state),
				...(projectMembership === undefined
					? {}
					: { projectMembershipGeneration: projectMembership, projectOrderGeneration }),
			};
		const published = this.#publication();
		const membership = integer(
			this.#db.prepare("SELECT generation FROM presentation_state WHERE singleton=1").get()?.generation,
		);
		const query = JSON.stringify([
			input.view.kind,
			input.view.kind === "workspace"
				? input.view.workspaceId
				: input.view.kind === "project"
					? input.view.projectId
					: null,
			input.filter ?? "active",
			"activity-source-order-v1",
		]);
		let after: [number, string, number, string] | undefined;
		if (input.cursor) {
			const p = decode(input.cursor, [
				"v",
				"kind",
				"storeId",
				"query",
				"generation",
				"membership",
				...(logical ? ["projectMembership", "projectOrderGeneration"] : []),
				"after",
			]);
			if (
				p.v !== 1 ||
				p.kind !== "navigation-page" ||
				p.storeId !== this.#storeId ||
				p.query !== query ||
				typeof p.generation !== "string" ||
				!Number.isSafeInteger(p.membership) ||
				Number(p.membership) < 0 ||
				(projectMembership !== undefined &&
					(!Number.isSafeInteger(p.projectMembership) || Number(p.projectMembership) < 0)) ||
				(logical && (!Number.isSafeInteger(p.projectOrderGeneration) || Number(p.projectOrderGeneration) < 0)) ||
				!Array.isArray(p.after) ||
				p.after.length !== 4 ||
				!Number.isSafeInteger(p.after[0]) ||
				p.after[0] < -1 ||
				typeof p.after[1] !== "string" ||
				!/^[A-Za-z0-9_-]{1,128}$/.test(p.after[1]) ||
				!Number.isSafeInteger(p.after[2]) ||
				p.after[2] < 0 ||
				typeof p.after[3] !== "string" ||
				!/^[A-Za-z0-9_-]{1,128}$/.test(p.after[3])
			)
				throw new AppError("INVALID_REQUEST");
			if (
				p.generation !== published.generation ||
				p.membership !== membership ||
				p.projectMembership !== projectMembership ||
				p.projectOrderGeneration !== projectOrderGeneration ||
				published.cycle === null
			)
				throw new AppError("CURSOR_STALE");
			after = p.after as [number, string, number, string];
			if (input.view.kind === "workspace" && after[1] !== input.view.workspaceId)
				throw new AppError("INVALID_REQUEST");
			const anchor = this.#db
				.prepare(
					"SELECT ordinal,recency_at FROM navigation_sources WHERE cycle=? AND workspace_id=? AND public_id=?",
				)
				.get(published.cycle, after[1], after[3]);
			if (!anchor || anchor.ordinal !== after[2] || (anchor.recency_at ?? -1) !== after[0])
				throw new AppError("INVALID_REQUEST");
		}
		if (published.cycle === null) {
			this.#schedule();
			return { items: [], coverage, nextCursor: null };
		}
		const queryPlan = navigationQuery(
			published.cycle,
			input.view.kind === "workspace" ? input.view.workspaceId : undefined,
			after,
			logical,
		);
		const rows = this.#db.prepare(queryPlan.sql).all(...queryPlan.params);
		const items: SidebarConversation[] = [];
		let consumed = 0,
			position = after;
		for (const row of rows.slice(0, NAVIGATION_LIMITS.candidates)) {
			const conversation = parseResult("getConversation", JSON.parse(String(row.conversation)));
			consumed++;
			position = [
				row.recency_at === null ? -1 : integer(row.recency_at),
				conversation.workspaceId,
				integer(row.ordinal),
				conversation.conversationId,
			];
			let logicalMembership: ConversationMembership | undefined;
			if (logical) {
				try {
					logicalMembership = parseConversationMembership({
						workspaceId: conversation.workspaceId,
						conversationId: conversation.conversationId,
						projectId: row.membership_project_id,
						revision: row.membership_revision,
					});
				} catch {
					throw new AppError("INDEX_RECOVERY_REQUIRED");
				}
				if (logicalMembership.projectId !== null && row.membership_project_status !== "ready")
					throw new AppError("INDEX_RECOVERY_REQUIRED");
				if (input.view.kind === "project" && logicalMembership.projectId !== input.view.projectId) continue;
				if (input.view.kind === "project_recent" && row.membership_project_pinned === 1) continue;
			}
			const filter = input.filter ?? "active";
			// An archive commit is authoritative even if its subsequent pin cleanup was interrupted.
			// Archived conversations cannot be pinned; do not hide archive browsing behind stale cleanup metadata.
			if (conversation.archivedAt === null && row.pin_ordinal !== null && row.pin_ordinal !== undefined) continue;
			if (filter !== "all" && (conversation.archivedAt !== null) !== (filter === "archived")) continue;
			items.push({
				conversation,
				...(logicalMembership === undefined ? {} : { membership: logicalMembership }),
				recencyAt: row.recency_at === null ? null : integer(row.recency_at),
				activityBasis: row.basis as ActivityBasis,
			});
			if (items.length === NAVIGATION_LIMITS.page) break;
		}
		return {
			items,
			coverage,
			nextCursor:
				rows.length > consumed && position
					? encode({
							v: 1,
							kind: "navigation-page",
							storeId: this.#storeId,
							query,
							generation: published.generation,
							membership,
							...(logical ? { projectMembership, projectOrderGeneration } : {}),
							after: position,
						})
					: null,
		};
	}
	async close(): Promise<void> {
		this.#closed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#pending;
	}
}
