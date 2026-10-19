import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { Icon } from "../src/components/ui/icon.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../src/components/ui/input-group.tsx";
import { CreateDialog } from "../src/features/workbench/create-dialog.tsx";
import { Workbench } from "../src/features/workbench/workbench.tsx";

vi.mock("../src/app/client-provider.tsx", () => ({
	useCredentialClient: () => undefined,
	useFiles: () => ({}),
	useAppClient: () => ({ call: vi.fn() }),
	useLocalState: () => ({ read: () => null, hasUnsavedWork: () => false }),
}));

test("workbench search groups the icon and input inside one border with a real translated label", () => {
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
	const label = html.match(/<label class="sr-only" for="([^"]+)">搜索会话<\/label>/);
	assert.ok(label);
	const group = html.match(/<div data-slot="input-group"[\s\S]*?<\/div><\/div>/)?.[0];
	assert.ok(group);
	assert.ok(group.includes(`id="${label[1]}"`));
	assert.ok(group.includes(`aria-describedby="${label[1]}-scope"`));
	assert.match(group, /<input data-slot="input-group-control"/);
	assert.match(group, /data-slot="input-group-addon"[^>]*data-align="inline-start"[\s\S]*<svg aria-hidden="true"/);
	const input = group.match(/<input\b[^>]*>/)?.[0];
	assert.ok(input);
	assert.match(input, /focus-visible:ring-0/);
	assert.doesNotMatch(input, /focus-visible:ring-\[3px\](?: |")/);
	const scopeButton = group.match(/<button\b[^>]*aria-label="搜索范围"[^>]*>/)?.[0];
	assert.ok(scopeButton);
	assert.match(scopeButton, /focus-visible:ring-\[3px\]/);
});

test("compact create actions retain one named button with the official size and dialog trigger", () => {
	for (const kind of ["workspace", "conversation"] as const) {
		const cache = new QueryClient();
		const html = renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					<CreateDialog kind={kind} compact onCreate={async () => {}} />
				</PreferencesProvider>
			</QueryClientProvider>,
		);
		cache.clear();
		assert.equal((html.match(/<button\b/g) ?? []).length, 1);
		assert.match(html, /data-size="icon-sm"/);
		assert.match(html, /data-variant="outline"/);
		assert.match(html, /aria-haspopup="dialog"/);
		assert.ok(html.includes(`aria-label="${kind === "workspace" ? "新建工作区" : "新建会话"}"`));
	}
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
	assert.match(css, /\.nav-search\s*\{\s*margin: 12px 0 7px;\s*\}/);
	assert.doesNotMatch(css, /\.nav-search input|\.composer textarea/);
});
