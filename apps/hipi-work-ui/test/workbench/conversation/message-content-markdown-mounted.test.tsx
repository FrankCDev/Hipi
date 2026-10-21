// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	LIMITS,
	type Message,
	type MessageTextChunk,
	type Method,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { MessageContent } from "../../../src/features/workbench/conversation/message-text-reader.tsx";

vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
const scope = { workspaceId: "workspace", conversationId: "conversation" };
const full = `# Heading\n\n**bold**\n\n- item\n\n${"ordinary response ".repeat(180)}`;
const message: Message = {
	id: "1_0",
	role: "assistant",
	text: full.slice(0, LIMITS.messagePreview),
	textLength: full.length,
	truncated: true,
};
const page = (text = full): MessageTextChunk => ({
	...scope,
	messageId: message.id,
	text,
	offset: 0,
	nextOffset: null,
	textLength: text.length,
});
let result: () => Promise<MessageTextChunk>;
const client: AppClient = {
	call: vi.fn(async <M extends Method>(method: M) => parseResult(method, await result())),
	observe: vi.fn(async () => {
		throw new Error("No observation");
	}),
};
let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;
let offset: number | undefined;
const hydrated = vi.fn();
async function render(next = message, streaming?: boolean, streamId?: string) {
	await act(async () =>
		renderer.render(
			<PreferencesProvider>
				<MessageContent
					message={next}
					scope={scope}
					offset={offset}
					onOffsetChange={(value) => {
						offset = value;
					}}
					streaming={streaming}
					streamId={streamId}
					onHydratedText={hydrated}
				/>
			</PreferencesProvider>,
		),
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	result = async () => page();
	offset = undefined;
	host = document.createElement("div");
	document.body.append(host);
	renderer = createRoot(host);
});
afterEach(async () => {
	await act(async () => renderer.unmount());
	document.getSelection()?.removeAllRanges();
	host.remove();
	vi.unstubAllGlobals();
});
test("normal long committed assistant hydrates one bounded page as full Markdown, without diagnostic or manual barrier", async () => {
	await render();
	assert.equal(host.querySelector("h1")?.textContent, "Heading");
	assert.equal(host.querySelector("strong")?.textContent, "bold");
	assert.equal(host.querySelector("li")?.textContent, "item");
	assert.ok((host.querySelector(".markdown-body")?.textContent?.length ?? 0) > LIMITS.messagePreview);
	assert.equal(host.querySelector(".original-text"), null);
	assert.equal(host.querySelector("button"), null);
	assert.equal(hydrated.mock.lastCall?.[0], full);
	assert.equal(host.textContent?.includes("UTF-16"), false);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.deepEqual(vi.mocked(client.call).mock.calls[0]?.slice(0, 2), [
		"getMessageText",
		{ ...scope, messageId: "1_0", offset: 0 },
	]);
});
test("short and truncated live assistant render Markdown without history reads", async () => {
	const text = "# Live\n\n**bold**";
	await render({ ...message, text, textLength: text.length, truncated: false });
	assert.equal(host.querySelector("h1")?.textContent, "Live");
	await render({ ...message, text, truncated: true }, true);
	assert.equal(host.querySelector("strong")?.textContent, "bold");
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
});
test("late hydration waits for selected preview release", async () => {
	let resolve!: (value: MessageTextChunk) => void;
	result = () =>
		new Promise((value) => {
			resolve = value;
		});
	await render();
	const heading = host.querySelector("h1");
	assert.ok(heading);
	const before = host.querySelector(".markdown-body")?.textContent;
	await act(async () => {
		const range = document.createRange();
		range.selectNodeContents(heading);
		const selection = document.getSelection();
		assert.ok(selection);
		selection.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		resolve(page());
	});
	assert.equal(host.querySelector("h1"), heading);
	assert.equal(host.querySelector(".markdown-body")?.textContent, before);
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.ok((host.querySelector(".markdown-body")?.textContent?.length ?? 0) > LIMITS.messagePreview);
});
test("replacement aborts an old read and ignores its late result", async () => {
	let resolve!: (value: MessageTextChunk) => void;
	result = () =>
		new Promise((value) => {
			resolve = value;
		});
	await render();
	const signal = vi.mocked(client.call).mock.calls[0]?.[2];
	result = async () => ({ ...page(), messageId: "2_0" });
	await render({ ...message, id: "2_0" });
	assert.equal(signal?.aborted, true);
	await act(async () => resolve({ ...page(), text: "# Stale" }));
	assert.equal(host.querySelector("h1")?.textContent, "Heading");
});
test("failed read retains Markdown preview and supports explicit retry", async () => {
	result = async () => {
		throw new Error("offline");
	};
	await render();
	assert.equal(host.querySelector("h1")?.textContent, "Heading");
	assert.ok(host.querySelector('[role="alert"]'));
	result = async () => page();
	const retry = host.querySelector("button");
	assert.ok(retry);
	await act(async () => retry.click());
	assert.equal(host.querySelector('[role="alert"]'), null);
	assert.equal(host.querySelector("button"), null);
});
test("very long reply reads only first page automatically and offers explicit continuation", async () => {
	const text = `# Long\n\n${"x".repeat(LIMITS.textChunk - 8)}`;
	result = async () => ({ ...page(text), textLength: LIMITS.textChunk + 200, nextOffset: LIMITS.textChunk });
	await render({ ...message, text: text.slice(0, LIMITS.messagePreview), textLength: LIMITS.textChunk + 200 });
	assert.equal(host.querySelector("h1")?.textContent, "Long");
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.equal(host.textContent?.includes("UTF-16"), false);
	const next = host.querySelector("button");
	assert.ok(next);
	await act(async () => next.click());
	assert.equal(offset, LIMITS.textChunk);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
});

test("matching observer stream identity retains its displayed prefix until hydration, not another stream", async () => {
	await render({ ...message, id: "live", text: full, truncated: false }, true, "stream:one");
	const displayed = host.querySelector(".markdown-body")?.textContent;
	let resolve!: (value: MessageTextChunk) => void;
	result = () =>
		new Promise((value) => {
			resolve = value;
		});
	await render(message, undefined, "stream:one");
	assert.equal(host.querySelector(".markdown-body")?.textContent, displayed);
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
	const canonical = `${full.slice(0, -8)}changed!`;
	await act(async () => resolve(page(canonical)));
	assert.equal(hydrated.mock.lastCall?.[0], canonical);
	assert.ok(host.querySelector(".markdown-body")?.textContent?.endsWith("changed!"));
	await render({ ...message, id: "other-live", text: full, truncated: false }, true, "stream:two");
	result = () => new Promise(() => {});
	await render({ ...message, id: "2_0" }, undefined, "stream:three");
	assert.notEqual(host.querySelector(".markdown-body")?.textContent, displayed);
});

test("cancel retains preview, blocks late publication, and permits explicit resume", async () => {
	let resolve!: (value: MessageTextChunk) => void;
	result = () =>
		new Promise((value) => {
			resolve = value;
		});
	await render();
	const signal = vi.mocked(client.call).mock.calls[0]?.[2];
	const cancel = host.querySelector("button");
	assert.ok(cancel);
	await act(async () => cancel.click());
	assert.equal(signal?.aborted, true);
	await act(async () => resolve(page()));
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
	const resume = host.querySelector("button");
	assert.ok(resume);
	result = async () => page();
	await act(async () => resume.click());
	assert.equal(hydrated.mock.lastCall?.[0], full);
});

test.each(["scope", "length"])("rejects a mismatched %s before publishing canonical content", async (mismatch) => {
	result = async () => ({
		...page(),
		...(mismatch === "scope" ? { conversationId: "foreign" } : { textLength: full.length + 1 }),
	});
	await render();
	assert.ok(host.querySelector('[role="alert"]'));
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
	assert.ok((host.querySelector(".markdown-body")?.textContent?.length ?? 0) < full.length);
});
