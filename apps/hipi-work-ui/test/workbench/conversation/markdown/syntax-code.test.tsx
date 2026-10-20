import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { SyntaxCodeContent } from "../../../../src/features/workbench/conversation/markdown/syntax-code.tsx";
import { highlightCode } from "../../../../src/features/workbench/conversation/markdown/syntax-highlight.ts";

test("highlighted React tokens escape hostile code and preserve exact whitespace", () => {
	const source = "const hostile = '<script>bad()</script><img src=https://bad.test>';\r\n\n";
	const highlight = highlightCode(source, "ts");
	assert.ok(highlight);
	const html = renderToStaticMarkup(
		<code>
			<SyntaxCodeContent text={source} highlight={highlight} />
		</code>,
	);
	assert.match(html, /markdown-syntax-token/);
	assert.doesNotMatch(html, /<script|<img|<[^>]+\s(?:src|href|onload)=/);
	const unwrapped = html.replace(/<\/?span\b[^>]*>/gu, "");
	assert.equal(unwrapped, renderToStaticMarkup(<code>{source}</code>));
});

test("delayed highlighting preserves its matching prefix plus raw new tail, never stale corrected text", () => {
	const source = "const first = 1;\n";
	const highlight = highlightCode(source, "ts");
	assert.ok(highlight);
	for (const text of [`${source}const second = 2;\n`, "completely corrected <&>\n", "const first = 'changed';\n"]) {
		const html = renderToStaticMarkup(
			<code>
				<SyntaxCodeContent text={text} highlight={highlight} />
			</code>,
		);
		assert.equal(html.replace(/<\/?span\b[^>]*>/gu, ""), renderToStaticMarkup(<code>{text}</code>));
	}
	const unknown = renderToStaticMarkup(
		<code>
			<SyntaxCodeContent text={source} />
		</code>,
	);
	assert.equal(unknown, renderToStaticMarkup(<code>{source}</code>));
});
