export const COMPOSER_ROWS = { min: 3, max: 8 } as const;

/** CSS uses border-box; scrollHeight includes padding but excludes borders. */
export function composerTextareaSize(scrollHeight: number, lineHeight: number, padding: number, border: number) {
	const minimum = COMPOSER_ROWS.min * lineHeight + padding + border;
	const maximum = COMPOSER_ROWS.max * lineHeight + padding + border;
	return {
		height: Math.min(maximum, Math.max(minimum, scrollHeight + border)),
		overflowY: scrollHeight + border > maximum ? "auto" : "hidden",
	};
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement) {
	const style = getComputedStyle(textarea);
	const lineHeight = Number.parseFloat(style.lineHeight);
	if (!Number.isFinite(lineHeight)) return;
	const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
	const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
	const scrollTop = textarea.scrollTop;
	// Reset before measuring so clearing, deleting or restoring a short draft also shrinks.
	textarea.style.height = "auto";
	const size = composerTextareaSize(textarea.scrollHeight, lineHeight, padding, border);
	textarea.style.height = `${size.height}px`;
	textarea.style.overflowY = size.overflowY;
	// Measurement must not move the reading position in a long draft.
	textarea.scrollTop = scrollTop;
}
