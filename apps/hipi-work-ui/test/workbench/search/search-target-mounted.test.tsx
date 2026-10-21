// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type Message,
	type MessageTextChunk,
	type Method,
	parseResult,
	type Scope,
	type SearchHistoryWindow,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { messageDocumentPool } from "../../../src/features/workbench/conversation/document/pool.ts";
import { MessageContent } from "../../../src/features/workbench/conversation/message-text-reader.tsx";

const scope: Scope = { workspaceId: "closed", conversationId: "unloaded" };
const paragraph = "😀 **NeEdLe** &amp; 中文";
const prefix = `# Canonical\n\n${"x".repeat(8985)}\n\n`;
const source = `${prefix}${paragraph}\n\n${"tail ".repeat(2200)}`;
const matchStart = prefix.length + paragraph.indexOf("NeEdLe");
const matchEnd = matchStart + "NeEdLe".length;
const observers = new Set<() => void>();
let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			callback: () => void;
			constructor(callback: () => void) {
				this.callback = callback;
			}
			observe() {
				observers.add(this.callback);
			}
			disconnect() {
				observers.delete(this.callback);
			}
		},
	);
	const computed = window.getComputedStyle.bind(window);
	vi.stubGlobal("getComputedStyle", (node: Element) => {
		const style = computed(node);
		if (node.classList.contains("user-message-body")) Object.defineProperty(style, "lineHeight", { value: "20px" });
		return style;
	});
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 600));
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	host = document.createElement("div");
	document.body.append(host);
	renderer = createRoot(host);
});

afterEach(async () => {
	await act(async () => renderer.unmount());
	assert.equal(observers.size, 0);
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function fixture(role: "user" | "assistant", truncated: boolean) {
	const message: Message = {
		id: "1_0",
		role,
		text: truncated ? source.slice(0, 2000) : source,
		textLength: source.length,
		truncated,
	};
	const searchAnchor: SearchHistoryWindow = {
		...scope,
		messages: [message],
		target: {
			...scope,
			messageId: message.id,
			text: paragraph,
			offset: prefix.length,
			nextOffset: prefix.length + paragraph.length,
			textLength: source.length,
		},
		matchStart,
		matchEnd,
		olderCursor: null,
		newerCursor: "opaque",
	};
	const canonical: MessageTextChunk = {
		...scope,
		messageId: message.id,
		text: source,
		offset: 0,
		nextOffset: null,
		textLength: source.length,
	};
	return { message, searchAnchor, canonical };
}

async function render(client: AppClient, message: Message, searchAnchor: SearchHistoryWindow) {
	await act(async () => {
		renderer.render(
			<AppClientProvider client={client}>
				<PreferencesProvider>
					<MessageContent message={message} scope={scope} searchAnchor={searchAnchor} />
				</PreferencesProvider>
			</AppClientProvider>,
		);
	});
	await act(async () => new Promise((resolve) => requestAnimationFrame(resolve)));
}

function assertCanonicalTarget(role: Message["role"]) {
	assert.equal(source.slice(matchStart, matchEnd), "NeEdLe");
	const target = host.querySelector<HTMLElement>("[data-search-match]");
	assert.ok(target);
	assert.equal(target.tagName, "P");
	assert.equal(target.innerHTML, "😀 <strong>NeEdLe</strong> &amp; 中文");
	assert.equal(Number(target.dataset.markdownSourceStart), prefix.length);
	assert.equal(Number(target.dataset.markdownSourceEnd), prefix.length + paragraph.length);
	assert.equal(host.querySelectorAll("[data-search-match]").length, 1);
	assert.equal(host.querySelector("mark, .search-match-text, .original-text"), null);
	assert.equal(host.querySelector("h1")?.textContent, "Canonical");
	assert.match(host.textContent ?? "", /tail tail/);
	assert.doesNotMatch(host.textContent ?? "", /9000–|UTF-16|下一页|刷新本页/);
	assert.ok(host.querySelector('[data-message-document-complete="true"]'));
	if (role === "user") {
		assert.equal(host.querySelector(".user-message-fold")?.getAttribute("data-collapsed"), "false");
		assert.equal(host.querySelector(".user-message-expand")?.getAttribute("aria-expanded"), "true");
	}
}

test.each(["user", "assistant"] as const)(
	"a complete %s canonical source locates its UTF-16 match in the rich block without text reads",
	async (role) => {
		const call = vi.fn(async () => {
			throw new Error("Complete canonical content must not request text");
		});
		const observe = vi.fn(async () => {
			throw new Error("Search navigation must not observe execution");
		});
		const { message, searchAnchor } = fixture(role, false);
		await render({ call, observe }, message, searchAnchor);
		assertCanonicalTarget(role);
		assert.equal(call.mock.calls.length, 0);
		assert.equal(observe.mock.calls.length, 0);
	},
);

test("a hydrated canonical owner reuses its source for a truncated search target without another text read", async () => {
	const { message, searchAnchor, canonical } = fixture("user", true);
	const call = vi.fn(async () => {
		throw new Error("The hydrated owner must not request text again");
	});
	const observe = vi.fn(async () => {
		throw new Error("Search navigation must not observe execution");
	});
	const client: AppClient = { call, observe };
	const read = vi.fn(async () => canonical);
	const lease = messageDocumentPool(client).acquire(
		JSON.stringify([scope.workspaceId, scope.conversationId, message.id, message.textLength]),
		message.textLength,
		read,
		message.text,
	);
	lease.setActive(true);
	await vi.waitFor(() => assert.equal(lease.getSnapshot().complete, true));
	lease.release();
	await render(client, message, searchAnchor);
	assertCanonicalTarget("user");
	assert.equal(read.mock.calls.length, 1);
	assert.equal(call.mock.calls.length, 0);
	assert.equal(observe.mock.calls.length, 0);
});

test("a partial search snippet is not a canonical document and reads the real source before locating the block", async () => {
	const { message, searchAnchor, canonical } = fixture("user", true);
	const call = vi.fn(async <M extends Method>(method: M) => parseResult(method, canonical));
	const observe = vi.fn(async () => {
		throw new Error("Search navigation must not observe execution");
	});
	await render({ call, observe }, message, searchAnchor);
	assertCanonicalTarget("user");
	assert.equal(call.mock.calls.length, 1);
	assert.deepEqual(call.mock.calls[0]?.slice(0, 2), ["getMessageText", { ...scope, messageId: message.id, offset: 0 }]);
	assert.equal(observe.mock.calls.length, 0);
});
