/** Locate source syntax at a semantic block. Never fabricate decoded text offsets. */
export function findDocumentSearchBlock(root: HTMLElement, start: number, end: number): HTMLElement {
	const blocks = [...root.querySelectorAll<HTMLElement>("[data-markdown-source-start][data-markdown-source-end]")];
	let best: HTMLElement | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const block of blocks) {
		const from = Number(block.dataset.markdownSourceStart);
		const to = Number(block.dataset.markdownSourceEnd);
		if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) continue;
		if (from <= start && to >= end) return block;
		const gap = from > start ? from - start : start > to ? start - to : 0;
		if (gap < distance) {
			best = block;
			distance = gap;
		}
	}
	return best ?? root;
}
