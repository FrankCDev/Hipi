/** Offsets are original UTF-16 units. Do not re-normalize or case-fold the displayed text. */
export function SearchHighlight({
	text,
	offset,
	start,
	end,
}: {
	text: string;
	offset: number;
	start: number;
	end: number;
}) {
	const from = Math.max(0, start - offset);
	const to = Math.min(text.length, end - offset);
	if (to <= from || from >= text.length) return text;
	return (
		<>
			{text.slice(0, from)}
			<mark data-search-match="">{text.slice(from, to)}</mark>
			{text.slice(to)}
		</>
	);
}
