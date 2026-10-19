import remend from "remend";

// Provisional complexity ceilings; benchmark before treating these as product budgets.
export const MAX_RICH_TEXT_UNITS = 32 * 1024;
// Repeated synchronous parsing is costly: the measured 32 KiB SSR path exceeded 100 ms.
// This provisional streaming ceiling is a mitigation, not a browser frame-time guarantee.
export const MAX_STREAMING_RICH_TEXT_UNITS = 2 * 1024;
export const ORIGINAL_PAGE_UNITS = 16 * 1024;

export function markdownDisplaySource(source: string, streaming: boolean): string {
	if (source.length > (streaming ? MAX_STREAMING_RICH_TEXT_UNITS : MAX_RICH_TEXT_UNITS))
		throw new Error("Rich display ceiling exceeded");
	return streaming ? remend(source, { katex: false, inlineKatex: false, linkMode: "text-only" }) : source;
}

// No URL is ever handed to a native link or resource element. This policy also
// suppresses dangerous destinations in the inert preview; originals remain available.
export function inertDestination(url: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted destinations.
	if (/[\u0000-\u0020\u007f]/u.test(url) || !/^https?:\/\//iu.test(url)) return "";
	try {
		const parsed = new URL(url);
		return parsed.hostname && !parsed.username && !parsed.password ? url : "";
	} catch {
		return "";
	}
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
