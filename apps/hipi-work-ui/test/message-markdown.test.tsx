import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { ConversationMessages, StreamingMessage } from "../src/features/workbench/conversation-messages.tsx";
import {
	inertDestination,
	MAX_RICH_TEXT_UNITS,
	MAX_STREAMING_RICH_TEXT_UNITS,
	markdownDisplaySource,
	ORIGINAL_PAGE_UNITS,
	originalPage,
} from "../src/features/workbench/markdown-policy.ts";
import { MessageMarkdown } from "../src/features/workbench/message-markdown.tsx";
import { MessageContent } from "../src/features/workbench/message-text-reader.tsx";

function render(source: string, streaming = false) {
	return renderToStaticMarkup(
		<PreferencesProvider>
			<MessageMarkdown source={source} streaming={streaming} />
		</PreferencesProvider>,
	);
}

test("user messages remain escaped plain text while assistant messages use Markdown", () => {
	// Render the production row content directly; SSR has no measured virtual viewport.
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<MessageContent
				scope={{ workspaceId: "w", conversationId: "c" }}
				offset={undefined}
				onOffsetChange={() => {}}
				message={{ id: "user", role: "user", text: "**user** <img src='bad'>", textLength: 24, truncated: false }}
			/>
			<MessageContent
				scope={{ workspaceId: "w", conversationId: "c" }}
				offset={undefined}
				onOffsetChange={() => {}}
				message={{ id: "assistant", role: "assistant", text: "**assistant**", textLength: 13, truncated: false }}
			/>
		</PreferencesProvider>,
	);
	assert.match(html, /\*\*user\*\* &lt;img/);
	assert.doesNotMatch(html, /<strong>user/);
	assert.match(html, /<strong>assistant<\/strong>/);
});

test("GFM renders tables, lists, fences and task states without active controls", () => {
	const html = render(
		"# Heading\n\n- one\n- [x] done\n\n| A | B |\n| - | - |\n| 中 | 文 |\n\n```ts\nconst a = '<script>';\n```\n\n~~old~~",
	);
	for (const tag of ["h1", "ul", "li", "table", "th", "td", "pre", "code", "del"])
		assert.match(html, new RegExp(`<${tag}[ >]`));
	assert.doesNotMatch(html, /<input|<script/);
	assert.match(html, /&lt;script&gt;/);
});

test("untrusted markup has no fetch, navigation, HTML, SVG or style surface", () => {
	const html = render(
		'<script>alert(1)</script>\n\n<svg onload="bad()"></svg>\n\n<img src="https://bad.test/a">\n\n![remote](https://bad.test/pixel) ![data](data:image/svg+xml,bad)\n\n[ok](https://example.com/a) [bad](javascript:alert%281%29)',
	);
	assert.doesNotMatch(
		html,
		/<(?:script|svg|img|iframe|a|link|style|video|audio)\b|<[^>]+\s(?:href|src|srcset|style|onload)=/i,
	);
	assert.match(html, /https:\/\/example.com\/a/);
	assert.match(html, /remote/);
});

test("all URL destinations are inert, only explicit credential-free HTTP(S) displayed", () => {
	for (const url of [
		"javascript:alert(1)",
		"data:text/html,x",
		"file:///tmp/a",
		"//example.com",
		"/relative",
		"#fragment",
		"mailto:a@example.com",
		"https://user:pass@example.com",
		"https://example.com/\n",
	])
		assert.equal(inertDestination(url), "");
	assert.equal(inertDestination("https://example.com/a?q=1"), "https://example.com/a?q=1");
});

test("every incomplete prefix renders; canonical completed/interrupted source is never repaired", () => {
	const source =
		"中文 **bold** `code` [link](https://example.com)\n\n```ts\nconst a = 1;\n```\n\n|A|B|\n|-|-|\n|一|二|";
	for (let index = 0; index <= source.length; index++) {
		const prefix = source.slice(0, index);
		assert.doesNotThrow(() => render(prefix, true));
		assert.equal(markdownDisplaySource(prefix, false), prefix);
	}
	assert.equal(markdownDisplaySource("$$x", true), "$$x");
	assert.equal(markdownDisplaySource("$x", true), "$x");
});

test("rich ceiling uses explicit paged fallback with lossless surrogate-safe original", () => {
	const source = `${"a".repeat(ORIGINAL_PAGE_UNITS - 1)}😀${"中".repeat(MAX_RICH_TEXT_UNITS)}tail`;
	const pages = Array.from({ length: Math.ceil(source.length / ORIGINAL_PAGE_UNITS) }, (_, index) =>
		originalPage(source, index),
	);
	assert.equal(pages.join(""), source);
	for (const page of pages) assert.equal(page.isWellFormed(), true);
	assert.throws(() => markdownDisplaySource(source, true), /ceiling/);
	const html = render(source);
	assert.match(html, /分页原文/);
	assert.doesNotMatch(html, /markdown-body/);
	assert.ok(html.length < ORIGINAL_PAGE_UNITS + 2000);
});

test("paging preserves unpaired UTF-16 units from incomplete or malformed input", () => {
	const source = `\udc00${"a".repeat(ORIGINAL_PAGE_UNITS - 1)}\udc00\ud800`;
	assert.equal(originalPage(source, 0) + originalPage(source, 1), source);
});

test("long streaming display avoids repeated rich parsing without changing canonical content", () => {
	const source = `**complete**\n${"x".repeat(MAX_STREAMING_RICH_TEXT_UNITS)}`;
	const streaming = render(source, true);
	assert.doesNotMatch(streaming, /markdown-body/);
	assert.match(streaming, /\*\*complete\*\*/);
	assert.match(streaming, /分页原文/);
	assert.throws(() => markdownDisplaySource(source, true), /ceiling/);
	assert.equal(markdownDisplaySource(source, false), source);
	assert.match(render(source, false), /<strong>complete<\/strong>/);
});

test("empty intermediate history remains navigable and is never presented as a new conversation", () => {
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<ConversationMessages
				onNearTop={() => {}}
				error={false}
				snapshot={{
					workspaceId: "w",
					conversationId: "c",
					messages: [],
					partial: "",
					partialLength: 0,
					partialTruncated: false,
					running: false,
					historyCursor: "opaque-continuation",
				}}
			/>
		</PreferencesProvider>,
	);
	assert.match(html, /virtual-message-stack/);
	assert.doesNotMatch(html, /这次，你想完成什么/);
});

test("truncated committed and live previews are labeled plain text, never completed Markdown", () => {
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<MessageContent
				scope={{ workspaceId: "w", conversationId: "c" }}
				offset={undefined}
				onOffsetChange={() => {}}
				message={{ id: "m", role: "assistant", text: "**preview**", textLength: 4000, truncated: true }}
			/>
			<StreamingMessage
				snapshot={{
					workspaceId: "w",
					conversationId: "c",
					messages: [],
					partial: "**stream**",
					partialLength: 50000,
					partialTruncated: true,
					running: true,
					historyCursor: null,
				}}
			/>
		</PreferencesProvider>,
	);
	assert.match(html, /截断预览/);
	assert.match(html, /分页读取完整原文/);
	assert.match(html, /11 \/ 4000/);
	assert.match(html, /10 \/ 50000/);
	assert.doesNotMatch(html, /<strong>preview|<strong>stream/);
});
