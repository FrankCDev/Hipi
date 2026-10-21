// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type AppClient, type Conversation, type Method, type Params, parseResult } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { ConversationHeaderIdentity } from "../../../src/features/workbench/conversation/header.tsx";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

const original: Conversation = {
	workspaceId: "w",
	conversationId: "a",
	title: "Original",
	revision: 3,
	createdAt: 1,
	archivedAt: null,
};
let host: HTMLDivElement;
let root: Root;
let cache: QueryClient;
let catalog: CatalogSession;
let calls: { method: Method; params: unknown }[];
let handler: (method: Method, params: unknown) => Promise<unknown>;
let current: Conversation;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	current = original;
	calls = [];
	handler = async (method, params) => {
		if (method === "renameConversation") {
			const input = params as Params<"renameConversation">;
			current = { ...original, title: input.title, revision: input.expectedRevision + 1 };
			return current;
		}
		if (method === "getConversation") return current;
		if (method === "getConversationCommandResult") return null;
		throw new Error(method);
	};
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>) => {
			calls.push({ method, params });
			return parseResult(method, await handler(method, params));
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	catalog = new CatalogSession(client, new LocalState());
	cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	catalog.dispose();
	cache.clear();
	host.remove();
	localStorage.clear();
	vi.unstubAllGlobals();
});
async function render(item = original) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					<ConversationHeaderIdentity conversation={item} projectName="Project" session={catalog} />
				</PreferencesProvider>
			</QueryClientProvider>,
		),
	);
}
async function begin() {
	const button = host.querySelector<HTMLButtonElement>("button.conversation-header-title");
	assert.ok(button);
	await act(async () => button.click());
	const input = host.querySelector<HTMLInputElement>("input");
	assert.ok(input);
	return input;
}
async function type(input: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function key(input: HTMLInputElement, value: string, options: KeyboardEventInit = {}) {
	await act(async () =>
		input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })),
	);
}
const renames = () => calls.filter((call) => call.method === "renameConversation");

test("title is single-line editable identity; captured revision and current read own Enter/blur completion", async () => {
	await render();
	const project = host.querySelector(".conversation-header-project");
	assert.equal(project?.tagName, "SPAN");
	assert.equal(project?.getAttribute("aria-label"), "Project");
	assert.equal(host.querySelector(".toolbar-project-link"), null);
	const input = await begin();
	assert.equal(document.activeElement, input);
	assert.equal(input.selectionEnd, original.title.length);
	await type(input, "  New title  ");
	await render({ ...original, title: "External", revision: 9 });
	assert.equal(input.value, "  New title  ");
	await key(input, "Enter");
	await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
	assert.equal(renames().length, 1);
	const params = renames()[0]?.params as Params<"renameConversation">;
	assert.equal(params.expectedRevision, 3);
	assert.equal(params.title, "New title");
	assert.equal(host.querySelector("input"), null);
	assert.equal(cache.getQueryData<Conversation>(["conversation", "w", "a"])?.title, "New title");
});

test("Escape cancels without a write and restores focus; unchanged and blank titles are no-ops", async () => {
	await render();
	let input = await begin();
	await type(input, "Discard me");
	await key(input, "Escape");
	assert.equal(document.activeElement, host.querySelector("button.conversation-header-title"));
	assert.equal(renames().length, 0);
	input = await begin();
	await key(input, "Enter");
	input = await begin();
	await type(input, "   ");
	await key(input, "Enter");
	assert.equal(renames().length, 0);
	assert.equal(host.querySelector("input"), null);
});

test("IME confirming Enter/Escape do not commit or cancel; released Enter commits once", async () => {
	await render();
	const input = await begin();
	await act(async () => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
	await type(input, "中文标题");
	await key(input, "Enter", { isComposing: true });
	await key(input, "Escape", { isComposing: true });
	assert.equal(host.querySelector("input"), input);
	assert.equal(renames().length, 0);
	await act(async () => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
	await key(input, "Enter");
	assert.equal(renames().length, 0);
	await act(async () => input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })));
	await key(input, "Enter");
	assert.equal(renames().length, 1);
});

test("unknown rename retains draft and exact recovery request; repeated blur never silently resubmits", async () => {
	handler = async () => {
		throw new Error("Disconnected");
	};
	await render();
	const input = await begin();
	await type(input, "Keep this draft");
	await key(input, "Enter");
	assert.equal(input.value, "Keep this draft");
	assert.ok(host.querySelector('[role="alert"]'));
	assert.equal(catalog.getSnapshot().pending?.method, "renameConversation");
	await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
	await key(input, "Enter");
	assert.equal(renames().length, 1);
	const recovered = { ...original, title: "Keep this draft", revision: 4 };
	handler = async (method) =>
		method === "getConversationCommandResult" ? { method: "renameConversation", result: recovered } : recovered;
	await act(async () => catalog.check());
	assert.equal(catalog.getSnapshot().pending, null);
	assert.equal(host.querySelector("input"), null);
	assert.equal(host.querySelector('[role="alert"]'), null);
	assert.equal(renames().length, 1);
});

test("late completion after selecting another conversation cannot close or replace its editor", async () => {
	let release: (() => void) | undefined;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	handler = async (method) => {
		if (method === "renameConversation") {
			await wait;
			return { ...original, title: "Late", revision: 4 };
		}
		return { ...original, title: "Late", revision: 4 };
	};
	await render();
	const input = await begin();
	await type(input, "Late");
	await key(input, "Enter");
	await render({ ...original, conversationId: "b", title: "Other" });
	await act(async () => release?.());
	assert.equal(host.querySelector("button.conversation-header-title")?.textContent, "Other");
	assert.equal(host.querySelector('[role="alert"]'), null);
	assert.equal(cache.getQueryData(["conversation", "w", "b"]), undefined);
});

test("header geometry uses scoped font/spacing roles rather than changing native toolbar height", () => {
	const css = readFileSync("src/features/workbench/conversation/header.css", "utf8");
	assert.match(css, /--conversation-header-title-max: 20rem/);
	assert.match(css, /--conversation-header-title-size: var\(--font-ui-size\)/);
	assert.match(css, /font-weight: 500/);
	assert.match(css, /-webkit-app-region: no-drag/);
	assert.doesNotMatch(css, /app-region: drag|\.app-toolbar/);
});
