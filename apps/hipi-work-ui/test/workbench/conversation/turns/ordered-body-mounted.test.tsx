// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type AppClient, type Message, type Method, parseResult } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { ThemeProvider } from "../../../../src/app/theme/provider.tsx";
import { AssistantClipboardCopy } from "../../../../src/features/workbench/conversation/markdown/assistant-clipboard-copy.tsx";
import { assistantCopyPayload } from "../../../../src/features/workbench/conversation/markdown/assistant-copy-payload.ts";
import { MessageContent } from "../../../../src/features/workbench/conversation/message-text-reader.tsx";
import { OrderedAssistantBody } from "../../../../src/features/workbench/conversation/presentation/ordered-body.tsx";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
const source = "# Before\nAfter **bold**";
const message: Message = {
	id: "5_0",
	role: "assistant",
	text: source,
	textLength: source.length,
	truncated: false,
	toolCalls: {
		total: 2,
		items: [
			{ contentIndex: 1, callId: "same", name: "read" },
			{ contentIndex: 3, callId: "same", name: "read" },
		],
	},
	publicBlocks: {
		omitted: false,
		total: 4,
		items: [
			{ kind: "text", contentIndex: 0, start: 0, end: 9 },
			{ kind: "tool", contentIndex: 1 },
			{ kind: "text", contentIndex: 2, start: 9, end: source.length },
			{ kind: "tool", contentIndex: 3 },
		],
	},
};
async function show(value = message, canonical = true) {
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<ThemeProvider>
					<OrderedAssistantBody
						message={value}
						source={source}
						canonical={canonical}
						renderActivities={(index) => (
							<span data-tool={index?.join(",") ?? "all"}>Tool {index?.join(",") ?? "all"}</span>
						)}
					/>
				</ThemeProvider>
			</PreferencesProvider>,
		),
	);
}
test("committed canonical text and duplicate-call tools retain actual contentIndex order", async () => {
	await show();
	const body = host.querySelector<HTMLElement>("[data-assistant-public-body]");
	assert.ok(body);
	assert.deepEqual(
		Array.from(body.children).map((node) => node.textContent),
		["Before", "Tool 1", "After bold", "Tool 3"],
	);
	assert.equal(host.querySelectorAll("h1").length, 1);
	const copy = assistantCopyPayload(body, source);
	assert.match(copy.plain, /Before/);
	assert.match(copy.plain, /After bold/);
	assert.doesNotMatch(copy.plain, /Tool/);
	assert.doesNotMatch(copy.html ?? "", /Tool/);
});

test("empty public text adds no spacer and does not split adjacent tool groups", async () => {
	const tools: Message = {
		...message,
		text: "",
		textLength: 0,
		publicBlocks: {
			total: 5,
			omitted: false,
			items: [
				{ kind: "text", contentIndex: 0, start: 0, end: 0 },
				{ kind: "tool", contentIndex: 1 },
				{ kind: "text", contentIndex: 2, start: 0, end: 0 },
				{ kind: "tool", contentIndex: 3 },
				{ kind: "text", contentIndex: 4, start: 0, end: 0 },
			],
		},
	};
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<ThemeProvider>
					<OrderedAssistantBody
						message={tools}
						source=""
						canonical
						renderActivities={(indexes) => <span data-tool={indexes?.join(",")}>Tool</span>}
					/>
				</ThemeProvider>
			</PreferencesProvider>,
		),
	);
	const body = host.querySelector("[data-assistant-public-body]");
	assert.ok(body);
	assert.equal(body.children.length, 1);
	assert.equal(body.querySelector(".markdown-body"), null);
	assert.ok(body.querySelector('[data-tool="1,3"]'));
});
test("unknown, omitted, incomplete or invalid ordering retains canonical Markdown and one fallback tool group", async () => {
	for (const value of [
		{ ...message, publicBlocks: undefined },
		{ ...message, publicBlocks: { ...message.publicBlocks, items: [], total: 4, omitted: true } },
		{
			...message,
			publicBlocks: {
				items: [{ kind: "text" as const, contentIndex: 0, start: 1, end: source.length }],
				total: 1,
				omitted: false,
			},
		},
	]) {
		await show(value);
		assert.equal(host.querySelector("[data-assistant-public-body]"), null);
		assert.equal(host.querySelectorAll('[data-tool="all"]').length, 1);
		assert.equal(host.querySelector("h1")?.textContent, "Before");
	}
	await show(message, false);
	assert.equal(host.querySelectorAll('[data-tool="all"]').length, 1);
});

test("completed multi-block copy selects every public text block but no tool or reader diagnostics", async () => {
	const article = { current: document.createElement("article") };
	article.current.innerHTML =
		'<div class="message-content"><div data-assistant-message-body><div data-assistant-public-body><div class="markdown-body" data-markdown-tone="assistant"><h2>Before</h2></div><div data-markdown-copy="exclude">private tool output<button>Details</button></div><div class="markdown-body" data-markdown-tone="assistant"><p>After <strong>bold</strong></p></div></div><div class="original-text">reader diagnostic</div></div></div>';
	const writeText = vi.fn(async (_text: string) => {});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	vi.stubGlobal("ClipboardItem", undefined);
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<AssistantClipboardCopy article={article} text={source} label="Copy" />
			</PreferencesProvider>,
		),
	);
	await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
	assert.deepEqual(writeText.mock.calls, [["Before\n\nAfter bold"]]);
});

test("multiple public blocks hydrate through exactly one canonical reader before interleaving", async () => {
	const full = `# Before\n${"a".repeat(2200)}\nAfter **bold**`;
	const split = 2210;
	const value: Message = {
		...message,
		text: full.slice(0, 2048),
		textLength: full.length,
		truncated: true,
		publicBlocks: {
			items: [
				{ kind: "text", contentIndex: 0, start: 0, end: split },
				{ kind: "tool", contentIndex: 1 },
				{ kind: "text", contentIndex: 2, start: split, end: full.length },
				{ kind: "tool", contentIndex: 3 },
			],
			total: 4,
			omitted: false,
		},
	};
	const call = vi.fn(async <M extends Method>(method: M) =>
		parseResult(method, {
			workspaceId: "w",
			conversationId: "c",
			messageId: value.id,
			text: full,
			offset: 0,
			nextOffset: null,
			textLength: full.length,
		}),
	);
	const client: AppClient = {
		call,
		observe: async () => {
			throw Error("No observation");
		},
	};
	const accepted = vi.fn();
	await act(async () =>
		root.render(
			<AppClientProvider client={client}>
				<PreferencesProvider>
					<ThemeProvider>
						<MessageContent
							message={value}
							scope={{ workspaceId: "w", conversationId: "c" }}
							offset={undefined}
							onOffsetChange={() => {}}
							onHydratedText={accepted}
							renderActivities={(indexes) => <span data-tool={indexes?.join(",") ?? "all"}>tool</span>}
						/>
					</ThemeProvider>
				</PreferencesProvider>
			</AppClientProvider>,
		),
	);
	assert.equal(call.mock.calls.length, 1);
	assert.equal(call.mock.calls[0]?.[0], "getMessageText");
	assert.equal(accepted.mock.lastCall?.[0], full);
	assert.equal(host.querySelectorAll('[data-tool="all"]').length, 0);
	assert.equal(host.querySelectorAll("[data-tool]").length, 2);
	assert.ok(host.querySelector("[data-assistant-public-body]"));
});
