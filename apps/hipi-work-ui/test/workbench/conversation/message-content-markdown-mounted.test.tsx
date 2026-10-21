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
vi.mock("../../../src/app/external-link-provider.tsx", () => ({
	useExternalLinks: () => ({ supported: true, open: vi.fn() }),
}));
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
let client: AppClient;
const freshClient = (): AppClient => ({
	call: vi.fn(async <M extends Method>(method: M) => parseResult(method, await result())),
	observe: vi.fn(async () => {
		throw new Error("No observation");
	}),
});
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
	client = freshClient();
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
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
test("a valid long user message hydrates automatically into the same user Markdown surface", async () => {
	const source = `**User instruction**\n\n${"Keep the original formatting. ".repeat(90)}`;
	assert.ok(source.length > LIMITS.messagePreview && source.length <= 4096);
	let resolve!: (value: MessageTextChunk) => void;
	result = () =>
		new Promise((done) => {
			resolve = done;
		});
	await render({ ...message, role: "user", text: source.slice(0, LIMITS.messagePreview), textLength: source.length });
	const surface = host.querySelector(".user-message-surface");
	assert.ok(surface);
	assert.equal(host.querySelector("strong")?.textContent, "User instruction");
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
	await act(async () => resolve(page(source)));
	assert.equal(host.querySelector(".user-message-surface"), surface);
	assert.equal(host.querySelector(".markdown-body")?.textContent?.includes("Keep the original formatting."), true);
	assert.ok((host.querySelector(".markdown-body")?.textContent?.length ?? 0) > LIMITS.messagePreview);
	assert.equal(host.querySelector(".original-text"), null);
	assert.equal(host.querySelector("button"), null);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.equal(hydrated.mock.lastCall?.[0], source);
});
test("user hydration respects selection and rejects another message's late body", async () => {
	let resolve!: (value: MessageTextChunk) => void;
	result = () =>
		new Promise((done) => {
			resolve = done;
		});
	await render({ ...message, role: "user" });
	const heading = host.querySelector("h1");
	assert.ok(heading);
	const before = host.querySelector(".markdown-body")?.textContent;
	await act(async () => {
		const range = document.createRange();
		range.selectNodeContents(heading);
		document.getSelection()?.addRange(range);
		resolve(page());
	});
	assert.equal(host.querySelector(".markdown-body")?.textContent, before);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(hydrated.mock.lastCall?.[0], full);
	result = async () => ({ ...page(), messageId: "foreign" });
	await render({ ...message, role: "user", id: "2_0" });
	assert.ok(host.querySelector('[role="alert"]'));
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
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
test("very long reply automatically joins transport chunks into one continuous rich message", async () => {
	const prefix = `# Long\n\n${"x".repeat(LIMITS.textChunk - 8)}`;
	const text = `${prefix}\n\n**final tail**`;
	let reads = 0;
	result = async () =>
		reads++ === 0
			? { ...page(prefix), textLength: text.length, nextOffset: LIMITS.textChunk }
			: { ...page(text.slice(LIMITS.textChunk)), offset: LIMITS.textChunk, textLength: text.length };
	await render({ ...message, text: text.slice(0, LIMITS.messagePreview), textLength: text.length });
	assert.equal(host.querySelector("h1")?.textContent, "Long");
	assert.equal(vi.mocked(client.call).mock.calls.length, 2);
	assert.equal(host.querySelector("strong")?.textContent, "final tail");
	assert.equal(host.querySelector("button"), null);
	assert.equal(host.querySelector(".original-text"), null);
	assert.equal(hydrated.mock.lastCall?.[0], text);
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

test("backgrounding cancels a pending read without controls and foregrounding resumes automatically", async () => {
	let resolve!: (value: MessageTextChunk) => void;
	result = () =>
		new Promise((done) => {
			resolve = done;
		});
	await render();
	const signal = vi.mocked(client.call).mock.calls[0]?.[2];
	assert.equal(host.querySelector("button"), null);
	await act(async () => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	assert.equal(signal?.aborted, true);
	await act(async () => resolve(page()));
	assert.equal(hydrated.mock.lastCall?.[0], undefined);
	result = async () => page();
	await act(async () => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	assert.equal(hydrated.mock.lastCall?.[0], full);
	assert.equal(host.querySelector("button"), null);
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

test("remote search snippet hydrates canonical Markdown before locating its source block", async () => {
	const text = `# Canonical\n\n${"a".repeat(9000)}\n\n[matched][id]\n\n[id]: https://example.com`;
	const start = text.indexOf("[matched]");
	const next = { ...message, text: text.slice(0, LIMITS.messagePreview), textLength: text.length };
	const anchor = {
		...scope,
		messages: [next],
		target: {
			...scope,
			messageId: next.id,
			text: "[matched][id]",
			offset: start,
			nextOffset: start + 13,
			textLength: text.length,
		},
		matchStart: start + 1,
		matchEnd: start + 8,
		olderCursor: null,
		newerCursor: null,
	};
	let resolve: ((value: MessageTextChunk) => void) | undefined;
	result = () =>
		new Promise((r) => {
			resolve = r;
		});
	const scroll = vi.fn();
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
	await act(async () =>
		renderer.render(
			<PreferencesProvider>
				<MessageContent message={next} scope={scope} searchAnchor={anchor} />
			</PreferencesProvider>,
		),
	);
	assert.equal(scroll.mock.calls.length, 0);
	assert.equal(host.querySelector("a"), null);
	await act(async () => resolve?.(page(text)));
	await act(async () => new Promise((r) => setTimeout(r, 25)));
	assert.equal(host.querySelector("h1")?.textContent, "Canonical");
	assert.equal(host.querySelector("a")?.textContent, "matched");
	assert.equal(host.querySelector("[data-search-match]")?.tagName, "P");
	assert.equal(host.querySelector("mark"), null);
	assert.equal(scroll.mock.calls.length, 0, "Document registration never steals transcript scroll ownership");
	delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

test("user search reveals the full retained bubble before source block positioning", async () => {
	const text = `${"intro\n\n".repeat(1800)}**target**`;
	const start = text.indexOf("**target**");
	const next: Message = {
		...message,
		role: "user",
		text: text.slice(0, LIMITS.messagePreview),
		textLength: text.length,
	};
	const anchor = {
		...scope,
		messages: [next],
		target: {
			...scope,
			messageId: next.id,
			text: "**target**",
			offset: start,
			nextOffset: null,
			textLength: text.length,
		},
		matchStart: start + 2,
		matchEnd: start + 8,
		olderCursor: null,
		newerCursor: null,
	};
	result = async () => page(text);
	await act(async () =>
		renderer.render(
			<PreferencesProvider>
				<MessageContent message={next} scope={scope} searchAnchor={anchor} />
			</PreferencesProvider>,
		),
	);
	await act(async () => new Promise((r) => setTimeout(r, 25)));
	assert.equal(host.querySelector(".user-message-fold")?.getAttribute("data-collapsed"), "false");
	assert.equal(host.querySelector("strong")?.textContent, "target");
	assert.equal(host.querySelector("[data-search-match]")?.textContent, "target");
	assert.equal(host.querySelector("mark"), null);
});
