export type SidebarLocation =
	| { readonly kind: "pinned" }
	| { readonly kind: "recent" }
	| { readonly kind: "project"; readonly projectId: string }
	| { readonly kind: "workspace"; readonly workspaceId: string };

export type SidebarAliasCandidate = {
	readonly id: string;
	readonly location: SidebarLocation;
	readonly eligible: boolean;
};

export function sidebarLocationsEqual(left: SidebarLocation, right: SidebarLocation): boolean {
	if (left.kind === "project") return right.kind === "project" && left.projectId === right.projectId;
	if (left.kind === "workspace") return right.kind === "workspace" && left.workspaceId === right.workspaceId;
	return left.kind === right.kind;
}

/**
 * Candidates belong to one canonical Scope and arrive in actual DOM order.
 * A hidden preferred location remains preferred when its alias becomes eligible again.
 */
export function resolveSidebarAlias(
	candidates: readonly SidebarAliasCandidate[],
	preferredLocation: SidebarLocation | null,
	previousId: string | null,
): string | null {
	const preferred = preferredLocation
		? candidates.find((candidate) => candidate.eligible && sidebarLocationsEqual(candidate.location, preferredLocation))
		: undefined;
	const eligible = preferred ?? candidates.find((candidate) => candidate.eligible);
	if (eligible) return eligible.id;
	return previousId !== null && candidates.some((candidate) => candidate.id === previousId) ? previousId : null;
}
