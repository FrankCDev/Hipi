import { externalLinkUrl } from "@hipi/work-runtime/external-links";
import { Lexer } from "marked";
import remend from "remend";
import { projectFilePath } from "./file-links/path.ts";

// Existing animation/highlighting optimization threshold only. It is NOT a
// Markdown document admission limit: longer messages still render continuously.
export const MAX_RICH_TEXT_UNITS = 32 * 1024;
export const ORIGINAL_PAGE_UNITS = 16 * 1024;

export function markdownDisplaySource(source: string, streaming: boolean): string {
	return streaming ? remend(source, { katex: false, inlineKatex: false, linkMode: "text-only" }) : source;
}

/** Check only real link syntax already recognized by Marked, not repaired display text. */
export function completeMarkdownLink(raw: string): boolean {
	if (raw.startsWith("<") && raw.endsWith(">")) return true;
	if (!raw.startsWith("[")) return false;
	// Reuse Marked's label/destination/title boundaries rather than another link grammar.
	// Its tokenizer accepts an unmatched opening parenthesis when the destination
	// contains no closing parenthesis yet; that prefix must not become actionable.
	const match = Lexer.rules.inline.gfm.link.exec(raw);
	if (match?.[0] !== raw || match[2] === undefined) return false;
	const destination = match[2].trim();
	if (destination.startsWith("<")) return destination.endsWith(">");
	let depth = 0;
	for (let index = 0; index < destination.length; index++) {
		const character = destination[index];
		if (character === "\\") index++;
		else if (character === "(") depth++;
		else if (character === ")" && --depth < 0) return false;
	}
	return depth === 0;
}

// Keep only controlled HTTP(S) URLs or validated project-relative references.
// MarkdownLink routes the latter to an injected file capability, never an href.
// Unsupported hosts remain inert. Images remain placeholders, never resource elements.
export function inertDestination(url: string): string {
	return externalLinkUrl(url) ?? projectFilePath(url) ?? "";
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
