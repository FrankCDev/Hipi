// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, type ComponentProps } from "react";
import type * as Runtime from "react/jsx-dev-runtime";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import { createExternalLinkClient } from "../src/app/external-link-client.ts";
import { ExternalLinkProvider } from "../src/app/external-link-provider.tsx";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { ExternalLink } from "../src/components/ui/external-link.tsx";
import { MessageMarkdown } from "../src/features/workbench/conversation/markdown/markdown.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const captured = vi.hoisted(() => ({ links: [] as ComponentProps<"a">[] }));
// Callback-only SSR harness: the trusted event is a test double, not native input acceptance.
vi.mock("react/jsx-dev-runtime", async (original) => {
	const actual = await original<typeof Runtime>();
	return {
		...actual,
		jsxDEV: (type: Parameters<typeof actual.jsxDEV>[0], props: Parameters<typeof actual.jsxDEV>[1], key?: string) => {
			if (type === "a") captured.links.push(props as ComponentProps<"a">);
			return actual.jsxDEV(type, props, key, false, undefined, undefined);
		},
	};
});
afterEach(() => {
	captured.links.length = 0;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("ordinary links activate once only from explicit trusted click, with no render or hover I/O", async () => {
	const open = vi.fn(async () => "opened" as const);
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<ExternalLinkProvider client={{ supported: true, open }}>
				<ExternalLink href="https://example.test/a">Read</ExternalLink>
			</ExternalLinkProvider>
		</PreferencesProvider>,
	);
	assert.match(html, /href="https:\/\/example.test\/a"/);
	assert.match(html, /rel="noopener noreferrer"/);
	assert.doesNotMatch(html, /\(https:/);
	assert.equal(open.mock.calls.length, 0);
	const link = captured.links[0];
	assert.ok(link?.onClick);
	assert.equal(link.onMouseEnter, undefined);
	const preventDefault = vi.fn();
	Reflect.apply(link.onClick, undefined, [{ button: 0, nativeEvent: { isTrusted: false }, preventDefault }]);
	assert.equal(open.mock.calls.length, 0);
	const event = { button: 0, nativeEvent: { isTrusted: true }, preventDefault };
	Reflect.apply(link.onClick, undefined, [event]);
	Reflect.apply(link.onClick, undefined, [event]);
	assert.equal(open.mock.calls.length, 1);
	assert.deepEqual(open.mock.calls[0], ["https://example.test/a"]);
	assert.equal(preventDefault.mock.calls.length, 3);
	await Promise.resolve();
});

test("unsupported browser and unsafe destinations remain inert; unfinished streamed links have no target", () => {
	const open = vi.fn(async () => "opened" as const);
	const render = (source: string, supported: boolean, streaming = false) =>
		renderToStaticMarkup(
			<PreferencesProvider>
				<ExternalLinkProvider client={{ supported, open }}>
					<MessageMarkdown source={source} streaming={streaming} />
				</ExternalLinkProvider>
			</PreferencesProvider>,
		);
	assert.doesNotMatch(render("[Read](https://example.test/a)", false), /<a\b|href=/);
	for (const source of [
		"[Read](https://example.test/a",
		"https://exa",
		"https://example.test/complete ",
		"[Read]( https://example.test/a(b) ",
		"[Read][ref]\n\n[ref]: https://example.test/pa",
		"[Read](https://example.test/a(b)",
	]) {
		assert.doesNotMatch(render(source, true, true), /<a\b|href=/, source);
	}
	assert.match(render("[Read](https://example.test/a)", true, true), /href="https:\/\/example.test\/a"/);
	assert.doesNotMatch(
		render("[bad](javascript:alert%281%29) ![image](https://example.test/pixel)", true),
		/<a\b|href=|<img\b|src=/,
	);
	assert.match(render("[Read](https://example.test/a)", true), /href="https:\/\/example.test\/a"/);
	assert.equal(open.mock.calls.length, 0);
});

test("completed streamed destinations retain nested, escaped, angled and titled link syntax", () => {
	const open = vi.fn(async () => "opened" as const);
	for (const [source, href, streaming] of [
		["[Read](https://example.test/a(b(c)))", "https://example.test/a(b(c))", true],
		["[Read](https://example.test/a\\(b)", "https://example.test/a(b", true],
		["[Read](https://example.test/a\\)b)", "https://example.test/a)b", true],
		['[Read](https://example.test/a(b) "title ) (")', "https://example.test/a(b)", true],
		["[Read](https://example.test/a(b) 'title ) (')", "https://example.test/a(b)", true],
		["[Read](https://example.test/a(b) (title))", "https://example.test/a(b)", true],
		["[Read](<https://example.test/a(b>)", "https://example.test/a(b", true],
		["[Read (label](https://example.test/a)", "https://example.test/a", true],
		["<https://example.test/a(b>", "https://example.test/a(b", true],
		["[Read][ref]\n\n[ref]: https://example.test/a", "https://example.test/a", false],
		["https://example.test/a", "https://example.test/a", false],
	] as const) {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			<PreferencesProvider>
				<ExternalLinkProvider client={{ supported: true, open }}>
					<MessageMarkdown source={source} streaming={streaming} />
				</ExternalLinkProvider>
			</PreferencesProvider>,
		);
		assert.equal(host.querySelectorAll("a").length, 1, source);
		assert.equal(host.querySelector("a")?.getAttribute("href"), href, source);
	}
	assert.equal(open.mock.calls.length, 0);
});

test("client validates input and returns unsupported without any browser fallback", async () => {
	assert.equal(await createExternalLinkClient().open("https://example.test"), "unsupported");
	const open = vi.fn(async () => "denied");
	const client = createExternalLinkClient({ open });
	assert.equal(await client.open("javascript:alert(1)"), "denied");
	assert.equal(open.mock.calls.length, 0);
	assert.equal(await client.open("https://example.test"), "denied");
	assert.equal(open.mock.calls.length, 1);
});

test("timeout reports unknown, holds admission until completion and never retries", async () => {
	vi.useFakeTimers();
	let resolve: ((value: unknown) => void) | undefined;
	const open = vi.fn(
		() =>
			new Promise<unknown>((done) => {
				resolve = done;
			}),
	);
	const client = createExternalLinkClient({ open });
	const first = client.open("https://example.test");
	await vi.advanceTimersByTimeAsync(10000);
	assert.equal(await first, "unknown");
	assert.equal(await client.open("https://example.test"), "busy");
	assert.equal(open.mock.calls.length, 1);
	assert.ok(resolve);
	resolve("opened");
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(open.mock.calls.length, 1);
});

test("mounted links discard late completion after destination, host or lifetime changes", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const pending: ((value: "opened" | "failed") => void)[] = [];
	const open = vi.fn(() => new Promise<"opened" | "failed">((resolve) => pending.push(resolve)));
	const client = { supported: true, open };
	const secondClient = { supported: true, open };
	const render = (href: string, selected = client) =>
		act(() =>
			root.render(
				<PreferencesProvider>
					<ExternalLinkProvider client={selected}>
						<ExternalLink href={href}>Read</ExternalLink>
					</ExternalLinkProvider>
				</PreferencesProvider>,
			),
		);
	const activate = async () => {
		const link = captured.links.at(-1);
		assert.ok(link?.onClick);
		assert.equal(link.onContextMenu, undefined);
		assert.equal(link.onDragStart, undefined);
		const click = link.onClick;
		await act(() =>
			Reflect.apply(click, undefined, [{ button: 0, nativeEvent: { isTrusted: true }, preventDefault() {} }]),
		);
	};
	try {
		await render("https://example.test/first");
		await activate();
		await render("https://example.test/second");
		await act(() => pending[0]?.("failed"));
		assert.equal(host.querySelector('[role="alert"]'), null);
		await activate();
		await render("https://example.test/second", secondClient);
		await act(() => pending[1]?.("failed"));
		assert.equal(host.querySelector('[role="alert"]'), null);
		await activate();
		await act(() => pending[2]?.("failed"));
		assert.ok(host.querySelector('[role="alert"]'));
		await activate();
		await act(() => root.unmount());
		await act(() => pending[3]?.("failed"));
		assert.equal(host.innerHTML, "");
		assert.equal(open.mock.calls.length, 4);
	} finally {
		await act(() => root.unmount());
		host.remove();
	}
});

test("mounted stream enables only real completed destinations and keeps settled anchors stable", async () => {
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	const host = document.createElement("div");
	const root = createRoot(host);
	const open = vi.fn(async () => "opened" as const);
	const client = { supported: true, open };
	const prefix = "[Stable](https://example.test/stable)\n\n";
	const render = async (tail: string, streaming = true) =>
		act(() =>
			root.render(
				<PreferencesProvider>
					<ExternalLinkProvider client={client}>
						<MessageMarkdown source={prefix + tail} streaming={streaming} streamId="link-stream" />
					</ExternalLinkProvider>
				</PreferencesProvider>,
			),
		);
	try {
		await render("[Read](https://exa");
		const stable = host.querySelector("a");
		assert.ok(stable);
		assert.equal(host.querySelectorAll("a").length, 1);
		await render("[Read](https://example.test/path");
		assert.equal(host.querySelectorAll("a").length, 1);
		assert.equal(host.querySelector("a"), stable);
		await render("[Read](https://example.test/path(nested)");
		assert.equal(host.querySelectorAll("a").length, 1);
		assert.equal(host.querySelector("a"), stable);
		await render("[Read](https://example.test/path(nested))");
		assert.equal(host.querySelectorAll("a").length, 2);
		assert.equal(host.querySelectorAll("a")[1]?.getAttribute("href"), "https://example.test/path(nested)");
		assert.equal(host.querySelector("a"), stable);
		await render("[Read](https://example.test/path)");
		assert.equal(host.querySelectorAll("a").length, 2);
		assert.equal(host.querySelectorAll("a")[1]?.getAttribute("href"), "https://example.test/path");
		await render("[Read](https://example.test/new)", false);
		assert.equal(host.querySelectorAll("a")[1]?.getAttribute("href"), "https://example.test/new");
		assert.equal(host.querySelector("a"), stable);
		assert.equal(open.mock.calls.length, 0);
	} finally {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("Markdown preserves explicit link titles without adding URL hover tooltips", () => {
	const open = vi.fn(async () => "opened" as const);
	for (const supported of [true, false]) {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			<PreferencesProvider>
				<ExternalLinkProvider client={{ supported, open }}>
					<MessageMarkdown
						source={'[Plain](https://example.test/plain) and [Titled](https://example.test/titled "Original title")'}
					/>
				</ExternalLinkProvider>
			</PreferencesProvider>,
		);
		const links = host.querySelectorAll(supported ? "a" : "p > span");
		assert.equal(links.length, 2);
		assert.equal(links[0]?.hasAttribute("title"), false);
		assert.equal(links[1]?.getAttribute("title"), "Original title");
		if (supported) assert.equal(links[0]?.getAttribute("href"), "https://example.test/plain");
		else assert.equal(host.querySelector("[href]"), null);
	}
	assert.equal(open.mock.calls.length, 0);
});
