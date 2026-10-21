// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	parseResult,
	type SearchHistoryWindow,
	type Snapshot,
	type ToolActivityPage,
} from "@hipi/work-runtime/contracts";
import { act, type ReactNode, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../../src/app/theme/provider.tsx";
import { ConversationHistory } from "../../../src/features/workbench/conversation/history.tsx";

// React, context propagation, effects, DOM refs and events are real. Only layout,
// virtualizer geometry and animation frame scheduling are deterministic ports.
vi.mock("@tanstack/react-virtual", async () => ({
	...(await vi.importActual("@tanstack/react-virtual")),
	useVirtualizer: (options: VirtualOptions) => {
		virtualizer.options = options;
		useLayoutEffect(() => {
			const section = options.getScrollElement();
			if (section) root = section;
		});
		return virtualizer;
	},
}));
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
type VirtualOptions = {
	count: number;
	getScrollElement: () => HTMLElement | null;
	getItemKey: (index: number) => string;
	followOnAppend: boolean;
	scrollEndThreshold: number;
	anchorTo: string;
};
function createVirtualizer() {
	const options: VirtualOptions = {
		count: 0,
		getScrollElement: () => root,
		getItemKey: (index: number) => `${index}`,
		followOnAppend: false,
		scrollEndThreshold: -1,
		anchorTo: "end",
	};
	return {
		options,
		get scrollOffset() {
			return root.scrollTop;
		},
		setOptions(options: VirtualOptions) {
			this.options = options;
		},
		getVirtualIndexes() {
			return Array.from({ length: this.options.count }, (_, index) => index);
		},
		getVirtualItems() {
			return this.getVirtualIndexes().map((index) => ({
				index,
				key: this.options.getItemKey(index),
				start: index * 100,
				end: (index + 1) * 100,
				size: 100,
				lane: 0,
			}));
		},
		getTotalSize: () => 1000,
		getOffsetForIndex: vi.fn((index: number) => [index * 100]),
		isAtEnd: () => root.scrollHeight - root.clientHeight - root.scrollTop <= 24,
		scrollToEnd: vi.fn(() => {
			root.scrollTop = 800;
		}),
		scrollToIndex: vi.fn((index: number, _options?: { align: string }) => {
			root.scrollTop = index * 100;
		}),
		scrollToOffset: vi.fn((offset: number) => {
			root.scrollTop = offset;
		}),
		cancelScroll: vi.fn(),
		measureElement: () => {},
		takeSnapshot() {
			return this.getVirtualItems();
		},
	};
}
const scope = { workspaceId: "workspace", conversationId: "conversation" };
const latest: Snapshot = {
	...scope,
	messages: [
		{ id: "a", role: "user", text: "First", textLength: 5, truncated: false },
		{ id: "b", role: "assistant", text: "Second", textLength: 6, truncated: false },
	],
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: false,
	historyCursor: null,
};
const page: ToolActivityPage = { items: [], nextCursor: null, coverage: "tasks", membershipFence: "selection-test" };
const client: AppClient = {
	call: vi.fn(async <M extends Method>(method: M) => {
		assert.equal(method, "getToolActivities");
		return parseResult(method, page);
	}),
	observe: vi.fn(async () => {
		throw new Error("Selection tests must not observe execution");
	}),
};

let root: HTMLElement;
let virtualizer = createVirtualizer();
let outsideAnchor: HTMLSpanElement;
let outsideFocus: HTMLSpanElement;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const observers = new Set<{ disconnect: () => void }>();
const hosts: { dispose: () => void }[] = [];
const listeners = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
const searchMark = { scrollIntoView: vi.fn() };
function host(render: () => ReactNode, strict = false, container?: HTMLElement) {
	const mount = container ?? document.createElement("div");
	if (!mount.isConnected) document.body.insertBefore(mount, outsideFocus);
	const renderer = createRoot(mount);
	let disposed = false;
	function View() {
		return <ThemeProvider>{render()}</ThemeProvider>;
	}
	const owner = {
		mount,
		drive() {
			act(() => {
				renderer.render(
					strict ? (
						<StrictMode>
							<View />
						</StrictMode>
					) : (
						<View />
					),
				);
			});
			return mount;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			act(() => {
				renderer.unmount();
			});
			mount.remove();
		},
	};
	hosts.push(owner);
	return owner;
}
function frame() {
	act(() => {
		for (const id of [...frames.keys()]) {
			const callback = frames.get(id);
			if (!callback) continue;
			frames.delete(id);
			callback(performance.now());
		}
	});
}
async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// React's shared document delegation is renderer-owned and intentionally
	// survives individual roots. Initialize it before measuring product owners.
	const warm = createRoot(document.createElement("div"));
	act(() => warm.unmount());
	listeners.clear();
	const add = EventTarget.prototype.addEventListener;
	const remove = EventTarget.prototype.removeEventListener;
	const tracked = (target: EventTarget, type: string) =>
		// React retains its own nondelegated scroll handler on detached DOM.
		(target instanceof HTMLElement && target.matches(".message-scroll") && type !== "scroll") ||
		((target === document || target === window) &&
			["selectionchange", "visibilitychange", "pointermove", "pointerup", "pointercancel"].includes(type));
	vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
		this: EventTarget,
		type,
		listener,
		options,
	) {
		if (listener && tracked(this, type)) {
			const types = listeners.get(this) ?? new Map<string, Set<EventListenerOrEventListenerObject>>();
			const callbacks = types.get(type) ?? new Set<EventListenerOrEventListenerObject>();
			callbacks.add(listener);
			types.set(type, callbacks);
			listeners.set(this, types);
		}
		add.call(this, type, listener, options);
	});
	vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (
		this: EventTarget,
		type,
		listener,
		options,
	) {
		if (listener) listeners.get(this)?.get(type)?.delete(listener);
		remove.call(this, type, listener, options);
	});
	outsideAnchor = document.createElement("span");
	outsideAnchor.textContent = "Before";
	outsideFocus = document.createElement("span");
	outsideFocus.textContent = "After";
	document.body.append(outsideAnchor, outsideFocus);
	root = document.createElement("div");
	virtualizer = createVirtualizer();
	nextFrame = 0;
	frames.clear();
	hosts.length = 0;
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: searchMark.scrollIntoView,
	});
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor() {
				observers.add(this);
			}
			observe() {}
			unobserve() {}
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
});
afterEach(async () => {
	try {
		for (const owner of hosts.toReversed()) owner.dispose();
		await advance(0);
		assert.equal(frames.size, 0, "All production RAF owners clean up");
		assert.equal(observers.size, 0, "All production resize observers disconnect");
		assert.equal(
			[...listeners.values()]
				.flatMap((types) => [...types.values()])
				.reduce((total, callbacks) => total + callbacks.size, 0),
			0,
			"Selection, visibility, pointer and scroll-region listeners leave with their production owner",
		);
		assert.equal(vi.getTimerCount(), 0, "No projection, polling or request timers survive cleanup");
	} finally {
		document.getSelection()?.removeAllRanges();
		document.body.replaceChildren();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});

const anchor: SearchHistoryWindow = {
	...scope,
	messages: latest.messages,
	target: { ...scope, messageId: "b", text: "Second", offset: 0, nextOffset: null, textLength: 6 },
	matchStart: 0,
	matchEnd: 6,
	olderCursor: null,
	newerCursor: null,
};
test.each([false, true])("initial hydrated history never visits the live tail (StrictMode=%s)", (strict) => {
	let snapshot = latest;
	const searchAnchor = { window: anchor, locator: "opaque" };
	const owner = host(
		() => <ConversationHistory scope={scope} snapshot={snapshot} error={false} searchAnchor={searchAnchor} />,
		strict,
	);
	owner.drive();
	frame();
	frame();
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	assert.ok(virtualizer.scrollToIndex.mock.calls.length > 0);
	assert.ok(virtualizer.scrollToIndex.mock.calls.every((call) => call[0] === 1 && call[1]?.align === "center"));
	assert.equal(owner.mount.querySelector(".message-scroll")?.getAttribute("data-reading-mode"), "search");
	assert.equal(owner.mount.querySelector(".search-match-text")?.textContent, "Second");
	const centerCalls = virtualizer.scrollToIndex.mock.calls.length;
	root.scrollTop = 123.5;
	snapshot = { ...latest, partial: "Background generation", running: true };
	owner.drive();
	frame();
	frame();
	assert.equal(root.scrollTop, 123.5);
	assert.equal(virtualizer.scrollToIndex.mock.calls.length, centerCalls);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
});
test("scope replacement starts at its hydrated target, then explicit exit restores latest", () => {
	let currentScope = scope;
	let snapshot = latest;
	let searchAnchor: { window: SearchHistoryWindow; locator: string } | undefined = { window: anchor, locator: "first" };
	const owner = host(
		() => (
			<ConversationHistory
				scope={currentScope}
				snapshot={snapshot}
				error={false}
				searchAnchor={searchAnchor}
				onExitSearchAnchor={() => {
					searchAnchor = undefined;
				}}
			/>
		),
		true,
	);
	owner.drive();
	frame();
	frame();
	currentScope = { ...scope, conversationId: "other" };
	snapshot = { ...latest, ...currentScope };
	searchAnchor = {
		window: { ...anchor, ...currentScope, target: { ...anchor.target, ...currentScope } },
		locator: "other",
	};
	owner.drive();
	frame();
	frame();
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	const jump = [...owner.mount.querySelectorAll("button")].find((button) => button.textContent === "work.jumpLatest");
	assert.ok(jump);
	act(() => jump.click());
	owner.drive();
	frame();
	frame();
	assert.equal(owner.mount.querySelector(".message-scroll")?.getAttribute("data-reading-mode"), "live");
	assert.ok(virtualizer.scrollToEnd.mock.calls.length > 0);
});
test("selection before hydrated match settling cancels the later scroll", () => {
	const searchAnchor = { window: anchor, locator: "opaque" };
	const owner = host(() => (
		<ConversationHistory scope={scope} snapshot={latest} error={false} searchAnchor={searchAnchor} />
	));
	owner.drive();
	root.scrollTop = 143.25;
	act(() => {
		const selection = document.getSelection();
		assert.ok(selection);
		const range = document.createRange();
		range.setStart(outsideAnchor.firstChild ?? outsideAnchor, 0);
		range.setEnd(outsideFocus.firstChild ?? outsideFocus, 1);
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	frame();
	frame();
	assert.equal(searchMark.scrollIntoView.mock.calls.length, 0);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	assert.equal(root.scrollTop, 143.25);
});
