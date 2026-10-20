import type { SQLInputValue } from "node:sqlite";
import { NAVIGATION_LIMITS } from "./contracts.ts";

/** Cursor retains semantic recency (-1 means unknown); SQL uses the generated ascending key. */
export type NavigationPosition = [number, string, number, string];

/** Membership is the bounded driving index, independent of sidebar pin exclusions and recency. */
export const PROJECT_SUMMARY_CANDIDATES =
	"SELECT m.workspace_id,m.conversation_id,n.conversation FROM project_memberships m INDEXED BY project_membership_scope LEFT JOIN navigation_sources n ON n.cycle=? AND n.workspace_id=m.workspace_id AND n.public_id=m.conversation_id WHERE m.project_id=? ORDER BY m.workspace_id,m.conversation_id LIMIT ?";

export function navigationQuery(
	cycle: string,
	workspaceId?: string,
	after?: NavigationPosition,
	includeMembership = false,
): { sql: string; params: SQLInputValue[] } {
	const scoped = workspaceId !== undefined;
	const suffix = scoped ? "n.ordinal,n.public_id" : "n.workspace_id,n.ordinal,n.public_id";
	// Filter logical membership after this bounded window. A SQL project predicate could
	// traverse the entire navigation index before finding enough sparse project members.
	const membershipColumns = includeMembership
		? ",m.project_id AS membership_project_id,m.revision AS membership_revision,j.status AS membership_project_status,q.pinned AS membership_project_pinned"
		: "";
	const membershipJoin = includeMembership
		? " LEFT JOIN project_memberships m ON m.workspace_id=n.workspace_id AND m.conversation_id=n.public_id LEFT JOIN projects j ON j.project_id=m.project_id LEFT JOIN project_presentations q ON q.project_id=m.project_id"
		: "";
	return {
		sql: `SELECT n.*,p.pin_ordinal${membershipColumns} FROM navigation_sources n INDEXED BY ${scoped ? "navigation_workspace" : "navigation_recent"} LEFT JOIN conversation_presentations p ON p.workspace_id=n.workspace_id AND p.public_id=n.public_id${membershipJoin} WHERE n.cycle=? ${scoped ? "AND n.workspace_id=?" : ""} ${after ? `AND (n.recency_key,${suffix})>(${scoped ? "?,?,?" : "?,?,?,?"})` : ""} ORDER BY n.recency_key,${suffix} LIMIT ?`,
		params: [
			cycle,
			...(scoped ? [workspaceId] : []),
			...(after ? [-after[0], ...(scoped ? [] : [after[1]]), after[2], after[3]] : []),
			NAVIGATION_LIMITS.candidates + 1,
		],
	};
}
