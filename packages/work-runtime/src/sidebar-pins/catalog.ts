import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError, type Conversation, type ConversationPresentation, type Scope } from "../contracts.ts";
import type { ConversationMembership, Project, ProjectPresentation } from "../projects/contracts.ts";
import {
	type PinKey,
	parseSidebarPinParams,
	parseSidebarPinResult,
	type SidebarPinMethods,
	type SidebarPinRequest,
	type SidebarPinResponse,
	sidebarPinCommandPayload,
} from "./contracts.ts";

type Ports = {
	getProject(projectId: string): Project;
	getProjectPresentation(projectId: string): ProjectPresentation;
	getConversation(scope: Scope): Promise<Conversation>;
	recordArchive(conversation: Conversation): void;
	getConversationPresentation(scope: Scope): ConversationPresentation;
	getMembership(scope: Scope): ConversationMembership;
};
export type SidebarPinFailpoint = "after_read" | "after_commit";
export const SIDEBAR_PIN_CANDIDATES =
	"SELECT kind,project_id,workspace_id,conversation_id,ordinal FROM sidebar_pin_order WHERE ordinal>? ORDER BY ordinal LIMIT ?";
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("STORE_MISMATCH");
	return value;
}
function next(value: unknown): number {
	const n = integer(value) + 1;
	if (!Number.isSafeInteger(n)) throw new AppError("CAPACITY_EXCEEDED");
	return n;
}
function key(row: Record<string, unknown>): PinKey {
	return row.kind === "project"
		? { kind: "project", projectId: String(row.project_id) }
		: { kind: "conversation", workspaceId: String(row.workspace_id), conversationId: String(row.conversation_id) };
}
/** Single synchronous root-catalog order authority. Call changed/reorderInside only inside the caller's transaction. */
export class SidebarPins {
	readonly #db: DatabaseSync;
	readonly #storeId: string;
	readonly #ports: Ports;
	readonly #failpoint?: (point: SidebarPinFailpoint) => void | Promise<void>;
	constructor(
		db: DatabaseSync,
		storeId: string,
		ports: Ports,
		failpoint?: (point: SidebarPinFailpoint) => void | Promise<void>,
	) {
		this.#db = db;
		this.#storeId = storeId;
		this.#ports = ports;
		this.#failpoint = failpoint;
	}
	#state() {
		const row = this.#db.prepare("SELECT order_revision,next_ordinal FROM sidebar_pin_state WHERE singleton=1").get();
		if (!row) throw new AppError("STORE_MISMATCH");
		return { orderRevision: integer(row.order_revision), nextOrdinal: integer(row.next_ordinal) };
	}
	#row(value: PinKey) {
		return value.kind === "project"
			? this.#db
					.prepare("SELECT rowid,ordinal FROM sidebar_pin_order WHERE kind='project' AND project_id=?")
					.get(value.projectId)
			: this.#db
					.prepare(
						"SELECT rowid,ordinal FROM sidebar_pin_order WHERE kind='conversation' AND workspace_id=? AND conversation_id=?",
					)
					.get(value.workspaceId, value.conversationId);
	}
	#advance(owner?: PinKey["kind"]): number {
		const revision = next(this.#state().orderRevision);
		this.#db.prepare("UPDATE sidebar_pin_state SET order_revision=? WHERE singleton=1").run(revision);
		// The calling membership owner has already advanced its own legacy order fence.
		if (owner !== "conversation") {
			const row = this.#db.prepare("SELECT order_generation FROM presentation_state WHERE singleton=1").get();
			this.#db
				.prepare("UPDATE presentation_state SET order_generation=? WHERE singleton=1")
				.run(next(row?.order_generation));
		}
		if (owner !== "project") {
			const row = this.#db
				.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1")
				.get();
			this.#db
				.prepare("UPDATE project_presentation_state SET order_generation=? WHERE singleton=1")
				.run(next(row?.order_generation));
		}
		return revision;
	}
	changed(value: PinKey, pinned: boolean): void {
		const prior = this.#row(value);
		if (pinned) {
			if (prior) throw new AppError("STORE_MISMATCH");
			const ordinal = next(this.#state().nextOrdinal);
			this.#db
				.prepare("INSERT INTO sidebar_pin_order VALUES (?,?,?,?,?)")
				.run(
					value.kind,
					value.kind === "project" ? value.projectId : null,
					value.kind === "conversation" ? value.workspaceId : null,
					value.kind === "conversation" ? value.conversationId : null,
					ordinal,
				);
			this.#db.prepare("UPDATE sidebar_pin_state SET next_ordinal=? WHERE singleton=1").run(ordinal);
		} else {
			if (!prior) throw new AppError("STORE_MISMATCH");
			this.#db.prepare("DELETE FROM sidebar_pin_order WHERE rowid=?").run(prior.rowid);
		}
		this.#advance(value.kind);
	}
	reorderInside(moved: PinKey, before: PinKey | null): number {
		const fromRow = this.#row(moved),
			anchor = before ? this.#row(before) : null;
		if (!fromRow || (before && !anchor)) throw new AppError("IDEMPOTENCY_CONFLICT");
		const from = integer(fromRow.ordinal),
			beforeOrdinal = anchor ? integer(anchor.ordinal) : null;
		if (beforeOrdinal === from) return this.#state().orderRevision;
		const to =
			beforeOrdinal !== null && beforeOrdinal < from
				? beforeOrdinal
				: integer(
						this.#db
							.prepare(
								`SELECT max(ordinal) AS ordinal FROM sidebar_pin_order ${beforeOrdinal === null ? "" : "WHERE ordinal<?"}`,
							)
							.get(...(beforeOrdinal === null ? [] : [beforeOrdinal]))?.ordinal,
					);
		if (to === from) return this.#state().orderRevision;
		const low = Math.min(from, to),
			high = Math.max(from, to);
		this.#db
			.prepare(
				`WITH positions AS MATERIALIZED (SELECT rowid,CASE WHEN ordinal=? THEN ? ELSE ${to < from ? "lead" : "lag"}(ordinal) OVER (ORDER BY ordinal) END AS target FROM sidebar_pin_order WHERE ordinal BETWEEN ? AND ?) UPDATE sidebar_pin_order SET ordinal=-(SELECT target FROM positions WHERE positions.rowid=sidebar_pin_order.rowid) WHERE ordinal BETWEEN ? AND ?`,
			)
			.run(from, to, low, high, low, high);
		this.#db.prepare("UPDATE sidebar_pin_order SET ordinal=-ordinal WHERE ordinal BETWEEN ? AND ?").run(-high, -low);
		// Only the moved kind's relative subsequence can change. Reuse its existing ordinal slots,
		// rather than copying mixed ordinals into the legacy nextOrdinal/generation domain.
		const project = moved.kind === "project",
			table = project ? "project_presentations" : "conversation_presentations";
		const join = project
			? "p.project_id=o.project_id"
			: "p.workspace_id=o.workspace_id AND p.public_id=o.conversation_id";
		this.#db
			.prepare(
				`WITH affected AS MATERIALIZED (SELECT p.rowid AS id,p.pin_ordinal AS slot,o.ordinal FROM sidebar_pin_order o JOIN ${table} p ON ${join} WHERE o.kind=? AND o.ordinal BETWEEN ? AND ?), ordered AS (SELECT id,row_number() OVER (ORDER BY ordinal) AS rank FROM affected), slots AS (SELECT slot,row_number() OVER (ORDER BY slot) AS rank FROM affected), targets AS MATERIALIZED (SELECT ordered.id,slots.slot FROM ordered JOIN slots USING(rank)) UPDATE ${table} SET pin_ordinal=-(SELECT slot FROM targets WHERE targets.id=${table}.rowid) WHERE rowid IN (SELECT id FROM targets)`,
			)
			.run(moved.kind, low, high);
		this.#db.exec(`UPDATE ${table} SET pin_ordinal=-pin_ordinal WHERE pin_ordinal<0`);
		return this.#advance();
	}
	#receipt(requestId: string) {
		const row = this.#db.prepare("SELECT params,result FROM sidebar_pin_commands WHERE request_id=?").get(requestId);
		return row
			? parseSidebarPinResult("getSidebarPinCommandResult", {
					method: "reorderSidebarPin",
					params: JSON.parse(String(row.params)),
					result: JSON.parse(String(row.result)),
				})
			: null;
	}
	async #verify(value: PinKey): Promise<void> {
		if (value.kind === "project") {
			this.#ports.getProject(value.projectId);
			return;
		}
		const conversation = await this.#ports.getConversation(value);
		this.#ports.recordArchive(conversation);
		if (conversation.archivedAt !== null) throw new AppError("CONVERSATION_ARCHIVED");
	}
	async execute(request: SidebarPinRequest): Promise<SidebarPinResponse> {
		if (request.method === "getSidebarPinCommandResult") return this.#receipt(request.params.requestId);
		if (request.method === "listSidebarPins") return this.list(request.params);
		const params = parseSidebarPinParams("reorderSidebarPin", request.params),
			payload = sidebarPinCommandPayload("reorderSidebarPin", params);
		const replay = () => {
			const prior = this.#receipt(params.requestId);
			if (prior && sidebarPinCommandPayload(prior.method, prior.params) !== payload)
				throw new AppError("IDEMPOTENCY_CONFLICT");
			return prior?.result;
		};
		const prior = replay();
		if (prior) return prior;
		await this.#verify(params.moved);
		if (params.before) await this.#verify(params.before);
		await this.#failpoint?.("after_read");
		this.#db.exec("BEGIN IMMEDIATE");
		let result: { orderRevision: number };
		try {
			const repeated = replay();
			if (repeated) result = repeated;
			else {
				if (this.#state().orderRevision !== params.expectedOrderRevision)
					throw new AppError("IDEMPOTENCY_CONFLICT");
				result = { orderRevision: this.reorderInside(params.moved, params.before) };
				this.#db
					.prepare("INSERT INTO sidebar_pin_commands VALUES (?,?,?,?)")
					.run(
						params.requestId,
						createHash("sha256").update(payload).digest("hex"),
						JSON.stringify(params),
						JSON.stringify(result),
					);
			}
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
		await this.#failpoint?.("after_commit");
		return result;
	}
	async list(
		input: SidebarPinMethods["listSidebarPins"]["params"],
	): Promise<SidebarPinMethods["listSidebarPins"]["result"]> {
		if (this.#db.prepare("SELECT state FROM project_catalog_state WHERE singleton=1").get()?.state !== "ready")
			throw new AppError("INDEX_RECOVERY_REQUIRED");
		const orderRevision = this.#state().orderRevision;
		let after = 0;
		let direction: "next" | "previous" = "next";
		if (input.cursor) {
			try {
				const value: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
				const c = value as Record<string, unknown>;
				if (
					Object.keys(c).sort().join() !== "after,direction,kind,orderRevision,storeId,version" ||
					c.kind !== "sidebar_pins" ||
					c.version !== 2 ||
					(c.direction !== "next" && c.direction !== "previous") ||
					c.storeId !== this.#storeId
				)
					throw new Error();
				after = integer(c.after);
				direction = c.direction;
				integer(c.orderRevision);
				if (c.orderRevision !== orderRevision) throw new AppError("CURSOR_STALE");
			} catch (error) {
				if (error instanceof AppError && error.code === "CURSOR_STALE") throw error;
				throw new AppError("INVALID_REQUEST");
			}
		}
		const scanned = this.#db
			.prepare(
				direction === "next"
					? SIDEBAR_PIN_CANDIDATES
					: "SELECT kind,project_id,workspace_id,conversation_id,ordinal FROM sidebar_pin_order WHERE ordinal<? ORDER BY ordinal DESC LIMIT ?",
			)
			.all(after, 51);
		const rows = scanned.slice(0, 50);
		if (direction === "previous") rows.reverse();
		const first = rows[0],
			last = rows.at(-1);
		const nextRow = last ? this.#db.prepare(SIDEBAR_PIN_CANDIDATES).get(last.ordinal, 1) : undefined;
		const hasPrevious = first
			? !!this.#db.prepare("SELECT 1 FROM sidebar_pin_order WHERE ordinal<? LIMIT 1").get(first.ordinal)
			: false;
		const items: SidebarPinMethods["listSidebarPins"]["result"]["items"] = [];
		// The forward successor remains verified even while the page itself was read backwards.
		for (const row of nextRow ? [...rows, nextRow] : rows) {
			const value = key(row);
			if (value.kind === "project") {
				items.push({
					kind: "project",
					project: this.#ports.getProject(value.projectId),
					presentation: this.#ports.getProjectPresentation(value.projectId),
				});
			} else {
				const conversation = await this.#ports.getConversation(value);
				this.#ports.recordArchive(conversation);
				if (this.#state().orderRevision !== orderRevision) throw new AppError("CURSOR_STALE");
				items.push({
					kind: "conversation",
					conversation,
					presentation: this.#ports.getConversationPresentation(value),
					membership: this.#ports.getMembership(value),
				});
			}
		}
		if (this.#state().orderRevision !== orderRevision) throw new AppError("CURSOR_STALE");
		if (this.#db.prepare("SELECT state FROM project_catalog_state WHERE singleton=1").get()?.state !== "ready")
			throw new AppError("INDEX_RECOVERY_REQUIRED");
		const encode = (position: unknown, order: "next" | "previous") =>
			Buffer.from(
				JSON.stringify({
					version: 2,
					kind: "sidebar_pins",
					storeId: this.#storeId,
					orderRevision,
					direction: order,
					after: integer(position),
				}),
			).toString("base64url");
		return {
			items: items.slice(0, rows.length),
			orderRevision,
			nextPinKey: nextRow ? key(nextRow) : null,
			nextCursor: nextRow && last ? encode(last.ordinal, "next") : null,
			previousCursor: hasPrevious && first ? encode(first.ordinal, "previous") : null,
		};
	}
}
