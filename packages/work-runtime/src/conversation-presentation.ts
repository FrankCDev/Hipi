import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	AppError,
	type Conversation,
	type ConversationPresentation,
	LIMITS,
	type Params,
	type PinnedConversation,
	type PresentationCommandResult,
	parseResult,
	parseScope,
	type ReorderPinnedConversation,
	type Result,
	type Scope,
} from "./contracts.ts";
import type { SidebarPins } from "./sidebar-pins/catalog.ts";

/** Only StoreCatalog constructs this schema, under its original root owner lease. */
export const PRESENTATION_SCHEMA =
	"CREATE TABLE IF NOT EXISTS conversation_presentations (workspace_id TEXT NOT NULL, public_id TEXT NOT NULL, revision INTEGER NOT NULL, pin_ordinal INTEGER, pin_conversation_revision INTEGER, archived_revision INTEGER NOT NULL, PRIMARY KEY(workspace_id,public_id)); CREATE UNIQUE INDEX IF NOT EXISTS presentation_pin_order ON conversation_presentations(pin_ordinal) WHERE pin_ordinal IS NOT NULL; CREATE TABLE IF NOT EXISTS presentation_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, next_ordinal INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS presentation_commands (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL)";
export const PRESENTATION_ORDER_SCHEMA =
	"ALTER TABLE presentation_state ADD COLUMN order_generation INTEGER NOT NULL DEFAULT 0; UPDATE presentation_state SET order_generation=generation";
export type PresentationFailpoint = "after_read" | "after_commit" | "before_archive_cleanup";
type RecordValue = ConversationPresentation & {
	pinOrdinal: number | null;
	pinConversationRevision: number | null;
	archivedRevision: number;
};
/** Keep maintenance verification independent of PI's document definitions and execution entry point. */
function presentationDigest(
	method: PresentationCommandResult["method"],
	input: PresentationCommandResult["params"],
): string {
	return createHash("sha256")
		.update(JSON.stringify([method, input]))
		.digest("hex");
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("STORE_MISMATCH");
	return value;
}
function increment(value: number): number {
	if (!Number.isSafeInteger(value + 1)) throw new AppError("CAPACITY_EXCEEDED");
	return value + 1;
}
function record(value: Record<string, unknown>): RecordValue {
	const scope = parseScope({ workspaceId: value.workspace_id, conversationId: value.public_id });
	const revision = integer(value.revision);
	const pinOrdinal = value.pin_ordinal === null ? null : integer(value.pin_ordinal);
	const pinConversationRevision =
		value.pin_conversation_revision === null ? null : integer(value.pin_conversation_revision);
	const archivedRevision = integer(value.archived_revision);
	if (
		(pinOrdinal === null) !== (pinConversationRevision === null) ||
		(pinOrdinal !== null &&
			(pinOrdinal < 1 ||
				revision < 1 ||
				pinConversationRevision === null ||
				pinConversationRevision <= archivedRevision))
	)
		throw new AppError("STORE_MISMATCH");
	return { ...scope, revision, pinned: pinOrdinal !== null, pinOrdinal, pinConversationRevision, archivedRevision };
}

/** Bounded row materialization and semantic checks shared by runtime opening and backup verification. */
export function validatePresentationStore(database: DatabaseSync, ordered = false): void {
	if (
		database
			.prepare(
				"SELECT 1 FROM conversation_presentations WHERE length(CAST(workspace_id AS BLOB))>128 OR length(CAST(public_id AS BLOB))>128 LIMIT 1",
			)
			.get() ||
		database
			.prepare(
				"SELECT 1 FROM presentation_commands WHERE length(CAST(request_id AS BLOB))>128 OR length(CAST(digest AS BLOB))!=64 OR length(CAST(result AS BLOB))>4096 LIMIT 1",
			)
			.get()
	)
		throw new AppError("CAPACITY_EXCEEDED");
	const states = database.prepare("SELECT * FROM presentation_state LIMIT 2").all();
	const state = states[0];
	if (states.length !== 1 || state.singleton !== 1) throw new AppError("STORE_MISMATCH");
	const generation = integer(state.generation);
	const nextOrdinal = integer(state.next_ordinal);
	const orderGeneration = ordered ? integer(state.order_generation) : generation;
	if (nextOrdinal > generation || orderGeneration < generation) throw new AppError("STORE_MISMATCH");
	for (const row of database.prepare("SELECT * FROM conversation_presentations").iterate()) {
		const value = record(row);
		if (
			(value.pinOrdinal !== null && value.pinOrdinal > nextOrdinal) ||
			value.revision > generation ||
			database.prepare("SELECT ready FROM workspaces WHERE workspace_id=?").get(value.workspaceId)?.ready !== 1
		)
			throw new AppError("STORE_MISMATCH");
	}
	for (const row of database.prepare("SELECT * FROM presentation_commands").iterate()) {
		if (typeof row.result !== "string") throw new AppError("STORE_MISMATCH");
		const value = parseResult("getPresentationCommandResult", JSON.parse(row.result));
		if (
			!value ||
			value.params.requestId !== row.request_id ||
			presentationDigest(value.method, value.params) !== row.digest
		)
			throw new AppError("STORE_MISMATCH");
		if (value.method === "setConversationPinned") {
			const current = database
				.prepare("SELECT * FROM conversation_presentations WHERE workspace_id=? AND public_id=?")
				.get(value.result.workspaceId, value.result.conversationId);
			if (!current || record(current).revision < value.result.revision) throw new AppError("STORE_MISMATCH");
		} else {
			if (!ordered || value.result.orderGeneration > orderGeneration) throw new AppError("STORE_MISMATCH");
			for (const scope of [value.params.moved, ...(value.params.before ? [value.params.before] : [])]) {
				const current = database
					.prepare("SELECT * FROM conversation_presentations WHERE workspace_id=? AND public_id=?")
					.get(scope.workspaceId, scope.conversationId);
				if (!current || record(current).revision < 1) throw new AppError("STORE_MISMATCH");
			}
		}
	}
}

/** Presentation metadata never owns a Harness, execution, workspace lease or filesystem capability. */
export class ConversationPresentations {
	readonly #database: DatabaseSync;
	readonly #pins?: SidebarPins;
	readonly #storeId: string;
	readonly #getConversation: (scope: Scope) => Promise<Conversation>;
	readonly #failpoint?: (point: PresentationFailpoint) => void | Promise<void>;
	constructor(
		database: DatabaseSync,
		storeId: string,
		getConversation: (scope: Scope) => Promise<Conversation>,
		failpoint?: (point: PresentationFailpoint) => void | Promise<void>,
		pins?: SidebarPins,
	) {
		this.#database = database;
		this.#pins = pins;
		this.#storeId = storeId;
		this.#getConversation = getConversation;
		this.#failpoint = failpoint;
	}
	#read(scope: Scope): RecordValue {
		const row = this.#database
			.prepare("SELECT * FROM conversation_presentations WHERE workspace_id=? AND public_id=?")
			.get(scope.workspaceId, scope.conversationId);
		return row
			? record(row)
			: {
					...scope,
					revision: 0,
					pinned: false,
					pinOrdinal: null,
					pinConversationRevision: null,
					archivedRevision: 0,
				};
	}
	#state(): { generation: number; nextOrdinal: number; orderGeneration: number } {
		const state = this.#database
			.prepare("SELECT generation,next_ordinal,order_generation FROM presentation_state WHERE singleton=1")
			.get();
		if (!state) throw new AppError("STORE_MISMATCH");
		return {
			generation: integer(state.generation),
			nextOrdinal: integer(state.next_ordinal),
			orderGeneration: integer(state.order_generation),
		};
	}
	#put(value: RecordValue): void {
		this.#database
			.prepare(
				"INSERT INTO conversation_presentations VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,public_id) DO UPDATE SET revision=excluded.revision,pin_ordinal=excluded.pin_ordinal,pin_conversation_revision=excluded.pin_conversation_revision,archived_revision=excluded.archived_revision",
			)
			.run(
				value.workspaceId,
				value.conversationId,
				value.revision,
				value.pinOrdinal,
				value.pinConversationRevision,
				value.archivedRevision,
			);
	}
	current(scope: Scope): ConversationPresentation {
		return this.#public(this.#read(scope));
	}
	/** Must run before Restore, and after Archive using its immutable result. Old replay cannot erase a newer pin. */
	recordArchive(conversation: Conversation): void {
		if (conversation.archivedAt === null) return;
		const prior = this.#read(conversation);
		if (prior.archivedRevision >= conversation.revision) return;
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			prior.archivedRevision = conversation.revision;
			let removed = false;
			if (prior.pinConversationRevision !== null && prior.pinConversationRevision <= conversation.revision) {
				removed = true;
				prior.pinOrdinal = null;
				prior.pinConversationRevision = null;
				prior.revision = increment(prior.revision);
				const state = this.#state();
				this.#database
					.prepare("UPDATE presentation_state SET generation=?,order_generation=? WHERE singleton=1")
					.run(increment(state.generation), increment(state.orderGeneration));
			}
			this.#put(prior);
			if (removed)
				this.#pins?.changed(
					{
						kind: "conversation",
						workspaceId: conversation.workspaceId,
						conversationId: conversation.conversationId,
					},
					false,
				);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}
	async finishArchive(conversation: Conversation): Promise<void> {
		await this.#failpoint?.("before_archive_cleanup");
		this.recordArchive(conversation);
	}
	async get(scope: Scope): Promise<ConversationPresentation> {
		const conversation = await this.#getConversation(scope);
		this.recordArchive(conversation);
		return parseResult("getConversationPresentation", this.#public(this.#read(conversation)));
	}
	#public(value: RecordValue): ConversationPresentation {
		return {
			workspaceId: value.workspaceId,
			conversationId: value.conversationId,
			revision: value.revision,
			pinned: value.pinOrdinal !== null,
		};
	}
	command(requestId: string): PresentationCommandResult | null {
		const row = this.#database.prepare("SELECT result FROM presentation_commands WHERE request_id=?").get(requestId);
		if (!row) return null;
		if (typeof row.result !== "string" || Buffer.byteLength(row.result) > 4096) throw new AppError("STORE_MISMATCH");
		const result = parseResult("getPresentationCommandResult", JSON.parse(row.result));
		if (result?.params.requestId !== requestId) throw new AppError("STORE_MISMATCH");
		return result;
	}
	async set(input: Params<"setConversationPinned">): Promise<ConversationPresentation> {
		const digest = presentationDigest("setConversationPinned", input);
		const replay = () => {
			const prior = this.command(input.requestId);
			if (
				prior &&
				(prior.method !== "setConversationPinned" || presentationDigest(prior.method, prior.params) !== digest)
			)
				throw new AppError("IDEMPOTENCY_CONFLICT");
			return prior?.result;
		};
		const prior = replay();
		if (prior) return prior;
		const conversation = await this.#getConversation(input);
		this.recordArchive(conversation);
		await this.#failpoint?.("after_read");
		this.#database.exec("BEGIN IMMEDIATE");
		let result: ConversationPresentation;
		try {
			const repeated = replay();
			if (repeated) result = repeated;
			else {
				const value = this.#read(conversation);
				if (input.pinned && (conversation.archivedAt !== null || conversation.revision <= value.archivedRevision))
					throw new AppError("CONVERSATION_ARCHIVED");
				if (value.revision !== input.expectedPresentationRevision) throw new AppError("IDEMPOTENCY_CONFLICT");
				if (value.pinned !== input.pinned) {
					const state = this.#state();
					value.revision = increment(value.revision);
					value.pinOrdinal = input.pinned ? increment(state.nextOrdinal) : null;
					value.pinConversationRevision = input.pinned ? conversation.revision : null;
					this.#database
						.prepare(
							"UPDATE presentation_state SET generation=?,next_ordinal=?,order_generation=? WHERE singleton=1",
						)
						.run(
							increment(state.generation),
							value.pinOrdinal ?? state.nextOrdinal,
							increment(state.orderGeneration),
						);
				}
				this.#put(value);
				if (value.pinned !== input.pinned)
					this.#pins?.changed(
						{ kind: "conversation", workspaceId: value.workspaceId, conversationId: value.conversationId },
						input.pinned,
					);
				result = this.#public(value);
				const receipt: PresentationCommandResult = { method: "setConversationPinned", params: input, result };
				this.#database
					.prepare("INSERT INTO presentation_commands VALUES (?,?,?)")
					.run(input.requestId, digest, JSON.stringify(receipt));
			}
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
		await this.#failpoint?.("after_commit");
		return result;
	}
	async reorder(input: ReorderPinnedConversation): Promise<Result<"reorderPinnedConversation">> {
		const digest = presentationDigest("reorderPinnedConversation", input);
		const replay = () => {
			const prior = this.command(input.requestId);
			if (
				prior &&
				(prior.method !== "reorderPinnedConversation" || presentationDigest(prior.method, prior.params) !== digest)
			)
				throw new AppError("IDEMPOTENCY_CONFLICT");
			return prior?.result;
		};
		const prior = replay();
		if (prior) return prior;
		const conversations: Conversation[] = [];
		for (const scope of [input.moved, ...(input.before ? [input.before] : [])]) {
			const conversation = await this.#getConversation(scope);
			this.recordArchive(conversation);
			conversations.push(conversation);
		}
		await this.#failpoint?.("after_read");
		this.#database.exec("BEGIN IMMEDIATE");
		let result: Result<"reorderPinnedConversation">;
		try {
			const repeated = replay();
			if (repeated) result = repeated;
			else {
				const values = conversations.map((conversation) => {
					const value = this.#read(conversation);
					if (conversation.archivedAt !== null || conversation.revision <= value.archivedRevision)
						throw new AppError("CONVERSATION_ARCHIVED");
					if (value.pinOrdinal === null) throw new AppError("IDEMPOTENCY_CONFLICT");
					return value;
				});
				const state = this.#state();
				if (state.orderGeneration !== input.expectedOrderGeneration) throw new AppError("IDEMPOTENCY_CONFLICT");
				if (this.#pins) {
					this.#pins.reorderInside(
						{ kind: "conversation", ...input.moved },
						input.before ? { kind: "conversation", ...input.before } : null,
					);
					result = { orderGeneration: this.#state().orderGeneration };
				} else {
					const moved = values[0].pinOrdinal;
					const anchor = values[1]?.pinOrdinal ?? null;
					if (moved === null) throw new AppError("IDEMPOTENCY_CONFLICT");
					const destination =
						anchor !== null && anchor < moved
							? anchor
							: integer(
									this.#database
										.prepare(
											`SELECT max(pin_ordinal) AS ordinal FROM conversation_presentations ${anchor === null ? "" : "WHERE pin_ordinal<?"}`,
										)
										.get(...(anchor === null ? [] : [anchor]))?.ordinal,
								);
					let orderGeneration = state.orderGeneration;
					if (destination !== moved) {
						const low = Math.min(moved, destination);
						const high = Math.max(moved, destination);
						// Rotate the existing ordinal slots, including gaps and all unloaded pins. Negative staging
						// avoids transient unique-index collisions; no membership revision or archive fence changes.
						this.#database
							.prepare(
								`WITH positions AS MATERIALIZED (SELECT workspace_id,public_id,CASE WHEN pin_ordinal=? THEN ? ELSE ${destination < moved ? "lead" : "lag"}(pin_ordinal) OVER (ORDER BY pin_ordinal) END AS target FROM conversation_presentations WHERE pin_ordinal BETWEEN ? AND ?) UPDATE conversation_presentations SET pin_ordinal=-(SELECT target FROM positions WHERE positions.workspace_id=conversation_presentations.workspace_id AND positions.public_id=conversation_presentations.public_id) WHERE pin_ordinal BETWEEN ? AND ?`,
							)
							.run(moved, destination, low, high, low, high);
						this.#database
							.prepare(
								"UPDATE conversation_presentations SET pin_ordinal=-pin_ordinal WHERE pin_ordinal BETWEEN ? AND ?",
							)
							.run(-high, -low);
						orderGeneration = increment(orderGeneration);
						this.#database
							.prepare("UPDATE presentation_state SET order_generation=? WHERE singleton=1")
							.run(orderGeneration);
					}
					result = { orderGeneration };
				}
				const receipt: PresentationCommandResult = { method: "reorderPinnedConversation", params: input, result };
				this.#database
					.prepare("INSERT INTO presentation_commands VALUES (?,?,?)")
					.run(input.requestId, digest, JSON.stringify(receipt));
			}
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
		await this.#failpoint?.("after_commit");
		return result;
	}
	async list(input: Params<"listPinnedConversations">): Promise<Result<"listPinnedConversations">> {
		const state = this.#state();
		let after = 0;
		if (input.cursor !== undefined) {
			let value: Record<string, unknown>;
			try {
				if (!/^[A-Za-z0-9_-]+$/.test(input.cursor) || input.cursor.length > LIMITS.cursor) throw new Error();
				value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
				if (
					!value ||
					Array.isArray(value) ||
					Object.keys(value).sort().join(",") !== "after,generation,kind,storeId,version" ||
					value.storeId !== this.#storeId ||
					value.kind !== "pinned" ||
					value.version !== 1
				)
					throw new Error();
				after = integer(value.after);
				integer(value.generation);
			} catch {
				throw new AppError("INVALID_REQUEST");
			}
			if (value.generation !== state.orderGeneration) throw new AppError("CURSOR_STALE");
		}
		let orderGeneration = state.orderGeneration;
		let scanAfter = after;
		let pageAfter = after;
		const items: PinnedConversation[] = [];
		let nextPinnedScope: Scope | null = null;
		while (nextPinnedScope === null) {
			const rows = this.#database
				.prepare("SELECT * FROM conversation_presentations WHERE pin_ordinal>? ORDER BY pin_ordinal LIMIT ?")
				.all(scanAfter, LIMITS.directoryPage + 1);
			if (rows.length === 0) break;
			for (const row of rows) {
				const candidate = record(row);
				if (candidate.pinOrdinal === null) throw new AppError("STORE_MISMATCH");
				const conversation = await this.#getConversation(candidate);
				// Check before our own synchronous cleanup, not only membership revisions after the scan.
				// A pure reorder changes neither membership revisions nor nextOrdinal.
				if (this.#state().orderGeneration !== orderGeneration) throw new AppError("CURSOR_STALE");
				this.recordArchive(conversation);
				const current = this.#state();
				if (input.cursor !== undefined && current.orderGeneration !== orderGeneration)
					throw new AppError("CURSOR_STALE");
				orderGeneration = current.orderGeneration;
				scanAfter = candidate.pinOrdinal;
				if (conversation.archivedAt !== null) continue;
				if (items.length === LIMITS.directoryPage) {
					nextPinnedScope = { workspaceId: candidate.workspaceId, conversationId: candidate.conversationId };
					break;
				}
				items.push({ conversation, presentation: this.#public(candidate) });
				pageAfter = candidate.pinOrdinal;
			}
		}
		return {
			items,
			orderGeneration,
			nextPinnedScope,
			nextCursor:
				nextPinnedScope !== null
					? Buffer.from(
							JSON.stringify({
								version: 1,
								kind: "pinned",
								storeId: this.#storeId,
								generation: orderGeneration,
								after: pageAfter,
							}),
						).toString("base64url")
					: null,
		};
	}
}
