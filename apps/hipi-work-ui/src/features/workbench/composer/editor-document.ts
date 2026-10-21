import { type Node as ProseMirrorNode, Schema } from "prosemirror-model";

/** The runtime accepts text, so this editor intentionally exposes no unsupported rich payloads. */
export const composerSchema = new Schema({
	nodes: {
		doc: { content: "paragraph+" },
		paragraph: { content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
		text: { group: "inline" },
		hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
	},
});

export function composerDocument(text: string): ProseMirrorNode {
	return composerSchema.node(
		"doc",
		null,
		text
			.split("\n")
			.map((line) => composerSchema.node("paragraph", null, line ? composerSchema.text(line) : undefined)),
	);
}
export function composerDocumentText(doc: ProseMirrorNode): string {
	return doc.textBetween(0, doc.content.size, "\n", "\n");
}
