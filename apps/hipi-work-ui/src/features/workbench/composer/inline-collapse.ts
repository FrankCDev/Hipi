export type InlineControlPresentation = { hideLabel: boolean; hideControl: boolean };
export type InlineControlSize = { expanded?: number; compact?: number };
export type InlineControlPolicy = { id: string; canHideLabel: boolean; canHideControl: boolean };
export type InlineControlPresentations = Record<string, InlineControlPresentation>;

/** Priority is caller order: collapse labels, measure that rendering, then remove whole controls. */
export function resolveInlineControls({
	availableWidth,
	gap,
	items,
	sizes,
	previous,
}: {
	availableWidth: number | null;
	gap: number;
	items: readonly InlineControlPolicy[];
	sizes: ReadonlyMap<string, InlineControlSize>;
	previous: InlineControlPresentations;
}): InlineControlPresentations {
	const next = Object.fromEntries(items.map(({ id }) => [id, { hideLabel: false, hideControl: false }]));
	if (availableWidth === null) return next;
	const measured = items.map((item) => {
		const size = sizes.get(item.id);
		const expanded = size?.expanded ?? size?.compact ?? 0;
		return { item, expanded, compact: Math.min(expanded, size?.compact ?? expanded), measuredCompact: !!size?.compact };
	});
	// Do not mistake a not-yet-laid-out or transient control for a zero-width control.
	if (measured.some(({ expanded }) => expanded <= 0)) return previous;
	let width = measured.reduce((sum, { expanded }) => sum + expanded, 0) + gap * Math.max(0, items.length - 1);
	for (const { item, expanded, compact } of measured) {
		if (width > availableWidth && item.canHideLabel) {
			next[item.id] = { hideLabel: true, hideControl: false };
			width -= expanded - compact;
		}
	}
	if (items.some(({ id }) => next[id]?.hideLabel !== (previous[id]?.hideLabel ?? false))) return next;
	if (measured.some(({ item, measuredCompact }) => next[item.id]?.hideLabel && !measuredCompact)) return next;
	let remaining = measured.length;
	for (const { item, expanded, compact } of measured) {
		if (width <= availableWidth || !item.canHideControl) continue;
		const presentation = next[item.id];
		if (!presentation) continue;
		presentation.hideControl = true;
		width -= (presentation.hideLabel ? compact : expanded) + (remaining > 1 ? gap : 0);
		remaining--;
	}
	return next;
}

export function sameInlinePresentation(left: InlineControlPresentations, right: InlineControlPresentations) {
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) => left[key]?.hideLabel === right[key]?.hideLabel && left[key]?.hideControl === right[key]?.hideControl,
		)
	);
}
