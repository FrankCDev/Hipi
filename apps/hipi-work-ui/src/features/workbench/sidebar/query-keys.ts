import type { ConversationFilter, SidebarView } from "@hipi/work-runtime/contracts";
import type { QueryKey } from "@tanstack/react-query";

type NavigationWindowKey = readonly ["sidebar-navigation" | "sidebar-window", SidebarView, ConversationFilter];
type ProjectSummaryKey = readonly ["sidebar-navigation", "project-summary", string, "all"];

/** A shared invalidation prefix is not a shared cache data shape. */
export function isNavigationWindowKey(key: QueryKey): key is NavigationWindowKey {
	if (key.length !== 3 || (key[0] !== "sidebar-navigation" && key[0] !== "sidebar-window")) return false;
	const [, view, filter] = key;
	if (filter !== "active" && filter !== "archived" && filter !== "all") return false;
	if (!view || typeof view !== "object" || !("kind" in view)) return false;
	return (
		view.kind === "recent" ||
		view.kind === "project_recent" ||
		(view.kind === "workspace" && "workspaceId" in view && typeof view.workspaceId === "string") ||
		(view.kind === "project" && "projectId" in view && typeof view.projectId === "string")
	);
}

export const projectSummaryKey = (projectId: string): ProjectSummaryKey =>
	["sidebar-navigation", "project-summary", projectId, "all"] as const;

export function isProjectSummaryKey(key: QueryKey): key is ProjectSummaryKey {
	return (
		key.length === 4 &&
		key[0] === "sidebar-navigation" &&
		key[1] === "project-summary" &&
		typeof key[2] === "string" &&
		key[3] === "all"
	);
}
