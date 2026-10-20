import { FILE_LIMITS } from "@hipi/work-runtime/files";
import type { TextDocument } from "@pierre/diffs/edit";

export type FileSearchChange = { from: number; to: number; text: string };
export type SearchableFileDocument = Pick<
	TextDocument,
	"search" | "getText" | "positionAt" | "offsetAt" | "getLineText"
>;

/** Matching is owned by Pierre; JavaScript's replacement primitive expands verified captures. */
export function fileSearchReplacements(
	document: SearchableFileDocument,
	ranges: readonly [number, number][],
	query: { query: string; regex: boolean; caseSensitive: boolean },
	replacement: string,
): FileSearchChange[] {
	const pattern = query.regex ? new RegExp(query.query, `gm${query.caseSensitive ? "" : "i"}`) : undefined;
	const source = document.getText();
	let remaining = FILE_LIMITS.bytes - source.length + ranges.reduce((length, [from, to]) => length + to - from, 0);
	return ranges.map(([from, to]) => {
		if (!pattern) {
			remaining -= replacement.length;
			if (remaining < 0) throw new RangeError("Replacement exceeds the editor limit");
			return { from, to, text: replacement };
		}
		const position = document.positionAt(from);
		const line = document.getLineText(position.line);
		const relative = from - document.offsetAt({ line: position.line, character: 0 });
		pattern.lastIndex = relative;
		const match = pattern.exec(line);
		if (!match || match.index !== relative || from + match[0].length !== to) throw new Error("Search document changed");
		// Pierre searches each newline-trimmed line independently. Reuse the public
		// document's line context so anchors, lookbehind and CRLF offsets agree.
		match.index = 0;
		match.input = match[0];
		const substitution = /(?:)/g;
		let consumed = false;
		substitution.exec = () => {
			if (consumed) return null;
			consumed = true;
			return match;
		};
		const text = match[0].replace(substitution, replacement);
		remaining -= text.length;
		if (remaining < 0) throw new RangeError("Replacement exceeds the editor limit");
		return { from, to, text };
	});
}
