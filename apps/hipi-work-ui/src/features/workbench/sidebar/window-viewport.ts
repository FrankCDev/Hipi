import type { Scope } from "@hipi/work-runtime/contracts";
export type ViewportAnchor = { scope: Scope; offset: number; element: HTMLElement };
export function captureWindowAnchor(
	region: HTMLElement | null,
	scrollport: HTMLElement | null,
): ViewportAnchor | undefined {
	return captureWindowAnchors(region, scrollport)[0];
}

/** Only currently painted rows can supply measured replacement neighbors. */
export function captureWindowAnchors(region: HTMLElement | null, scrollport: HTMLElement | null): ViewportAnchor[] {
	if (!region || !scrollport) return [];
	const box = scrollport.getBoundingClientRect();
	const anchors: ViewportAnchor[] = [];
	for (const row of Array.from(region.querySelectorAll<HTMLElement>("[data-window-row]"))) {
		const bounds = row.getBoundingClientRect();
		if (bounds.bottom <= box.top || bounds.top >= box.bottom || !row.dataset.workspaceId || !row.dataset.conversationId)
			continue;
		anchors.push({
			scope: { workspaceId: row.dataset.workspaceId, conversationId: row.dataset.conversationId },
			offset: bounds.top - box.top,
			element: row,
		});
		if (anchors.length === 3) break;
	}
	return anchors;
}
export function restoreWindowAnchor(
	anchor: ViewportAnchor | undefined,
	region: HTMLElement | null,
	scrollport: HTMLElement | null,
) {
	if (!anchor || !region || !scrollport) return;
	const row = Array.from(region.querySelectorAll<HTMLElement>("[data-window-row]")).find(
		(item) =>
			item.dataset.workspaceId === anchor.scope.workspaceId &&
			item.dataset.conversationId === anchor.scope.conversationId,
	);
	if (row)
		scrollport.scrollTop += row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - anchor.offset;
}
