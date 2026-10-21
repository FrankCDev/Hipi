// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import type { AppClient, Conversation, Snapshot } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as VirtualModule from "@tanstack/react-virtual";
import postcss from "postcss";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { ThemeProvider } from "../../../src/app/theme/provider.tsx";
import type { SearchHistoryAnchor } from "../../../src/features/workbench/conversation/history-controller.ts";
import { ConversationPane } from "../../../src/features/workbench/conversation/pane.tsx";
import type { ConversationController } from "../../../src/features/workbench/conversation/use-conversation.ts";

// Mount the real pane/history/messages/composer and real TanStack virtualizer.
// Only the conversation data hook and unavailable browser geometry are ports.
vi.mock("../../../src/features/workbench/conversation/use-conversation.ts", () => ({
	useConversation: () => controller,
}));
type LayoutOptions = Parameters<typeof VirtualModule.useVirtualizer<HTMLElement, HTMLDivElement>>[0];
let layoutOptions: LayoutOptions;
vi.mock("@tanstack/react-virtual", async () => {
	const actual = await vi.importActual<typeof VirtualModule>("@tanstack/react-virtual");
	return {
		...actual,
		useVirtualizer: (options: LayoutOptions) => {
			layoutOptions = options;
			return actual.useVirtualizer({
				...options,
				observeElementRect: (_owner, callback) => {
					callback({ width: 800, height: 600 });
					return () => {};
				},
				observeElementOffset: (_owner, callback) => {
					callback(0, false);
					return () => {};
				},
				scrollToFn: () => {},
			});
		},
	};
});
const conversation: Conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "Layout",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
const snapshot: Snapshot = {
	workspaceId: conversation.workspaceId,
	conversationId: conversation.conversationId,
	messages: [
		{ id: "answer", role: "assistant", text: "## Heading\n\nA **rendered** answer.", textLength: 34, truncated: false },
	],
	running: false,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: null,
};
const client: AppClient = {
	call: vi.fn(async () => {
		throw new Error("No remote reads in layout fixture");
	}),
	observe: vi.fn(async () => {
		throw new Error("Data hook is injected");
	}),
};
let controller: ConversationController;
let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;
let cache: QueryClient;
let footerHeight = 120;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
function state(patch: Partial<ConversationController> = {}, pending = false) {
	return {
		workspaceId: conversation.workspaceId,
		draft: "draft",
		setDraft: vi.fn(),
		submit: vi.fn(),
		blocked: false,
		composing: { current: false },
		mutation: { isPending: pending, isError: false },
		execution: { isPending: false, isError: false, mutate: vi.fn() },
		model: {
			data: { executionState: "ready", model: { provider: "custom", modelId: "model" }, credentialState: "configured" },
			isError: false,
		},
		receipt: { isError: false },
		storageAvailable: true,
		observation: { connection: "connecting", showConnectionNotice: false, snapshot, error: false },
		...patch,
	} as unknown as ConversationController;
}
async function render(searchAnchor?: SearchHistoryAnchor) {
	await act(async () =>
		renderer.render(
			<QueryClientProvider client={cache}>
				<AppClientProvider client={client}>
					<PreferencesProvider>
						<ThemeProvider>
							<ConversationPane
								conversation={conversation}
								detailsOpen={false}
								onDetailsClose={() => {}}
								searchAnchor={searchAnchor}
							/>
						</ThemeProvider>
					</PreferencesProvider>
				</AppClientProvider>
			</QueryClientProvider>,
		),
	);
}
function query<T extends Element = HTMLElement>(selector: string) {
	const result = host.querySelector<T>(selector);
	assert.ok(result, selector);
	return result;
}
async function resizeFooter(height: number) {
	footerHeight = height;
	await act(async () => {
		for (const [observer, { callback, targets }] of observers) {
			if ([...targets].some((element) => element.matches(".conversation-footer"))) callback([], observer);
		}
	});
}
beforeEach(() => {
	controller = state();
	footerHeight = 120;
	frames.clear();
	observers.clear();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.set(this, { callback, targets: new Set() });
			}
			observe(target: Element) {
				observers.get(this)?.targets.add(target);
			}
			unobserve(target: Element) {
				observers.get(this)?.targets.delete(target);
			}
			disconnect() {
				observers.delete(this);
			}
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
	const original = HTMLElement.prototype.getBoundingClientRect;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return this.matches(".conversation-footer") ? new DOMRect(0, 0, 800, footerHeight) : original.call(this);
	});
	host = document.createElement("div");
	document.body.append(host);
	renderer = createRoot(host);
	cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	cache.setQueryData(["models"], { models: [], providers: [] });
});
afterEach(async () => {
	await act(async () => renderer.unmount());
	cache.clear();
	host.remove();
	document.getSelection()?.removeAllRanges();
	assert.equal(observers.size, 0);
	assert.equal(frames.size, 0);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
test("real pane shares one column role without padding the absolute virtual rows", async () => {
	await render();
	const column = query(".message-scroll > .conversation-column");
	assert.equal(query(".virtual-message-stack").parentElement, column);
	assert.ok(query(".conversation-footer > .conversation-column > .composer-wrap > .composer"));
	assert.equal(host.querySelectorAll(".conversation-column").length, 2);
	assert.equal(query(".markdown-body h2").textContent, "Heading");
	assert.equal(query(".markdown-body strong").textContent, "rendered");
	assert.ok(query(".virtual-message-row").style.transform.includes("translateY"));
	assert.equal(layoutOptions.paddingEnd, 152);
	assert.equal(query(".message-stage").style.getPropertyValue("--thread-scroll-padding-bottom"), "136px");
});
test("footer growth preserves separate document and focus clearances and editor identity", async () => {
	await render();
	const editor = query('[role="textbox"]');
	controller = state({ draft: "first line\nsecond line\nthird line", admissionFailed: true });
	await render();
	assert.equal(query('[role="textbox"]'), editor);
	assert.ok(query(".composer-wrap > .notice"));
	await resizeFooter(230);
	assert.equal(layoutOptions.paddingEnd, 262);
	assert.equal(query(".message-stage").style.getPropertyValue("--thread-scroll-padding-bottom"), "246px");
	controller = state();
	await render();
	await resizeFooter(120);
	assert.equal(layoutOptions.paddingEnd, 152);
	assert.equal(query('[role="textbox"]'), editor);
});
test("pending and stopped states retain the same pane/editor; search jump follows footer size", async () => {
	const message = snapshot.messages[0];
	assert.ok(message);
	const anchor: SearchHistoryAnchor = {
		locator: "locator",
		window: {
			workspaceId: conversation.workspaceId,
			conversationId: conversation.conversationId,
			messages: snapshot.messages,
			target: {
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				messageId: message.id,
				text: message.text,
				offset: 0,
				nextOffset: null,
				textLength: message.textLength,
			},
			matchStart: 3,
			matchEnd: 10,
			olderCursor: null,
			newerCursor: null,
		},
	};
	await render(anchor);
	const editor = query('[role="textbox"]');
	assert.equal(query(".jump-latest").style.bottom, "144px");
	controller = state({}, true);
	await render(anchor);
	assert.equal(query('[role="textbox"]'), editor);
	assert.ok(query(".composer-pending-icon"));
	assert.ok(controller.model.data);
	controller = state({ model: { ...controller.model, data: { ...controller.model.data, executionState: "paused" } } });
	await render(anchor);
	assert.equal(query('[role="textbox"]'), editor);
	assert.ok(query('.conversation-model-controls[data-execution-state="paused"]'));
	await resizeFooter(180);
	assert.equal(query(".jump-latest").style.bottom, "204px");
	assert.equal(layoutOptions.paddingEnd, 212);
	assert.equal(query(".message-stage").style.getPropertyValue("--thread-scroll-padding-bottom"), "196px");
});
test("layout CSS retains the source formula and removes breakpoint drift without touching home", () => {
	const css = postcss.parse(
		readFileSync(new NodeURL("../../../src/features/workbench/conversation/layout.css", import.meta.url), "utf8"),
	);
	const declarations = (selector: string) => {
		const values = new Map<string, string>();
		css.walkRules(selector, (rule) => {
			rule.walkDecls((decl) => {
				values.set(decl.prop, decl.value);
			});
		});
		return values;
	};
	const column = declarations(".conversation-column");
	assert.equal(column.get("box-sizing"), "border-box");
	assert.equal(column.get("--thread-content-max-width"), "var(--thread-content-responsive-max-width, inherit)");
	assert.equal(
		column.get("--thread-body-max-width"),
		"calc(var(--thread-content-max-width) + var(--thread-body-inline-padding, 0px) * 2)",
	);
	assert.equal(column.get("padding-inline"), "var(--thread-body-inline-padding, var(--conversation-inline-padding))");
	assert.equal(declarations(".conversation-panel .message-scroll").get("scrollbar-gutter"), "stable both-edges");
	assert.equal(declarations(".conversation-footer").get("padding-bottom"), "var(--composer-bottom-inset)");
	assert.equal(declarations(".conversation-footer::before").get("position"), "absolute");
	const theme = postcss.parse(readFileSync(new NodeURL("../../../src/theme.css", import.meta.url), "utf8"));
	theme.walkRules((rule) => {
		if (![".message-scroll", ".composer-wrap", ".composer", ".conversation-footer"].includes(rule.selector)) return;
		rule.walkDecls((decl) =>
			assert.ok(
				(rule.selector === ".composer" && decl.prop === "padding" && decl.value === "0") ||
					!["padding", "padding-inline", "padding-top", "max-width"].includes(decl.prop),
				`${rule.selector}: ${decl}`,
			),
		);
	});
});
