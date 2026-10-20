export type MarkdownSegment = { key: number; source: string; settled: boolean };

/**
 * Only release syntactically independent blocks. Containers, HTML/directives and
 * reference-capable brackets keep their tail together so later input can still
 * change list nesting, reference definitions or paragraph interpretation.
 * This is a boundary scanner, not a second Markdown parser.
 */
export function markdownSegments(source: string): MarkdownSegment[] {
	const result: MarkdownSegment[] = [];
	let start = 0;
	let offset = 0;
	let fence: { marker: string; length: number } | undefined;
	for (const line of source.split("\n")) {
		const end = offset + line.length + (offset + line.length < source.length ? 1 : 0);
		const terminated = end > offset + line.length;
		if (fence) {
			const closer = /^ {0,3}(`+|~+)[ \t]*\r?$/u.exec(line)?.[1];
			if (closer?.[0] === fence.marker && closer.length >= fence.length) {
				fence = undefined;
				if (terminated) {
					result.push({ key: start, source: source.slice(start, end), settled: true });
					start = end;
				}
			}
		} else {
			const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
			if (opener?.[1] && !(opener[1][0] === "`" && opener[2]?.includes("`"))) {
				fence = { marker: opener[1][0] ?? "`", length: opener[1].length };
			} else if (
				line.includes("[") ||
				/^ {0,3}(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|:{3}|<)|^(?: {4}|\t)/u.test(line)
			) {
				break;
			} else if (!line.trim() && terminated && source.slice(start, offset).trim()) {
				result.push({ key: start, source: source.slice(start, end), settled: true });
				start = end;
			}
		}
		offset = end;
	}
	if (start < source.length || result.length === 0) {
		result.push({ key: start, source: source.slice(start), settled: false });
	}
	return result;
}

/** Parser positions identify the particular card, including fences nested in lists or quotes. */
export function isOpenCodeFence(source: string, startLine: number, endLine: number): boolean {
	const lines = source.split("\n");
	const opening = lines[startLine - 1]?.replace(/^(?:[ \t]*(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+))*/u, "").trimStart();
	const marker = /^(`{3,}|~{3,})/u.exec(opening ?? "")?.[1];
	if (!marker) return false;
	if (endLine <= startLine || endLine > lines.length) return true;
	const last = lines[endLine - 1]?.replace(/^(?:[ \t]*>[ \t]?)*[ \t]*/u, "").trimEnd() ?? "";
	return last.length < marker.length || [...last].some((character) => character !== marker[0]);
}
