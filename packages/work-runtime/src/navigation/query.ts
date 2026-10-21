import type { SQLInputValue } from "node:sqlite";
import type { Scope } from "../contracts.ts";
import { NAVIGATION_LIMITS } from "./contracts.ts";

/** Cursor retains semantic recency (-1 means unknown); SQL uses the generated ascending key. */
export type NavigationPosition = [number, string, number, string];
export type NavigationDirection = "previous" | "next";

/** Membership is the bounded driving index, independent of sidebar pin exclusions and recency. */
export const PROJECT_SUMMARY_CANDIDATES =
	"SELECT m.workspace_id,m.conversation_id,n.conversation FROM project_memberships m INDEXED BY project_membership_scope LEFT JOIN navigation_sources n ON n.cycle=? AND n.workspace_id=m.workspace_id AND n.public_id=m.conversation_id WHERE m.project_id=? ORDER BY m.workspace_id,m.conversation_id LIMIT ?";

function navigationSelect(includeMembership: boolean, index?: string) {
	const columns = includeMembership
		? ",m.project_id AS membership_project_id,m.revision AS membership_revision,j.status AS membership_project_status,q.pinned AS membership_project_pinned"
		: "";
	const joins = includeMembership
		? " LEFT JOIN project_memberships m ON m.workspace_id=n.workspace_id AND m.conversation_id=n.public_id LEFT JOIN projects j ON j.project_id=m.project_id LEFT JOIN project_presentations q ON q.project_id=m.project_id"
		: "";
	return `SELECT n.*,p.pin_ordinal${columns} FROM navigation_sources n ${index ? `INDEXED BY ${index}` : ""} LEFT JOIN conversation_presentations p ON p.workspace_id=n.workspace_id AND p.public_id=n.public_id${joins}`;
}

export function navigationQuery(
	cycle: string,
	workspaceId?: string,
	after?: NavigationPosition,
	includeMembership = false,
	direction: NavigationDirection = "next",
	limit: number = NAVIGATION_LIMITS.candidates + 1,
): { sql: string; params: SQLInputValue[] } {
	const scoped = workspaceId !== undefined;
	const suffix = scoped ? "n.ordinal,n.public_id" : "n.workspace_id,n.ordinal,n.public_id";
	const columns = `n.recency_key,${suffix}`;
	const reverse = direction === "previous";
	// Eligibility stays after this bounded index window: sparse logical projects
	// must not turn a LIMIT on matched rows into an unbounded source traversal.
	return {
		sql: `${navigationSelect(includeMembership, scoped ? "navigation_workspace" : "navigation_recent")} WHERE n.cycle=? ${scoped ? "AND n.workspace_id=?" : ""} ${after ? `AND (${columns})${reverse ? "<" : ">"}(${scoped ? "?,?,?" : "?,?,?,?"})` : ""} ORDER BY ${
			reverse
				? columns
						.split(",")
						.map((column) => `${column} DESC`)
						.join(",")
				: columns
		} LIMIT ?`,
		params: [
			cycle,
			...(scoped ? [workspaceId] : []),
			...(after ? [-after[0], ...(scoped ? [] : [after[1]]), after[2], after[3]] : []),
			limit,
		],
	};
}

/** Resolves canonical identity through the publication's primary key, not recency scanning. */
export function navigationIdentityQuery(cycle: string, scope: Scope, includeMembership: boolean) {
	return {
		sql: `${navigationSelect(includeMembership)} WHERE n.cycle=? AND n.workspace_id=? AND n.public_id=?`,
		params: [cycle, scope.workspaceId, scope.conversationId],
	};
}
