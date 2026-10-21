import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, highlightingFor } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightTree, tags } from "@lezer/highlight";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { boundedEditorInput } from "../../../../src/features/files/editor-limits.ts";
import {
	isMarkdownFile,
	markdownHighlight,
	markdownPresentation,
} from "../../../../src/features/files/markdown-presentation.ts";
import { MarkdownPreview } from "../../../../src/features/files/markdown-preview.tsx";
import { MAX_RICH_TEXT_UNITS } from "../../../../src/features/workbench/conversation/markdown/policy.ts";

test("installed CM Markdown parser and semantic highlighting handle real source with no network", () => {
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
	try {
		const text =
			"# 标题\n\n**strong** *emphasis* ~~old~~ [link](https://example.com)\n\n- [x] task\n\n```unknown-remote\nplain();\n```\n";
		const state = EditorState.create({ doc: text, extensions: [markdownPresentation, boundedEditorInput] });
		const tree = ensureSyntaxTree(state, text.length, 1000);
		assert.ok(tree);
		for (const node of ["ATXHeading1", "StrongEmphasis", "Emphasis", "Strikethrough", "Link", "Task", "FencedCode"])
			assert.match(tree.toString(), new RegExp(node));
		const highlighted: string[] = [];
		highlightTree(tree, markdownHighlight, (from, to) => highlighted.push(text.slice(from, to)));
		assert.ok(highlighted.some((value) => value.includes("标题")));
		assert.ok(highlighted.some((value) => value.includes("strong")));
		assert.ok(highlightingFor(state, [tags.heading]));
		assert.ok(
			state
				.facet(EditorView.contentAttributes)
				.some((value) => typeof value === "object" && value.class === "cm-lineWrapping"),
		);
		for (const spec of markdownHighlight.specs)
			if (spec.color) assert.match(String(spec.color), /^var\(--(?:text|muted|accent-text|warning|danger)\)$/);
		assert.equal(state.doc.toString(), text);
		assert.equal(fetch.mock.calls.length, 0);
	} finally {
		fetch.mockRestore();
	}
});

test("official Markdown commands continue lists as one bounded state transaction", () => {
	let state = EditorState.create({
		doc: "- item",
		selection: { anchor: 6 },
		extensions: [markdownPresentation, boundedEditorInput],
	});
	assert.equal(
		insertNewlineContinueMarkup({
			state,
			dispatch: (transaction) => {
				state = transaction.state;
			},
		}),
		true,
	);
	assert.equal(state.doc.toString(), "- item\n- ");
	for (const name of ["notes.md", "folder/README.MARKDOWN", "page.mdx"]) assert.equal(isMarkdownFile(name), true);
	for (const name of ["notes.txt", "md", "constructor", "notes.md.js"]) assert.equal(isMarkdownFile(name), false);
});

test("file preview uses the production safe Markdown renderer and never adds active content", () => {
	const text =
		"# Draft\n\n**bold** ![remote](https://bad.test/pixel)\n\n<script>bad()</script>\n\n[ok](https://example.com) [bad](javascript:alert%281%29)\n\n```html\n<img src='bad'>\n```";
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<MarkdownPreview text={text} memory={{}} />
		</PreferencesProvider>,
	);
	assert.match(html, /file-markdown-preview/);
	assert.match(html, /<h1>Draft<\/h1>/);
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /<span>ok<\/span>/);
	assert.doesNotMatch(html, /title="https:/);
	// The copy control owns its trusted Lucide SVG; file content must not create resource elements.
	assert.doesNotMatch(html, /<(?:img|script|a|iframe|style)\b|<[^>]+\s(?:href|src|srcset|onload)=/i);
	const long = renderToStaticMarkup(
		<PreferencesProvider>
			<MarkdownPreview text={"x".repeat(MAX_RICH_TEXT_UNITS + 1)} memory={{}} />
		</PreferencesProvider>,
	);
	assert.match(long, /markdown-body/);
	assert.doesNotMatch(long, /original-text|original-pages/);
	const css = readFileSync(new URL("../../../../src/features/files/markdown-preview.css", import.meta.url), "utf8");
	assert.match(css, /overflow: auto/);
	assert.match(css, /var\(--font-ui\)/);
	assert.doesNotMatch(css, /url\(|#[\da-f]{3,8}\b/i);
});
