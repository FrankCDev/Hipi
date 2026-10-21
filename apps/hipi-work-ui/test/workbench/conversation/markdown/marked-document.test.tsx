import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { ExternalLinkProvider } from "../../../../src/app/external-link-provider.tsx";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";
import { locateMarkdownRaw, parseMarkdown } from "../../../../src/features/workbench/conversation/markdown/parse.ts";

function render(source: string, streaming = false) {
	return renderToStaticMarkup(
		<PreferencesProvider>
			<ExternalLinkProvider client={{ supported: true, open: async () => "opened" }}>
				<MessageMarkdown source={source} streaming={streaming} />
			</ExternalLinkProvider>
		</PreferencesProvider>,
	);
}

test("Marked consumes the canonical document across transport boundaries, including forward definitions", () => {
	const source = `[linked][target]\n\n${"A **paragraph** &amp; 中文 😀.\n\n".repeat(1500)}\n[target]: https://example.com/finish\n\n**end**`;
	const chunks = Array.from({ length: Math.ceil(source.length / 32768) }, (_, index) =>
		source.slice(index * 32768, (index + 1) * 32768),
	);
	assert.deepEqual(parseMarkdown(chunks.join("")).tokens, parseMarkdown(source).tokens);
	const html = render(chunks.join(""));
	assert.match(html, /href="https:\/\/example.com\/finish"/);
	assert.match(html, /<strong>end<\/strong>/);
	assert.doesNotMatch(html, /original-pages|下一页|刷新本页|分页原文/);
});

test("reference soft breaks and double-tilde policy do not change entities or inline code", () => {
	const html = render("first\nsecond &amp; &#x1f600; \\*literal\\*\n\n~single~ ~~double~~ `&amp;`");
	assert.match(html, /first<br\/>second &amp; 😀/);
	assert.match(html, /\*literal\*/);
	assert.match(html, /~single~ <del>double<\/del>/);
	assert.match(html, /<code>&amp;amp;<\/code>/);
	assert.doesNotMatch(html, /<del>single/);
});

test("CRLF and lone CR normalize for parsing while ranges stay in original UTF16 source", () => {
	const source = "😀 first\r\n\r\n[link](https://example.com)\rnext";
	const document = parseMarkdown(source);
	const raw = "[link](https://example.com)";
	const range = locateMarkdownRaw(document, raw, 0, document.normalized.length);
	assert.equal(range.exact, true);
	assert.equal(source.slice(document.offset(range.start), document.offset(range.end)), raw);
	assert.equal(document.line(range.start), 3);
	assert.match(render(source), /😀 first/);
	assert.match(render(source), /<br\/>next/);
});

test("nested code fences do not copy an open block and closed CRLF fences become copyable", () => {
	for (const source of ["> ```ts\r\n> open", "- item\n\n  ```ts\n  open\n\n- next"])
		assert.doesNotMatch(render(source, true), /aria-label="复制代码"/);
	assert.match(render("> ```ts\r\n> closed\r\n> ```", true), /aria-label="复制代码"/);
});

test("HTML is inert text and a single table/list spanning the old ceiling remains structurally whole", () => {
	const source = `| A | B |\n|---|---|\n${"| value | &amp; |\n".repeat(2100)}\n<script>alert(1)</script>\n\n- [x] only once`;
	const html = render(source);
	assert.equal((html.match(/<table>/gu) ?? []).length, 1);
	assert.equal((html.match(/role="checkbox"/gu) ?? []).length, 1);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(html, /<script|original-pages/);
});

test("search source ranges point at existing whole blocks without claiming decoded leaf offsets", () => {
	const source = "😀 &amp; **first**\r\n\r\n- nested &copy;\r\n- second\r\n\r\n```ts\r\nx\r\n```";
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<MessageMarkdown source={source} trackSourceRanges sourceOffset={100} />
		</PreferencesProvider>,
	);
	const listStart = source.indexOf("- nested");
	assert.match(html, new RegExp(`<ul data-markdown-source-start="${100 + listStart}"`));
	assert.match(html, /<p data-markdown-source-start="100"/);
	assert.match(html, /<strong>first<\/strong>/);
	assert.doesNotMatch(html, /<strong[^>]*data-markdown-source|<li[^>]*data-markdown-source/);
	const codeStart = source.indexOf("```ts");
	assert.match(
		html,
		new RegExp(`data-markdown-source-start="${100 + codeStart}" data-markdown-source-end="${100 + source.length}"`),
	);
});
