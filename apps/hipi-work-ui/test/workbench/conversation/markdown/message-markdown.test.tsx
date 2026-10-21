import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../../src/app/client-provider.tsx";
import { ExternalLinkProvider } from "../../../../src/app/external-link-provider.tsx";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { defaultConfig } from "../../../../src/app/theme/config.ts";
import { themeStorageKey } from "../../../../src/app/theme/store.ts";
import type * as Tooltips from "../../../../src/components/ui/action-tooltip.tsx";
import type * as Buttons from "../../../../src/components/ui/button.tsx";
import {
	ClipboardFeedback,
	type ClipboardStatus,
} from "../../../../src/features/workbench/conversation/markdown/clipboard-feedback.ts";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";
import {
	inertDestination,
	MAX_RICH_TEXT_UNITS,
	markdownDisplaySource,
	ORIGINAL_PAGE_UNITS,
	originalPage,
} from "../../../../src/features/workbench/conversation/markdown/policy.ts";
import type * as Copies from "../../../../src/features/workbench/conversation/markdown/use-clipboard-feedback.ts";
import { MessageContent } from "../../../../src/features/workbench/conversation/message-text-reader.tsx";
import { ConversationMessages, StreamingMessage } from "../../../../src/features/workbench/conversation/messages.tsx";

const copies = vi.hoisted(() => ({
	active: false,
	state: "idle" as ClipboardStatus,
	controllers: [] as ClipboardFeedback[],
	buttons: [] as ComponentProps<typeof Buttons.Button>[],
}));
// SSR cannot mount effects. Drive the production clipboard callback through the real
// feedback owner, recording button props; DOM focus and actual clipboard permissions need browser acceptance.
vi.mock("../../../../src/features/workbench/conversation/markdown/use-clipboard-feedback.ts", async (original) => {
	const actual = await original<typeof Copies>();
	return {
		...actual,
		useClipboardFeedback: () => {
			const observed = actual.useClipboardFeedback();
			if (!copies.active) return observed;
			const controller = new ClipboardFeedback((state) => {
				copies.state = state;
			});
			copies.controllers.push(controller);
			return { status: copies.state, copy: (text: string) => controller.copy(text) };
		},
	};
});
// Callback-only SSR tests have no browser event system. The real Radix interaction
// path is covered separately by clipboard-copy-mounted.test.tsx.
vi.mock("../../../../src/components/ui/action-tooltip.tsx", async (original) => {
	const actual = await original<typeof Tooltips>();
	return {
		...actual,
		ActionTooltip: (props: ComponentProps<typeof Tooltips.ActionTooltip>) =>
			copies.active ? props.children : <actual.ActionTooltip {...props} />,
	};
});
vi.mock("../../../../src/components/ui/button.tsx", async (original) => {
	const actual = await original<typeof Buttons>();
	return {
		...actual,
		Button: (props: ComponentProps<typeof Buttons.Button>) => {
			if (copies.active) copies.buttons.push(props);
			return <actual.Button {...props} />;
		},
	};
});
afterEach(() => {
	for (const controller of copies.controllers) controller.dispose();
	copies.controllers.length = 0;
	copies.buttons.length = 0;
	copies.state = "idle";
	copies.active = false;
	vi.unstubAllGlobals();
});

function render(source: string, streaming = false) {
	return renderToStaticMarkup(
		<PreferencesProvider>
			<MessageMarkdown source={source} streaming={streaming} />
		</PreferencesProvider>,
	);
}

test("successful rich messages do not mount a duplicated original-text reader", () => {
	const html = render("A normal answer with **emphasis** and `inline code`.");
	assert.match(html, /<strong>emphasis<\/strong>/);
	assert.doesNotMatch(html, /message-original|original-text|<details|查看原始文本/);
	assert.equal((html.match(/inline code/g) ?? []).length, 1);
	assert.doesNotMatch(html, /markdown-code-header|复制代码/);
});

test("fenced and indented code have safe language headers and a real copy control, never invented actions", () => {
	const html = render("```typescript\nconst a = '<script>';\n```\n\n    plain text\n\n```c++\nint n = 2;\n```");
	assert.equal((html.match(/class="markdown-code-block"/g) ?? []).length, 3);
	assert.match(html, /class="markdown-code-language">typescript<\/span>/);
	assert.match(html, /class="markdown-code-language"><\/span>/);
	assert.match(html, /class="markdown-code-language">c\+\+<\/span>/);
	assert.match(html, /aria-label="复制代码"/);
	assert.match(html, /<section class="markdown-code-scroll" aria-label="代码" tabindex="0" dir="ltr"><pre>/);
	assert.match(html, /const a = &#x27;&lt;script&gt;&#x27;;/);
	assert.doesNotMatch(html, /Execute|Run code|Download|Artifact|运行代码|下载|<script/);
	const invalid = render("```<img/src=x>\nnot markup\n```");
	assert.match(invalid, /class="markdown-code-language"><\/span>/);
	assert.doesNotMatch(invalid, /<img|<script/);
});

test("scrollable tables retain header semantics and alignment without inline style injection", () => {
	const html = render("| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |");
	assert.match(html, /<section class="markdown-table" aria-label="表格" tabindex="0"/);
	assert.match(html, /<th scope="col" data-align="left">Left<\/th>/);
	assert.match(html, /<th scope="col" data-align="center">Center<\/th>/);
	assert.match(html, /<td data-align="right">C<\/td>/);
	assert.doesNotMatch(html, /style=/);
});

test("code controls and scroll regions use the current locale", () => {
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => (key === themeStorageKey ? JSON.stringify({ ...defaultConfig(), locale: "en" }) : null),
		},
	});
	const html = render("```\ncode\n```\n\n| A |\n| - |\n| B |");
	assert.match(html, /aria-label="Copy code"/);
	assert.match(html, /aria-label="Code"/);
	assert.match(html, /aria-label="Table"/);
	assert.doesNotMatch(html, /复制代码|表格/);
});

test("streaming code stays readable but copying repaired or unfinished content is disabled", () => {
	const source = "```ts\nconst incomplete = '<script>';";
	const html = render(source, true);
	assert.match(html, /markdown-code-header/);
	assert.doesNotMatch(html, /aria-label="复制代码"|代码块完成后可复制/);
	assert.match(html, /const incomplete = &#x27;&lt;script&gt;&#x27;;/);
	assert.doesNotMatch(html, /<script|original-text/);
	const completed = render(source, false);
	assert.doesNotMatch(completed, /disabled=""|代码块完成后可复制/);
	assert.match(completed, /aria-label="复制代码"/);
});

test("copy writes only code content and reports success after the clipboard resolves", async () => {
	copies.active = true;
	const writeText = vi.fn(async (_text: string): Promise<void> => {});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const source = "Surrounding prose.\n\n```ts\nconst value = '<script>';\n\n```";
	render(source);
	const button = copies.buttons.find((props) => props["aria-label"] === "复制代码");
	assert.ok(button?.onClick);
	Reflect.apply(button.onClick, undefined, [{}]);
	assert.equal(copies.state, "copying");
	assert.match(render(source), /正在复制…/);
	await vi.waitFor(() => assert.equal(copies.state, "copied"));
	assert.deepEqual(writeText.mock.calls, [["const value = '<script>';\n\n"]]);
	assert.match(render(source), /已复制/);
});

test("streaming has no copy owner or callback while wrapping remains available", () => {
	copies.active = true;
	render("```ts\nunfinished", true);
	assert.equal(
		copies.buttons.some((props) => props["aria-label"] === "复制代码"),
		false,
	);
	assert.equal(copies.controllers.length, 0);
	assert.ok(copies.buttons.some((props) => props["aria-label"] === "启用自动换行"));
});

test("a missing clipboard API preserves selectable code and reports manual-copy recovery", async () => {
	copies.active = true;
	vi.stubGlobal("navigator", {});
	const source = "```\nselectable value\n```";
	render(source);
	const button = copies.buttons.find((props) => props["aria-label"] === "复制代码");
	assert.ok(button?.onClick);
	Reflect.apply(button.onClick, undefined, [{}]);
	await vi.waitFor(() => assert.equal(copies.state, "failed"));
	const html = render(source);
	assert.match(html, /<pre><code>selectable value\n<\/code><\/pre>/);
	assert.match(html, /role="alert">无法自动复制，请选中文字复制。/);
});

test("clipboard rejection is recoverable and disposing the owner ignores a late completion", async () => {
	copies.active = true;
	const writeText = vi.fn(async (_text: string): Promise<void> => {
		throw new Error("Denied");
	});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const source = "```\nvalue\n```";
	render(source);
	const button = copies.buttons.find((props) => props["aria-label"] === "复制代码");
	assert.ok(button?.onClick);
	Reflect.apply(button.onClick, undefined, [{}]);
	await vi.waitFor(() => assert.equal(copies.state, "failed"));
	assert.match(render(source), /role="alert">无法自动复制，请选中文字复制。/);
	assert.doesNotMatch(render(source), /已复制/);
	let resolve: (() => void) | undefined;
	writeText.mockImplementation(
		() =>
			new Promise<void>((done) => {
				resolve = done;
			}),
	);
	const retry = copies.buttons.at(-1);
	assert.ok(retry?.onClick);
	Reflect.apply(retry.onClick, undefined, [{}]);
	assert.equal(copies.state, "copying");
	copies.controllers.at(-1)?.dispose();
	const previous = copies.state;
	assert.ok(resolve);
	resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(copies.state, previous);
	assert.notEqual(copies.state, "copied");
});

test("a failed repeat copy never continues to claim the current copy succeeded", () => {
	copies.active = true;
	copies.state = "failed";
	const html = render("```\nvalue\n```");
	assert.match(html, /aria-label="复制代码"/);
	assert.match(html, /role="alert">无法自动复制，请选中文字复制。/);
	assert.doesNotMatch(html, /已复制/);
});

test("code and typography styles preserve region colors, configured code fonts and horizontal scrolling", () => {
	const css = readFileSync(
		new URL("../../../../src/features/workbench/conversation/markdown/markdown.css", import.meta.url),
		"utf8",
	);
	assert.match(css, /font-family: var\(--font-code\)/);
	assert.match(css, /font-size: var\(--font-code-size\)/);
	assert.match(css, /font-family: var\(--font-ui\)/);
	assert.match(css, /background: var\(--canvas\)/);
	assert.match(css, /\.markdown-code-scroll\s*\{[^}]*overflow-x: auto;[^}]*white-space: pre;/);
	assert.match(css, /\.markdown-table\s*\{[^}]*overflow-x: auto;/);
	assert.match(css, /outline: 2px solid var\(--focus\)/);
	assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|url\(/i);
});

test("user and assistant messages use safe Markdown without rendering untrusted HTML", () => {
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
	assert.match(html, /<strong>user<\/strong>/);
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /<strong>assistant<\/strong>/);
});

test("user code uses a simple escaped pre without assistant code actions", () => {
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<MessageMarkdown source={"```html\n<script>unsafe</script>\n```"} tone="user" />
		</PreferencesProvider>,
	);
	assert.match(html, /<pre class="markdown-user-code">/);
	assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
	assert.doesNotMatch(html, /markdown-code-header|复制代码|<script/);
});

test("a closed code block remains copyable while the final open block omits copy", () => {
	const html = render("```ts\nclosed();\n```\n\n```ts\nopen();", true);
	assert.equal((html.match(/aria-label="复制代码"/g) ?? []).length, 1);
	assert.equal((html.match(/代码块完成后可复制/g) ?? []).length, 0);
	for (const source of ["> ```ts\n> open();", "- ```ts\n  open();", "> - ```ts\n>   open();"]) {
		assert.doesNotMatch(render(source, true), /aria-label="复制代码"|代码块完成后可复制/);
	}
	for (const source of ["> ```ts\n> closed();\n> ```", "- ```ts\n  closed();\n  ```"]) {
		assert.doesNotMatch(render(source, true), /disabled=""/);
	}
});

test("settled blocks keep long ordinary prose rich within the document bound", () => {
	const source = `${"A **settled** paragraph.\n\n".repeat(140)}A **mutable`;
	const html = render(source, true);
	assert.match(html, /markdown-body/);
	assert.doesNotMatch(html, /分页原文/);
	assert.equal((html.match(/<strong><span[^>]*>settled<\/span><\/strong>/g) ?? []).length, 140);
	assert.match(html, /<strong><span[^>]*>mutable<\/span><\/strong>/);
});

test("reference definitions, containers and multi-paragraph code keep canonical Markdown semantics", () => {
	const open = vi.fn(async () => "opened" as const);
	const reference = renderToStaticMarkup(
		<PreferencesProvider>
			<ExternalLinkProvider client={{ supported: true, open }}>
				<MessageMarkdown source={"Earlier paragraph.\n\n[linked][target]\n\n[target]: https://example.com"} />
			</ExternalLinkProvider>
		</PreferencesProvider>,
	);
	assert.match(reference, /<a[^>]*href="https:\/\/example.com\/"[^>]*>linked<\/a>/);
	assert.match(reference, /rel="noopener noreferrer"/);
	assert.equal(open.mock.calls.length, 0);
	assert.equal((render("- first\n\n  second\n\n- third").match(/<ul>/g) ?? []).length, 1);
	assert.match(render("```\nfirst\n\nsecond\n```\n\nnext"), /first\n\nsecond\n<\/code>/);
	assert.match(render("Title\n---\n\nparagraph"), /<h2>Title<\/h2>/);
});

test("GFM renders tables, lists, fences and task states without active controls", () => {
	const html = render(
		"# Heading\n\n- one\n- [x] done\n\n| A | B |\n| - | - |\n| 中 | 文 |\n\n```ts\nconst a = '<script>';\n```\n\n~~old~~",
	);
	for (const tag of ["h1", "ul", "li", "table", "th", "td", "pre", "code", "del"])
		assert.match(html, new RegExp(`<${tag}[ >]`));
	assert.doesNotMatch(html, /<script/);
	// Radix may SSR a disabled form mirror; neither it nor the visible status is editable.
	for (const [input] of html.matchAll(/<input\b[^>]*>/gu)) {
		assert.match(input, /disabled=""/);
		assert.match(input, /aria-hidden="true"/);
		assert.match(input, /tabindex="-1"/);
	}
	assert.match(html, /role="checkbox" aria-checked="true"[^>]*disabled=""/);
	assert.match(html, /&lt;script&gt;/);
});

test("untrusted markup has no fetch, HTML, SVG or style surface; only controlled HTTP links get href", () => {
	const open = vi.fn(async () => "opened" as const);
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<ExternalLinkProvider client={{ supported: true, open }}>
				<MessageMarkdown
					source={
						'<script>alert(1)</script>\n\n<svg onload="bad()"></svg>\n\n<img src="https://bad.test/a">\n\n![remote](https://bad.test/pixel) ![data](data:image/svg+xml,bad)\n\n[ok](https://example.com/a) [bad](javascript:alert%281%29)'
					}
				/>
			</ExternalLinkProvider>
		</PreferencesProvider>,
	);
	assert.doesNotMatch(
		html,
		/<(?:script|svg|img|iframe|link|style|video|audio)\b|<[^>]+\s(?:src|srcset|style|onload)=/i,
	);
	assert.match(html, /https:\/\/example.com\/a/);
	assert.match(html, /remote/);
	assert.deepEqual(
		[...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]),
		["https://example.com/a"],
	);
	assert.match(html, /rel="noopener noreferrer"/);
	assert.equal(open.mock.calls.length, 0);
});

test("only explicit credential-free HTTP(S) destinations reach the controlled component", () => {
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

test("ordinary messages beyond the old rich ceiling remain one continuous Markdown document", () => {
	const source = `**begin**\n\n${"a".repeat(ORIGINAL_PAGE_UNITS - 1)}😀${"中".repeat(MAX_RICH_TEXT_UNITS)}\n\n**tail**`;
	assert.equal(markdownDisplaySource(source, false), source);
	assert.doesNotThrow(() => markdownDisplaySource(source, true));
	const html = render(source);
	assert.match(html, /markdown-body/);
	assert.match(html, /<strong>begin<\/strong>/);
	assert.match(html, /<strong>tail<\/strong>/);
	assert.match(html, /😀中/);
	assert.doesNotMatch(html, /分页原文|original-pages|<button|<pre/);
});

test("paging preserves unpaired UTF-16 units from incomplete or malformed input", () => {
	const source = `\udc00${"a".repeat(ORIGINAL_PAGE_UNITS - 1)}\udc00\ud800`;
	assert.equal(originalPage(source, 0) + originalPage(source, 1), source);
});

test("ordinary long streaming paragraphs remain rich without changing canonical content", () => {
	const source = `**complete**\n${"x".repeat(3364)}`;
	const streaming = render(source, true);
	assert.match(streaming, /markdown-body/);
	assert.match(streaming, /<strong>/);
	assert.doesNotMatch(streaming, /分页原文/);
	assert.equal(markdownDisplaySource(source, true), source);
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

test("committed and live assistant previews retain Markdown while full content is pending", () => {
	const html = renderToStaticMarkup(
		<AppClientProvider
			client={{
				call: async () => {
					throw new Error("SSR must not read");
				},
				observe: async () => {
					throw new Error("SSR must not observe");
				},
			}}
		>
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
			</PreferencesProvider>
		</AppClientProvider>,
	);
	assert.doesNotMatch(html, /截断预览|分页读取完整原文|11 \/ 4000|10 \/ 50000/);
	assert.match(html, /<strong>preview<\/strong>/);
	assert.match(html, /<strong><span[^>]*>stream<\/span><\/strong>/);
});
