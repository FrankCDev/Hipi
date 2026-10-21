import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

/** Keep actual keyed interaction owners, not hidden copies or a frozen scrolling window. */
export function virtualRecentRange(range: Range, protectedIndexes: readonly number[], focusedIndex = -1) {
	return [
		...new Set([
			...defaultRangeExtractor(range),
			...protectedIndexes.filter((index) => index >= 0 && index < range.count),
			...(focusedIndex >= 0
				? [focusedIndex - 1, focusedIndex + 1].filter((index) => index >= 0 && index < range.count)
				: []),
		]),
	].sort((a, b) => a - b);
}
