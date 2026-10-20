/** Presentation only: loaded pages and canonical arrangement remain untouched. */
export function visibleSidebarProjects(ids: readonly string[], expanded: boolean, current: string, hasMore: boolean) {
	if (expanded) return [...ids];
	const visible = ids.slice(0, 5);
	if (ids.includes(current) && !visible.includes(current)) visible.push(current);
	// Do not show a disclosure merely to hide the one remaining known item.
	return !hasMore && ids.length - visible.length === 1 ? [...ids] : visible;
}
