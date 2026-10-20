export type SidebarDragGroup = "sections" | "projects" | "pinned";
export type SidebarPoint = { x: number; y: number };
export type SidebarRect = { left: number; right: number; top: number; bottom: number };
export type SidebarDragItem = {
	id: string;
	group: SidebarDragGroup;
	label: string;
	/** Changes when the authoritative order or its admission state changes. */
	revision: string;
	disabled: boolean;
	after: string | null;
	move: (before: string | null) => void;
};
export type SidebarDrop = { id: string; edge: "before" | "after"; before: string | null };
export type SidebarDropCandidate = { item: SidebarDragItem; rect: SidebarRect };
export type SidebarDragState = {
	source: SidebarDragItem | null;
	point: SidebarPoint | null;
	drop: SidebarDrop | null;
};

/** Canonical placement policy only; dnd-kit owns the drag engine and measurements. */
export function sidebarDrop(
	source: SidebarDragItem,
	point: SidebarPoint,
	candidates: SidebarDropCandidate[],
	bounds?: SidebarRect,
): SidebarDrop | null {
	if (bounds && !insideSidebar(point, bounds)) return null;
	for (const { item, rect } of candidates) {
		if (
			item.group !== source.group ||
			item.disabled ||
			point.x < rect.left ||
			point.x > rect.right ||
			point.y < rect.top ||
			point.y > rect.bottom
		)
			continue;
		const edge = point.y < (rect.top + rect.bottom) / 2 ? "before" : "after";
		const before = edge === "before" ? item.id : item.after;
		if (before === source.id || before === source.after) return null;
		return { id: item.id, edge, before };
	}
	return null;
}

export function insideSidebar(point: SidebarPoint, rect: SidebarRect): boolean {
	return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}
