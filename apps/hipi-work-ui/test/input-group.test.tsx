import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import type * as Query from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import type * as Preferences from "../src/app/preferences.tsx";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { Icon } from "../src/components/ui/icon.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../src/components/ui/input-group.tsx";
import { CreateDialog } from "../src/features/workbench/create-dialog.tsx";
import { Workbench } from "../src/features/workbench/workbench.tsx";

type WorkspaceMutation = {
	mutationFn: (name: string) => Promise<void>;
	onSuccess: () => void;
	onSettled: () => void;
};
const hooks = vi.hoisted(() => ({
	active: false,
	cells: [] as unknown[],
	cursor: 0,
	pending: false,
	error: false,
	completion: Promise.resolve(),
}));
// Only direct workspace callback tests use this bounded hook adapter; SSR keeps the real hooks.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useState: <T,>(initial: T | (() => T)) => {
			// biome-ignore lint/correctness/useHookAtTopLevel: Test mode selects a direct callback harness or an unchanged real SSR render.
			if (!hooks.active) return actual.useState(initial);
			const index = hooks.cursor++;
			if (!(index in hooks.cells))
				hooks.cells[index] = typeof initial === "function" ? (initial as () => T)() : initial;
			return [
				hooks.cells[index],
				(value: T) => {
					hooks.cells[index] = value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			// biome-ignore lint/correctness/useHookAtTopLevel: Test mode selects a direct callback harness or an unchanged real SSR render.
			if (!hooks.active) return actual.useRef(initial);
			const index = hooks.cursor++;
			if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
			return hooks.cells[index];
		},
		// biome-ignore lint/correctness/useHookAtTopLevel: Test mode selects a direct callback harness or an unchanged real SSR render.
		useId: () => (hooks.active ? `workspace-${hooks.cursor++}` : actual.useId()),
	};
});
vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<typeof Query>("@tanstack/react-query");
	return {
		...actual,
		useMutation: (options: WorkspaceMutation) =>
			hooks.active
				? {
						get isPending() {
							return hooks.pending;
						},
						get isError() {
							return hooks.error;
						},
						mutate: (name: string) => {
							hooks.pending = true;
							hooks.completion = options
								.mutationFn(name)
								.then(options.onSuccess)
								.catch(() => {
									hooks.error = true;
								})
								.finally(() => {
									hooks.pending = false;
									options.onSettled();
								});
						},
						reset: () => {
							hooks.error = false;
						},
					}
				: // biome-ignore lint/correctness/useHookAtTopLevel: The production mutation hook remains unchanged for SSR tests.
					actual.useMutation(options),
	};
});
vi.mock("../src/app/preferences.tsx", async () => {
	const actual = await vi.importActual<typeof Preferences>("../src/app/preferences.tsx");
	// biome-ignore lint/correctness/useHookAtTopLevel: Real providers are retained for SSR; direct callback tests need only translation keys.
	return { ...actual, usePreferences: () => (hooks.active ? { t: (key: string) => key } : actual.usePreferences()) };
});
vi.mock("../src/app/client-provider.tsx", () => ({
	useCredentialClient: () => undefined,
	useFiles: () => ({}),
	useAppClient: () => ({ call: vi.fn() }),
	useLocalState: () => ({ read: () => null, hasUnsavedWork: () => false }),
}));

afterEach(() => {
	hooks.active = false;
});

test("header search keeps a hidden, labeled input group with truthful scope until it is opened", () => {
	const cache = new QueryClient();
	cache.setQueryData(["workspaces"], []);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<PreferencesProvider>
				<Workbench disconnect={() => {}} />
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	cache.clear();
	const label = html.match(/<label class="sr-only" for="([^"]+)">搜索聊天<\/label>/);
	assert.ok(label);
	assert.ok(html.includes(`class="sidebar-search-panel" id="${label[1]}-panel" hidden=""`));
	assert.match(html, /aria-label="搜索聊天"[^>]*aria-expanded="false"/);
	const group = html.match(/<div data-slot="input-group"[\s\S]*?<\/div><\/div>/)?.[0];
	assert.ok(group);
	assert.ok(group.includes(`id="${label[1]}"`));
	assert.ok(group.includes(`aria-describedby="${label[1]}-scope"`));
	assert.match(group, /<input\b[^>]*data-slot="input-group-control"/);
	assert.match(group, /data-slot="input-group-addon"[^>]*data-align="inline-start"[\s\S]*<svg aria-hidden="true"/);
	const input = group.match(/<input\b[^>]*>/)?.[0];
	assert.ok(input);
	assert.match(input, /focus-visible:ring-0/);
	assert.doesNotMatch(input, /focus-visible:ring-\[3px\](?: |")/);
	const closeButton = group.match(/<button\b[^>]*aria-label="关闭搜索"[^>]*>/)?.[0];
	assert.ok(closeButton);
	assert.match(closeButton, /focus-visible:outline-2/);
	assert.match(html, /class="search-scope"[^>]*>仅搜索已展开项目中已加载并显示的会话，不代表全部历史。<\/p>/);
	assert.doesNotMatch(html, /aria-label="搜索范围"/);
});

test("compact project creation retains one named button with the official size and dialog trigger", () => {
	const cache = new QueryClient();
	const html = renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<PreferencesProvider>
				<CreateDialog kind="workspace" compact onCreate={async () => {}} />
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	cache.clear();
	assert.equal((html.match(/<button\b/g) ?? []).length, 1);
	assert.match(html, /data-size="icon-sm"/);
	assert.match(html, /data-variant="ghost"/);
	assert.match(html, /aria-haspopup="dialog"/);
	assert.match(html, /aria-label="新建项目"/);
});

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function nodes(node: React.ReactNode): Node[] {
	if (Array.isArray(node)) return node.flatMap(nodes);
	if (!isValidElement<Record<string, unknown> & { children?: React.ReactNode }>(node)) return [];
	return [node, ...nodes(node.props.children)];
}
function workspaceHarness(onCreate: (name: string) => Promise<void>) {
	hooks.active = true;
	hooks.cells = [];
	hooks.pending = false;
	hooks.error = false;
	const onOpenChange = vi.fn();
	function render(disabled = false) {
		hooks.cursor = 0;
		return CreateDialog({ kind: "workspace", onCreate, onOpenChange, disabled });
	}
	function find(type: React.ElementType, className?: string) {
		const node = nodes(render()).find(
			(item) => item.type === type && (!className || item.props.className === className),
		);
		assert.ok(node);
		return node;
	}
	function invoke(node: Node, key: string, event?: unknown) {
		const callback = node.props[key];
		assert.equal(typeof callback, "function");
		Reflect.apply(callback as (...args: unknown[]) => void, undefined, event === undefined ? [] : [event]);
	}
	return { render, find, invoke, onOpenChange };
}

test("project creation submits its trimmed name once and cannot close while pending", async () => {
	let complete: (() => void) | undefined;
	const onCreate = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
	);
	const { find, invoke, onOpenChange } = workspaceHarness(onCreate);
	invoke(find(Dialog), "onOpenChange", true);
	invoke(find(Input), "onChange", { target: { value: "  Named project  " } });
	const create = find(Button, "task-create-confirm");
	invoke(create, "onClick");
	invoke(create, "onClick");
	invoke(find(Dialog), "onOpenChange", false);
	assert.deepEqual(onCreate.mock.calls, [["Named project"]]);
	assert.deepEqual(onOpenChange.mock.calls, [[true]]);
	assert.equal(find(Input).props.disabled, true);
	assert.ok(complete);
	complete();
	await hooks.completion;
	assert.deepEqual(onOpenChange.mock.calls, [[true], [false]]);
	assert.equal(find(Input).props.value, "");
});

test("project creation keeps uncertain input and requires closing before another attempt", async () => {
	const onCreate = vi.fn(async (_name: string) => {
		throw new Error("Unknown creation outcome");
	});
	const { find, invoke } = workspaceHarness(onCreate);
	invoke(find(Input), "onChange", { target: { value: "Keep this project" } });
	invoke(find(Button, "task-create-confirm"), "onClick");
	await hooks.completion;
	assert.equal(find(Input).props.value, "Keep this project");
	assert.equal(find(Button, "task-create-confirm").props.disabled, true);
	invoke(find(Button, "task-create-confirm"), "onClick");
	assert.equal(onCreate.mock.calls.length, 1);
	invoke(find(Dialog), "onOpenChange", false);
	assert.equal(find(Button, "task-create-confirm").props.disabled, false);
});

test("project name Enter respects IME confirmation and implicit form submission never creates", async () => {
	const onCreate = vi.fn(async (_name: string) => {});
	const { find, invoke } = workspaceHarness(onCreate);
	invoke(find(Input), "onChange", { target: { value: "项目" } });
	const event = {
		nativeEvent: {
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			altKey: false,
			isComposing: false,
			keyCode: 13,
			repeat: false,
			timeStamp: 1000,
		},
		preventDefault: vi.fn(),
	};
	invoke(find(Input), "onCompositionStart");
	invoke(find(Input), "onKeyDown", event);
	invoke(find("form"), "onSubmit", event);
	assert.equal(onCreate.mock.calls.length, 0);
	invoke(find(Input), "onCompositionEnd", { timeStamp: 990 });
	invoke(find(Input), "onKeyDown", event);
	assert.equal(onCreate.mock.calls.length, 0);
	invoke(find(Input), "onKeyUp");
	invoke(find(Input), "onKeyDown", event);
	assert.deepEqual(onCreate.mock.calls, [["项目"]]);
	await hooks.completion;
});

test("Tailwind emits group focus, addon spacing and disabled colors without legacy search overrides", async () => {
	const html = renderToStaticMarkup(
		<InputGroup className="nav-search">
			<InputGroupInput disabled placeholder="Search" />
			<InputGroupAddon>
				<Icon name="search" />
			</InputGroupAddon>
		</InputGroup>,
	);
	const candidates = Array.from(html.matchAll(/class="([^"]*)"/g)).flatMap((match) =>
		match[1]
			.replaceAll("&gt;", ">")
			.replaceAll("&lt;", "<")
			.replaceAll("&amp;", "&")
			.replaceAll("&#x27;", "'")
			.split(" "),
	);
	const theme = await readFile(new URL("../src/theme.css", import.meta.url), "utf8");
	const compiler = await compile(theme, {
		base: fileURLToPath(new URL("../src", import.meta.url)),
		onDependency: () => {},
	});
	const css = compiler.build(candidates);
	assert.match(
		css,
		/:has\(:is\(\[data-slot=input-group-control\]:focus-visible\)\)\s*\{[^{}]*--tw-ring-color: var\(--focus\)/,
	);
	assert.match(
		css,
		/:has\( > \[data-align=inline-start\]\) > input\s*\{\s*padding-left: calc\(var\(--spacing\) \* 2\)/,
	);
	assert.match(css, /\.pl-3[\s\S]*?padding-left: calc\(var\(--spacing\) \* 3\)/);
	assert.match(css, /:focus-visible\s*\{[^{}]*calc\(0px \+ var\(--tw-ring-offset-width\)\)/);
	assert.match(css, /:disabled::placeholder\s*\{\s*color: var\(--disabled-text\)/);
	assert.match(
		css,
		/:has\(:is\(\[data-slot=input-group-control\]:disabled\)\)\s*\{\s*background-color: var\(--disabled-surface\)/,
	);
	assert.match(css, /\.nav-search\s*\{[^{}]*margin: 8px 0 0;[^{}]*background: transparent;[^{}]*\}/);
	assert.match(css, /\.nav-search:focus-within\s*\{[^{}]*background: var\(--raised\);/);
	assert.doesNotMatch(css, /\.nav-search input|\.composer textarea/);
});
