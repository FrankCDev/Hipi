import { externalLinkUrl } from "@hipi/work-runtime/external-links";
import remend from "remend";

// Provisional complexity ceiling; benchmark before treating it as a product budget.
// Streaming uses this same document bound. A small mutable-tail limit must not
// switch an ordinary paragraph, list or open fence back to raw Markdown.
// The existing cadence and settled-block memoization bound update work.
export const MAX_RICH_TEXT_UNITS = 32 * 1024;
export const ORIGINAL_PAGE_UNITS = 16 * 1024;

export function markdownDisplaySource(source: string, streaming: boolean): string {
	if (source.length > MAX_RICH_TEXT_UNITS) throw new Error("Rich display ceiling exceeded");
	return streaming ? remend(source, { katex: false, inlineKatex: false, linkMode: "text-only" }) : source;
}

// Only validated destinations reach the injected, click-only external-link capability.
// Unsupported hosts remain inert. Images remain placeholders, never resource elements.
export function inertDestination(url: string): string {
	return externalLinkUrl(url) ?? "";
}

/** Fixed pages use a consistent boundary shifted before a UTF-16 surrogate pair. */
export function originalPage(source: string, page: number): string {
	const boundary = (index: number) => {
		const offset = Math.min(index * ORIGINAL_PAGE_UNITS, source.length);
		const unit = source.charCodeAt(offset);
		const previous = source.charCodeAt(offset - 1);
		return unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? offset - 1 : offset;
	};
	return source.slice(boundary(page), boundary(page + 1));
}
