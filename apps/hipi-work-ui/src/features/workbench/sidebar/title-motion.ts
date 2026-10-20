export type SidebarTitleMotion = {
	direction: "ltr" | "rtl";
	distancePx: number;
	offsetPx: number;
	delayMs: number;
	durationMs: number;
	totalDurationMs: number;
};

/** Rect widths include CSS zoom/transforms; translation and font sizes use layout pixels. */
export function sidebarTitleMotion({
	contentWidth,
	viewportWidth,
	scaleX = 1,
	fontSize,
	direction,
}: {
	contentWidth: number;
	viewportWidth: number;
	scaleX?: number;
	fontSize: number;
	direction: "ltr" | "rtl";
}): SidebarTitleMotion | null {
	if (
		!Number.isFinite(contentWidth) ||
		!Number.isFinite(viewportWidth) ||
		!Number.isFinite(scaleX) ||
		scaleX <= 0 ||
		viewportWidth <= 0
	)
		return null;

	const distancePx = (contentWidth - viewportWidth) / scaleX;
	if (distancePx < 1) return null;
	const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 13;
	const durationMs = (distancePx / (2 * size)) * 1000;
	return {
		direction,
		distancePx,
		offsetPx: direction === "rtl" ? distancePx : -distancePx,
		delayMs: 350,
		durationMs,
		totalDurationMs: 350 + durationMs,
	};
}
