import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Static parser support only: no LanguageDescription loaders or remote grammars. */
export const markdownHighlight = HighlightStyle.define([
	{ tag: tags.heading, color: "var(--text)", fontWeight: "600" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strong, fontWeight: "650" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{ tag: tags.link, color: "var(--accent-text)", textDecoration: "underline" },
	{ tag: [tags.url, tags.comment, tags.meta, tags.processingInstruction], color: "var(--muted)" },
	{ tag: tags.quote, color: "var(--muted)" },
	{ tag: [tags.monospace, tags.string], color: "var(--warning)" },
	{ tag: [tags.keyword, tags.tagName, tags.attributeName], color: "var(--accent-text)" },
	{ tag: tags.invalid, color: "var(--danger)" },
]);

export const markdownPresentation = [
	markdown({
		base: markdownLanguage,
		completeHTMLTags: false,
		pasteURLAsLink: false,
		// Unlisted fenced languages remain plain text; never load from file content.
		codeLanguages: () => null,
	}),
	syntaxHighlighting(markdownHighlight),
	EditorView.lineWrapping,
];

export function isMarkdownFile(name: string) {
	return /\.(?:md|mdx|markdown)$/i.test(name);
}
