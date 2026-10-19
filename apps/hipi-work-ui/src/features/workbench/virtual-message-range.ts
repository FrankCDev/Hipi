import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

/** Keep native selection endpoints and focused controls mounted without retaining every visited window. */
export function virtualMessageRange(
	range: Range,
	selectionWindow: readonly number[] | null,
	selectionEndpoints: readonly number[],
	focusedIndex: number,
): number[] {
	const indexes = new Set(defaultRangeExtractor(range));
	for (const index of [...(selectionWindow ?? []), ...selectionEndpoints, focusedIndex]) {
		if (Number.isInteger(index) && index >= 0 && index < range.count) indexes.add(index);
	}
	return [...indexes].sort((a, b) => a - b);
}
