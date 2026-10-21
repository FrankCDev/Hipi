import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../contracts.ts";
import { type ProjectPage, type ProjectPresentation, parseProject } from "./contracts.ts";

export const PINNED_PROJECT_CANDIDATES =
	"SELECT s.project_id AS projectId,p.name,p.revision,p.home_workspace_id AS homeWorkspaceId,p.status,s.pin_ordinal AS position,0 AS bucket FROM project_presentations s INDEXED BY project_pin_order LEFT JOIN projects p ON p.project_id=s.project_id WHERE s.pin_ordinal IS NOT NULL AND s.pin_ordinal>? ORDER BY s.pin_ordinal LIMIT ?";
export const UNPINNED_PROJECT_CANDIDATES =
	"SELECT p.project_id AS projectId,p.name,p.revision,p.home_workspace_id AS homeWorkspaceId,p.status,s.pinned,9007199254740991 AS position,1 AS bucket FROM projects p LEFT JOIN project_presentations s ON s.project_id=p.project_id WHERE p.project_id>? ORDER BY p.project_id LIMIT ?";
const PINNED_BEFORE = PINNED_PROJECT_CANDIDATES.replace("s.pin_ordinal>?", "s.pin_ordinal<?").replace(
	"ORDER BY s.pin_ordinal LIMIT",
	"ORDER BY s.pin_ordinal DESC LIMIT",
);
const UNPINNED_BEFORE = UNPINNED_PROJECT_CANDIDATES.replace("p.project_id>?", "p.project_id<?").replace(
	"ORDER BY p.project_id LIMIT",
	"ORDER BY p.project_id DESC LIMIT",
);
type Boundary = [number, string, 0 | 1];
type Direction = "next" | "previous";
const PAGE = 50;
const UNPINNED = Number.MAX_SAFE_INTEGER;

function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("STORE_MISMATCH");
	return value;
}
function boundary(row: Record<string, unknown>): Boundary {
	if (typeof row.projectId !== "string" || (row.bucket !== 0 && row.bucket !== 1))
		throw new AppError("STORE_MISMATCH");
	return [integer(row.position), row.projectId, row.bucket];
}

/** Candidate windows, not visible-row offsets: sparse exclusions remain bounded in both directions. */
export function readProjectWindow(
	db: DatabaseSync,
	storeId: string,
	presentation: (projectId: string) => ProjectPresentation,
	cursor?: string,
): ProjectPage {
	const metadataGeneration = integer(
		db.prepare("SELECT metadata_generation FROM project_catalog_state WHERE singleton=1").get()?.metadata_generation,
	);
	const orderGeneration = integer(
		db.prepare("SELECT order_generation FROM project_presentation_state WHERE singleton=1").get()?.order_generation,
	);
	let after: Boundary | undefined;
	let direction: Direction = "next";
	if (cursor !== undefined) {
		try {
			if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
			const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
			const c = value as Record<string, unknown>;
			if (
				Object.keys(c).sort().join() !== "after,direction,metadataGeneration,orderGeneration,storeId,version" ||
				c.version !== 2 ||
				c.storeId !== storeId ||
				(c.direction !== "next" && c.direction !== "previous") ||
				!Array.isArray(c.after) ||
				c.after.length !== 3 ||
				(c.after[2] !== 0 && c.after[2] !== 1) ||
				typeof c.after[1] !== "string" ||
				!/^([A-Za-z0-9_-]{1,128})?$/.test(c.after[1])
			)
				throw new Error();
			after = [integer(c.after[0]), c.after[1], c.after[2]];
			if (after[2] === 1 && after[0] !== UNPINNED) throw new Error();
			integer(c.metadataGeneration);
			integer(c.orderGeneration);
			if (c.metadataGeneration !== metadataGeneration || c.orderGeneration !== orderGeneration)
				throw new AppError("CURSOR_STALE");
			direction = c.direction;
		} catch (error) {
			if (error instanceof AppError && error.code === "CURSOR_STALE") throw error;
			throw new AppError("INVALID_REQUEST");
		}
	}
	const candidates = (anchor: Boundary | undefined, order: Direction, limit: number) => {
		const rows: Record<string, unknown>[] = [];
		if (order === "next") {
			if (!anchor || anchor[2] === 0)
				rows.push(...db.prepare(PINNED_PROJECT_CANDIDATES).all(anchor?.[0] ?? 0, limit));
			if (rows.length < limit)
				rows.push(
					...db.prepare(UNPINNED_PROJECT_CANDIDATES).all(anchor?.[2] === 1 ? anchor[1] : "", limit - rows.length),
				);
		} else {
			if (anchor?.[2] === 1) rows.push(...db.prepare(UNPINNED_BEFORE).all(anchor[1], limit));
			if (rows.length < limit)
				rows.push(
					...db
						.prepare(PINNED_BEFORE)
						.all(anchor?.[2] === 0 ? anchor[0] : BigInt(UNPINNED) + 1n, limit - rows.length),
				);
		}
		return rows;
	};
	const scanned = candidates(after, direction, PAGE + 1);
	const rows = scanned.slice(0, PAGE);
	if (direction === "previous") rows.reverse();
	const first = rows[0] ? boundary(rows[0]) : after;
	const last = rows.at(-1) ? boundary(rows.at(-1)!) : after;
	const encode = (anchor: Boundary, order: Direction) =>
		Buffer.from(
			JSON.stringify({ version: 2, storeId, metadataGeneration, orderGeneration, direction: order, after: anchor }),
		).toString("base64url");
	const items: ProjectPage["items"] = [];
	for (const row of rows) {
		if (row.status !== "ready" || (row.bucket === 1 && row.pinned === 1)) continue;
		const project = parseProject({
			projectId: row.projectId,
			name: row.name,
			revision: row.revision,
			homeWorkspaceId: row.homeWorkspaceId,
		});
		items.push({ project, presentation: presentation(project.projectId) });
	}
	return {
		items,
		metadataGeneration,
		orderGeneration,
		previousCursor: first && candidates(first, "previous", 1).length ? encode(first, "previous") : null,
		nextCursor: last && candidates(last, "next", 1).length ? encode(last, "next") : null,
	};
}
