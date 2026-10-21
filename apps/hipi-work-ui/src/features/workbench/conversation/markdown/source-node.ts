/** Only source metadata consumed by reveal decorations, independent of a parser's AST. */
export type MarkdownSourceNode = {
	position?: { start: { offset?: number } };
	children: readonly { type: string; value?: string }[];
};
