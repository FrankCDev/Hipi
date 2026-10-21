import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { AppError, type ConversationFilter, parseResult, type Scope } from "../contracts.ts";
import { type ConversationMembership, parseConversationMembership } from "../projects/contracts.ts";
import {
	type ActivityBasis,
	NAVIGATION_LIMITS,
	type SidebarConversation,
	type SidebarCoverage,
	type SidebarPage,
	type SidebarView,
	type SidebarWindowRequest,
	type SidebarWindowResult,
} from "./contracts.ts";
import { decodeNavigationCursor, encodeNavigationCursor } from "./cursor.ts";
import {
	type NavigationDirection,
	type NavigationPosition,
	navigationIdentityQuery,
	navigationQuery,
} from "./query.ts";

type Row = Record<string, SQLOutputValue>;
type Input = { view: SidebarView; filter?: ConversationFilter };
type Window = Extract<SidebarWindowResult, { kind: "window" }>;
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	return value;
}
function position(row: Row): NavigationPosition {
	return [
		row.recency_at === null ? -1 : integer(row.recency_at),
		String(row.workspace_id),
		integer(row.ordinal),
		String(row.public_id),
	];
}
function scopeKey(scope: Scope) {
	return JSON.stringify([scope.workspaceId, scope.conversationId]);
}
/** Compare the actual SQLite BINARY tuple, never locale-dependent labels or guessed tie order. */
function compare(left: NavigationPosition, right: NavigationPosition): number {
	if (left[0] !== right[0]) return left[0] > right[0] ? -1 : 1;
	for (const index of [1, 2, 3] as const) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	return 0;
}

/** One synchronous published-snapshot read. No scheduling, durable reads, or retained cache. */
export class NavigationReader {
	readonly #db: DatabaseSync;
	readonly #storeId: string;
	readonly #input: Input;
	readonly #cycle: string | null;
	readonly #logical: boolean;
	readonly #query: string;
	readonly coverage: SidebarCoverage;
	constructor(db: DatabaseSync, storeId: string, input: Input, cycle: string | null, coverage: SidebarCoverage) {
		this.#db = db;
		this.#storeId = storeId;
		this.#input = input;
		this.#cycle = cycle;
		this.#logical = input.view.kind === "project" || input.view.kind === "project_recent";
		this.coverage = coverage;
		if (this.#logical) {
			const catalog = db
				.prepare("SELECT state,membership_generation FROM project_catalog_state WHERE singleton=1")
				.get();
			if (catalog?.state !== "ready") throw new AppError("INDEX_RECOVERY_REQUIRED");
			this.coverage = {
				...coverage,
				projectMembershipGeneration: integer(catalog.membership_generation),
				projectOrderGeneration: integer(
					db.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1").get()
						?.order_generation,
				),
			};
			if (
				input.view.kind === "project" &&
				input.view.projectId !== null &&
				!db.prepare("SELECT 1 FROM projects WHERE project_id=? AND status='ready'").get(input.view.projectId)
			)
				throw new AppError("NOT_FOUND");
		}
		this.#query = JSON.stringify([
			input.view.kind,
			input.view.kind === "workspace"
				? input.view.workspaceId
				: input.view.kind === "project"
					? input.view.projectId
					: null,
			input.filter ?? "active",
			"activity-source-order-v1",
		]);
	}
	#cursor(boundary: NavigationPosition, direction?: NavigationDirection) {
		return encodeNavigationCursor({
			v: 1,
			kind: direction ? "navigation-window" : "navigation-page",
			storeId: this.#storeId,
			query: this.#query,
			generation: this.coverage.generation,
			membership: this.coverage.membershipGeneration,
			...(this.#logical
				? {
						projectMembership: this.coverage.projectMembershipGeneration,
						projectOrderGeneration: this.coverage.projectOrderGeneration,
					}
				: {}),
			...(direction ? { direction, boundary } : { after: boundary }),
		});
	}
	#decode(raw: string, window: boolean) {
		const p = decodeNavigationCursor(raw, [
			"v",
			"kind",
			"storeId",
			"query",
			"generation",
			"membership",
			...(this.#logical ? ["projectMembership", "projectOrderGeneration"] : []),
			...(window ? ["direction", "boundary"] : ["after"]),
		]);
		const boundary = window ? p.boundary : p.after;
		if (
			p.v !== 1 ||
			p.kind !== (window ? "navigation-window" : "navigation-page") ||
			p.storeId !== this.#storeId ||
			p.query !== this.#query ||
			typeof p.generation !== "string" ||
			!Number.isSafeInteger(p.membership) ||
			Number(p.membership) < 0 ||
			(this.#logical &&
				(!Number.isSafeInteger(p.projectMembership) ||
					Number(p.projectMembership) < 0 ||
					!Number.isSafeInteger(p.projectOrderGeneration) ||
					Number(p.projectOrderGeneration) < 0)) ||
			(window && p.direction !== "previous" && p.direction !== "next") ||
			!Array.isArray(boundary) ||
			boundary.length !== 4 ||
			!Number.isSafeInteger(boundary[0]) ||
			boundary[0] < -1 ||
			typeof boundary[1] !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(boundary[1]) ||
			!Number.isSafeInteger(boundary[2]) ||
			boundary[2] < 0 ||
			typeof boundary[3] !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(boundary[3])
		)
			throw new AppError("INVALID_REQUEST");
		if (
			this.#cycle === null ||
			p.generation !== this.coverage.generation ||
			p.membership !== this.coverage.membershipGeneration ||
			p.projectMembership !== this.coverage.projectMembershipGeneration ||
			p.projectOrderGeneration !== this.coverage.projectOrderGeneration
		)
			throw new AppError("CURSOR_STALE");
		const key = boundary as NavigationPosition;
		if (this.#input.view.kind === "workspace" && key[1] !== this.#input.view.workspaceId)
			throw new AppError("INVALID_REQUEST");
		const row = this.#point({ workspaceId: key[1], conversationId: key[3] });
		if (!row || row.ordinal !== key[2] || (row.recency_at ?? -1) !== key[0]) throw new AppError("INVALID_REQUEST");
		return {
			boundary: key,
			row,
			direction: window && p.direction === "previous" ? ("previous" as const) : ("next" as const),
		};
	}
	#point(scope: Scope): Row | undefined {
		if (this.#cycle === null) return undefined;
		const query = navigationIdentityQuery(this.#cycle, scope, this.#logical);
		return this.#db.prepare(query.sql).get(...query.params);
	}
	#eligible(row: Row): SidebarConversation | null {
		const conversation = parseResult("getConversation", JSON.parse(String(row.conversation)));
		let membership: ConversationMembership | undefined;
		if (this.#logical) {
			try {
				membership = parseConversationMembership({
					workspaceId: conversation.workspaceId,
					conversationId: conversation.conversationId,
					projectId: row.membership_project_id,
					revision: row.membership_revision,
				});
			} catch {
				throw new AppError("INDEX_RECOVERY_REQUIRED");
			}
			if (membership.projectId !== null && row.membership_project_status !== "ready")
				throw new AppError("INDEX_RECOVERY_REQUIRED");
			if (this.#input.view.kind === "project" && membership.projectId !== this.#input.view.projectId) return null;
			if (this.#input.view.kind === "project_recent" && row.membership_project_pinned === 1) return null;
		}
		if (this.#input.view.kind === "workspace" && conversation.workspaceId !== this.#input.view.workspaceId)
			return null;
		const filter = this.#input.filter ?? "active";
		// Archive state is authoritative even before obsolete pin metadata is cleaned up.
		if (conversation.archivedAt === null && row.pin_ordinal !== null && row.pin_ordinal !== undefined) return null;
		if (filter !== "all" && (conversation.archivedAt !== null) !== (filter === "archived")) return null;
		return {
			conversation,
			...(membership === undefined ? {} : { membership }),
			recencyAt: row.recency_at === null ? null : integer(row.recency_at),
			activityBasis: row.basis as ActivityBasis,
		};
	}
	#scan(boundary: NavigationPosition | undefined, direction: NavigationDirection, limit: number, outputLimit: number) {
		if (this.#cycle === null) throw new AppError("INDEX_RECOVERY_REQUIRED");
		const query = navigationQuery(
			this.#cycle,
			this.#input.view.kind === "workspace" ? this.#input.view.workspaceId : undefined,
			boundary,
			this.#logical,
			direction,
			limit,
		);
		const rows = this.#db.prepare(query.sql).all(...query.params);
		const items: SidebarConversation[] = [];
		let consumed = 0;
		for (const row of rows.slice(0, limit - 1)) {
			consumed++;
			const item = this.#eligible(row);
			if (item) items.push(item);
			if (items.length === outputLimit) break;
		}
		const first = rows[0],
			last = rows[consumed - 1];
		return {
			items: direction === "previous" ? items.reverse() : items,
			hasMore: rows.length > consumed,
			first: first && consumed ? position(first) : undefined,
			last: last ? position(last) : undefined,
			rawCount: rows.length,
		};
	}
	list(cursor?: string): SidebarPage {
		const after = cursor ? this.#decode(cursor, false).boundary : undefined;
		if (this.#cycle === null) return { items: [], coverage: this.coverage, nextCursor: null };
		const scan = this.#scan(after, "next", NAVIGATION_LIMITS.candidates + 1, NAVIGATION_LIMITS.page);
		return {
			items: scan.items,
			coverage: this.coverage,
			nextCursor: scan.hasMore && scan.last ? this.#cursor(scan.last) : null,
		};
	}
	window(input: SidebarWindowRequest): SidebarWindowResult {
		const continuation = input.position.kind === "continue" ? this.#decode(input.position.cursor, true) : undefined;
		if (this.#cycle === null) return { kind: "unpublished", coverage: this.coverage };
		const points = new Map<string, Row | undefined>();
		let anchor: Row | undefined,
			anchorItem: SidebarConversation | null = null;
		if (continuation)
			points.set(
				scopeKey({ workspaceId: continuation.boundary[1], conversationId: continuation.boundary[3] }),
				continuation.row,
			);
		if (input.position.kind === "around") {
			anchor = this.#point(input.position.anchor);
			if (!anchor)
				return {
					kind: "anchor_unavailable",
					coverage: this.coverage,
					anchor: input.position.anchor,
					reason: "missing",
				};
			anchorItem = this.#eligible(anchor);
			if (!anchorItem)
				return {
					kind: "anchor_unavailable",
					coverage: this.coverage,
					anchor: input.position.anchor,
					reason: "ineligible",
				};
			points.set(scopeKey(input.position.anchor), anchor);
		}
		const retainedScopes = [
			...new Map((input.retainedScopes ?? []).map((scope) => [scopeKey(scope), scope])).values(),
		];
		let reserved = 0;
		for (const scope of retainedScopes) {
			const key = scopeKey(scope);
			if (!points.has(key)) {
				points.set(key, this.#point(scope));
				reserved++;
			}
		}
		let items: SidebarConversation[], low: NavigationPosition | undefined, high: NavigationPosition | undefined;
		let previousCursor: string | null, nextCursor: string | null;
		if (anchor && anchorItem) {
			const at = position(anchor);
			const before = this.#scan(at, "previous", 63 - Math.floor(reserved / 2), 24);
			const after = this.#scan(at, "next", 64 - Math.ceil(reserved / 2), 25);
			items = [...before.items, anchorItem, ...after.items];
			low = before.last ?? at;
			high = after.last ?? at;
			previousCursor = before.hasMore ? this.#cursor(low, "previous") : null;
			nextCursor = after.hasMore ? this.#cursor(high, "next") : null;
		} else {
			const direction = continuation?.direction ?? "next";
			const scan = this.#scan(
				continuation?.boundary,
				direction,
				NAVIGATION_LIMITS.candidates - reserved - (continuation ? 1 : 0),
				NAVIGATION_LIMITS.page,
			);
			// Every emitted continuation has a witnessed candidate. A fabricated terminal
			// cursor has no consumed interval and cannot support truthful retained placement.
			if (continuation && scan.rawCount === 0) throw new AppError("INVALID_REQUEST");
			items = scan.items;
			low = direction === "next" ? scan.first : scan.last;
			high = direction === "next" ? scan.last : scan.first;
			previousCursor =
				low && (direction === "previous" ? scan.hasMore : !!continuation) ? this.#cursor(low, "previous") : null;
			nextCursor =
				high && (direction === "next" ? scan.hasMore : !!continuation) ? this.#cursor(high, "next") : null;
		}
		const eligible: {
			row: SidebarConversation;
			placement: "before" | "inside" | "after";
			position: NavigationPosition;
		}[] = [];
		const unavailable: Window["retained"]["unavailable"] = [];
		for (const scope of retainedScopes) {
			const row = points.get(scopeKey(scope));
			const item = row ? this.#eligible(row) : null;
			if (!row || !item) {
				unavailable.push({ scope, reason: row ? "ineligible" : "missing" });
				continue;
			}
			if (!low || !high) throw new AppError("INDEX_RECOVERY_REQUIRED");
			const at = position(row);
			eligible.push({
				row: item,
				placement: compare(at, low) < 0 ? "before" : compare(at, high) > 0 ? "after" : "inside",
				position: at,
			});
		}
		eligible.sort((left, right) => compare(left.position, right.position));
		return {
			kind: "window",
			coverage: this.coverage,
			items,
			previousCursor,
			nextCursor,
			retained: { eligible: eligible.map(({ row, placement }) => ({ row, placement })), unavailable },
		};
	}
}
