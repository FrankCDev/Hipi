import { Marked, type MarkedToken } from "marked";

const parser = new Marked({
	gfm: true,
	breaks: true,
	tokenizer: {
		del(source) {
			return source.startsWith("~~") ? false : undefined;
		},
	},
});

export type MarkdownRange = { start: number; end: number; exact: boolean };
export type MarkdownDocument = {
	source: string;
	normalized: string;
	tokens: MarkedToken[];
	/** Normalized parser boundaries mapped back to original UTF-16 boundaries. */
	offset: (normalized: number) => number;
	line: (normalized: number) => number;
};

/** One canonical document and one definition environment, never one parser per transport page. */
export function parseMarkdown(source: string): MarkdownDocument {
	let normalized = source;
	let boundaries: number[] | undefined;
	if (source.includes("\r")) {
		boundaries = [0];
		const characters: string[] = [];
		for (let index = 0; index < source.length; index++) {
			const character = source[index] ?? "";
			if (character === "\r") {
				characters.push("\n");
				if (source[index + 1] === "\n") index++;
			} else characters.push(character);
			boundaries.push(index + 1);
		}
		normalized = characters.join("");
	}
	const lineStarts = [0];
	for (let index = 0; index < normalized.length; index++) if (normalized[index] === "\n") lineStarts.push(index + 1);
	return {
		source,
		normalized,
		// No custom token extensions are installed. The public lexer emits the built-in union.
		tokens: parser.lexer(normalized) as MarkedToken[],
		offset: (index) => boundaries?.[index] ?? index,
		line: (index) => {
			let low = 0;
			let high = lineStarts.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if ((lineStarts[middle] ?? 0) <= index) low = middle + 1;
				else high = middle;
			}
			return low;
		},
	};
}

/** Exact ranges are only claimed for verified contiguous raw syntax, never decoded text. */
export function locateMarkdownRaw(
	document: MarkdownDocument,
	raw: string,
	cursor: number,
	limit: number,
): MarkdownRange {
	const start = raw ? document.normalized.indexOf(raw, cursor) : cursor;
	if (start >= cursor && start + raw.length <= limit) return { start, end: start + raw.length, exact: true };
	// Container prefixes can be removed by the lexer. Retain the containing source
	// range rather than invent a decoded-text-to-source mapping.
	const firstLine = raw.split("\n", 1)[0] ?? "";
	const first = firstLine ? document.normalized.indexOf(firstLine, cursor) : cursor;
	return { start: first >= cursor && first < limit ? first : cursor, end: limit, exact: false };
}
