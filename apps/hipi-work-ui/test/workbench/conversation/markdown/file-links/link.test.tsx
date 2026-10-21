// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, type ComponentProps } from "react";
import type * as Runtime from "react/jsx-dev-runtime";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../../../src/app/preferences.tsx";
import { ProjectFileLink } from "../../../../../src/features/workbench/conversation/markdown/file-links/link.tsx";
import { ProjectFileLinkCapability } from "../../../../../src/features/workbench/conversation/markdown/file-links/provider.tsx";
import { MessageMarkdown } from "../../../../../src/features/workbench/conversation/markdown/markdown.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const captured = vi.hoisted(() => ({ buttons: [] as ComponentProps<"button">[] }));
// Trusted callback fixture, not native pointer or pixel acceptance.
vi.mock("react/jsx-dev-runtime", async (original) => {
	const actual = await original<typeof Runtime>();
	return {
		...actual,
		jsxDEV: (type: Parameters<typeof actual.jsxDEV>[0], props: Parameters<typeof actual.jsxDEV>[1], key?: string) => {
			if (type === "button" && props.className === "markdown-file-link")
				captured.buttons.push(props as ComponentProps<"button">);
			return actual.jsxDEV(type, props, key, false, undefined, undefined);
		},
	};
});
afterEach(() => {
	captured.buttons.length = 0;
	vi.unstubAllGlobals();
});
const event = (trusted = true) => ({ button: 0, nativeEvent: { isTrusted: trusted }, preventDefault() {} });

test("settled project references are click-only controls, never browser hrefs or resource loads", () => {
	const open = vi.fn(async () => {});
	const render = (source: string, available = true, streaming = false) =>
		renderToStaticMarkup(
			<PreferencesProvider>
				<ProjectFileLinkCapability value={available ? { open } : undefined}>
					<MessageMarkdown source={source} streaming={streaming} />
				</ProjectFileLinkCapability>
			</PreferencesProvider>,
		);
	assert.match(render("[Read](docs/note.md)"), /class="markdown-file-link"/);
	assert.match(render("[说明](文档/使用说明.md)"), /class="markdown-file-link"/);
	assert.match(render("[Read](docs/my%20note.md)"), /class="markdown-file-link"/);
	assert.doesNotMatch(render("[Read](docs/note.md)"), /href=|src=/);
	assert.doesNotMatch(render("[Read](docs/note.md)", false), /class="markdown-file-link"/);
	for (const source of [
		"[Read](docs/note",
		"[Read](./docs/note.md",
		"[Read][ref]\n\n[ref]: docs/note",
		"[Read](docs/note.md#L2)",
		"[Read](file:///tmp/note.md)",
		"[Read](/tmp/note.md)",
		"[Read](../note.md)",
		"![image](docs/note.png)",
	])
		assert.doesNotMatch(render(source, true, true), /class="markdown-file-link"|href=|src=/, source);
	assert.match(render("[Read](./docs/note.md)", true, true), /class="markdown-file-link"/);
	assert.equal(open.mock.calls.length, 0);
});

test("only explicit trusted activation admits one request; rendering and hover never read files", async () => {
	const pending = new Promise<void>(() => {});
	const open = vi.fn(() => pending);
	renderToStaticMarkup(
		<PreferencesProvider>
			<ProjectFileLinkCapability value={{ open }}>
				<ProjectFileLink path="note.md">Read</ProjectFileLink>
			</ProjectFileLinkCapability>
		</PreferencesProvider>,
	);
	const button = captured.buttons.at(-1);
	assert.ok(button?.onClick);
	assert.equal(open.mock.calls.length, 0);
	assert.equal(button.onMouseEnter, undefined);
	Reflect.apply(button.onClick, undefined, [event(false)]);
	assert.equal(open.mock.calls.length, 0);
	Reflect.apply(button.onClick, undefined, [event()]);
	Reflect.apply(button.onClick, undefined, [event()]);
	assert.equal(open.mock.calls.length, 1);
	assert.equal(open.mock.calls[0]?.[0], "note.md");
});

test("mounted owner changes abort late feedback; current failures are honest and retryable", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const pending: { reject: (error: Error) => void; signal: AbortSignal }[] = [];
	const open = vi.fn(
		(_path: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => pending.push({ reject, signal })),
	);
	const first = { open },
		second = { open };
	const render = (path: string, capability = first) =>
		act(() =>
			root.render(
				<PreferencesProvider>
					<ProjectFileLinkCapability value={capability}>
						<ProjectFileLink path={path}>Read</ProjectFileLink>
					</ProjectFileLinkCapability>
				</PreferencesProvider>,
			),
		);
	const activate = async () => {
		const onClick = captured.buttons.at(-1)?.onClick;
		assert.ok(onClick);
		await act(() => {
			Reflect.apply(onClick, undefined, [event()]);
		});
	};
	try {
		await render("a.md");
		await activate();
		await render("b.md");
		assert.equal(pending[0]?.signal.aborted, true);
		await act(() => pending[0]?.reject(new Error("late")));
		assert.equal(host.querySelector('[role="alert"]'), null);
		await activate();
		await render("b.md", second);
		assert.equal(pending[1]?.signal.aborted, true);
		await act(() => pending[1]?.reject(new Error("retired")));
		assert.equal(host.querySelector('[role="alert"]'), null);
		await activate();
		await act(() => pending[2]?.reject(new Error("missing")));
		assert.ok(host.querySelector('[role="alert"]'));
		await activate();
		await act(() => root.unmount());
		assert.equal(pending[3]?.signal.aborted, true);
		await act(() => pending[3]?.reject(new Error("closed")));
		assert.equal(host.innerHTML, "");
	} finally {
		await act(() => root.unmount());
		host.remove();
	}
});

test("a mounted streaming destination becomes actionable only when explicitly closed; settled controls retain identity", async () => {
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	const host = document.createElement("div");
	const root = createRoot(host);
	const open = vi.fn(async () => {});
	const capability = { open };
	const prefix = "[Stable](docs/stable.md)\n\n";
	const render = (tail: string, streaming = true) =>
		act(() =>
			root.render(
				<PreferencesProvider>
					<ProjectFileLinkCapability value={capability}>
						<MessageMarkdown source={prefix + tail} streaming={streaming} streamId="files" />
					</ProjectFileLinkCapability>
				</PreferencesProvider>,
			),
		);
	try {
		await render("[Read](docs/note");
		const stable = host.querySelector(".markdown-file-link");
		assert.ok(stable);
		assert.equal(host.querySelectorAll(".markdown-file-link").length, 1);
		await render("[Read](docs/note.md");
		assert.equal(host.querySelectorAll(".markdown-file-link").length, 1);
		await render("[Read](docs/note.md)");
		assert.equal(host.querySelectorAll(".markdown-file-link").length, 2);
		assert.equal(host.querySelector(".markdown-file-link"), stable);
		await render("[Read](docs/note.md)", false);
		assert.equal(host.querySelector(".markdown-file-link"), stable);
		assert.equal(open.mock.calls.length, 0);
	} finally {
		await act(() => root.unmount());
	}
});
