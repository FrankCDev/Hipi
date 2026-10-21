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
import { act, type ReactNode, type RefObject, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../../src/app/theme/provider.tsx";
import type { ActivityState } from "../../../src/features/tool-activities/activity-session.ts";
import {
	ActivityTranscriptProvider,
	useActivityTranscript,
} from "../../../src/features/tool-activities/activity-transcript.tsx";
import { ConversationHistory } from "../../../src/features/workbench/conversation/history.tsx";
import { ConversationMessages } from "../../../src/features/workbench/conversation/messages.tsx";
import { ConversationReadingPositions } from "../../../src/features/workbench/conversation/reading-position.ts";

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
		scrollToIndex: vi.fn((index: number) => {
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
let selected = false;
let outsideAnchor: HTMLSpanElement;
let outsideFocus: HTMLSpanElement;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const observers = new Set<{ disconnect: () => void }>();
const hosts: { dispose: () => void }[] = [];
const listeners = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
const searchMark = { scrollIntoView: vi.fn() };
let originalScrollIntoView: PropertyDescriptor | undefined;
const selection = {
	get anchorNode() {
		return document.getSelection()?.anchorNode ?? null;
	},
	get focusNode() {
		return document.getSelection()?.focusNode ?? null;
	},
};
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
function conversation(
	options: { key?: string; snapshot?: Snapshot; searchAnchor?: SearchHistoryWindow; strict?: boolean } = {},
) {
	const positions = new ConversationReadingPositions();
	if (options.key) positions.save(scope, { key: options.key, pixel: -25.5, following: false }, []);
	let snapshot = options.snapshot ?? latest;
	const onNearTop = vi.fn();
	const onJumpLatest = vi.fn();
	const owner = host(
		() => (
			<ConversationMessages
				snapshot={snapshot}
				error={false}
				scope={scope}
				readingPositions={positions}
				onNearTop={onNearTop}
				searchAnchor={options.searchAnchor}
				onJumpLatest={options.searchAnchor ? onJumpLatest : undefined}
			/>
		),
		options.strict,
	);
	return {
		...owner,
		positions,
		onNearTop,
		onJumpLatest,
		update(next: Snapshot) {
			snapshot = next;
			return owner.drive();
		},
		scroll() {
			act(() => {
				root.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
		},
	};
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
function select(value: boolean) {
	selected = value;
	act(() => {
		const range = document.createRange();
		const selection = document.getSelection();
		assert.ok(selection);
		selection.removeAllRanges();
		if (value) {
			range.setStart(outsideAnchor.firstChild ?? outsideAnchor, 0);
			range.setEnd(outsideFocus.firstChild ?? outsideFocus, 1);
			selection.addRange(range);
		}
		document.dispatchEvent(new Event("selectionchange"));
	});
}
async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
function activity(providedRoot: boolean, running = false) {
	root = document.createElement("div");
	root.className = "activity-context";
	document.body.insertBefore(root, outsideFocus);
	const rootRef: RefObject<HTMLElement | null> = { current: root };
	let state: ActivityState | undefined;
	function Consumer() {
		const context = useActivityTranscript();
		assert.ok(context);
		state = context.state;
		return <span ref={context.summary}>Activity</span>;
	}
	if (selected) select(true);
	const owner = host(
		() => (
			<ActivityTranscriptProvider
				scope={scope}
				connected
				running={running}
				rootRef={providedRoot ? rootRef : undefined}
			>
				<Consumer />
			</ActivityTranscriptProvider>
		),
		false,
		root,
	);
	owner.drive();
	return {
		...owner,
		state() {
			assert.ok(state);
			return state;
		},
	};
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
	// React keeps its nondelegated scroll listener on the detached section;
	// track product-owned listeners, not renderer delegation on discarded DOM.
	const tracked = (target: EventTarget, type: string) =>
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
	selected = false;
	nextFrame = 0;
	frames.clear();
	hosts.length = 0;
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
	originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
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
		if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
		else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
		document.getSelection()?.removeAllRanges();
		document.body.replaceChildren();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});
test.each([0, 1])("selection before restore settle frame %s cancels every later offset correction", (settled) => {
	const owner = conversation({ key: "message:b" });
	owner.drive();
	assert.deepEqual(virtualizer.scrollToIndex.mock.calls, [[1, { align: "start" }]]);
	if (settled) frame();
	assert.equal(virtualizer.scrollToOffset.mock.calls.length, settled);
	root.scrollTop = 177;
	select(true);
	assert.equal(owner.onNearTop.mock.lastCall?.[0], false, "History demand is cancelled synchronously");
	owner.drive();
	frame();
	frame();
	assert.equal(root.scrollTop, 177);
	assert.equal(virtualizer.scrollToOffset.mock.calls.length, settled);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	assert.equal(virtualizer.options.followOnAppend, false);
	assert.equal(virtualizer.options.scrollEndThreshold, -1);
	select(false);
	owner.update({ ...latest, partial: "Later stream", running: true });
	frame();
	assert.equal(root.scrollTop, 177);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
});

test("selection while waiting for old history cancels restoration and preserves the reader after release", () => {
	const owner = conversation({ key: "message:older", snapshot: { ...latest, historyCursor: "older-page" } });
	owner.drive();
	assert.equal(owner.onNearTop.mock.lastCall?.[0], true);
	assert.equal(virtualizer.scrollToIndex.mock.calls.length, 0);
	root.scrollTop = 125;
	select(true);
	assert.equal(owner.onNearTop.mock.lastCall?.[0], false);
	owner.drive();
	const older = { id: "older", role: "user" as const, text: "Earlier", textLength: 7, truncated: false };
	owner.update({ ...latest, messages: [older, ...latest.messages] });
	frame();
	assert.equal(root.scrollTop, 125);
	select(false);
	owner.drive();
	frame();
	assert.equal(virtualizer.scrollToIndex.mock.calls.length, 0);
	assert.equal(virtualizer.scrollToOffset.mock.calls.length, 0);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	owner.dispose();
	assert.equal(
		owner.positions.read(scope)?.key,
		"message:a",
		"Reader initialization permits saving the current anchor",
	);
	assert.equal(owner.positions.read(scope)?.pixel, -25);
	assert.equal(owner.positions.read(scope)?.following, false);
});

test("selection neutralizes recent downward intent even when native scrolling reports the end after release", () => {
	const owner = conversation();
	owner.drive();
	const wheel = new Event("wheel");
	Object.assign(wheel, { deltaY: 20, deltaX: 0 });
	act(() => {
		root.dispatchEvent(wheel);
	});
	owner.scroll();
	assert.equal(virtualizer.options.followOnAppend, true, "Control: downward input at the end resumes following");
	select(true);
	assert.equal(virtualizer.options.followOnAppend, false, "Selection disables follow before the next render");
	owner.drive();
	select(false);
	owner.scroll();
	assert.equal(virtualizer.options.followOnAppend, false);
	assert.equal(virtualizer.options.scrollEndThreshold, -1);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 1, "No new automatic jump after initial positioning");
});

test.each([true, false])(
	"crossing selection pauses activity polling until release (provided root=%s)",
	async (providedRoot) => {
		selected = true;
		assert.equal(root.contains(selection.anchorNode), false);
		assert.equal(root.contains(selection.focusNode), false);
		const owner = activity(providedRoot);
		assert.equal(vi.mocked(client.call).mock.calls.length, 0);
		await advance(6000);
		assert.equal(vi.mocked(client.call).mock.calls.length, 0, "Ranges crossing the root block all page reads");
		select(false);
		await advance(1999);
		assert.equal(vi.mocked(client.call).mock.calls.length, 0);
		await advance(1);
		assert.equal(
			vi.mocked(client.call).mock.calls.length,
			1,
			"A finished run still refreshes once after selection release",
		);
		assert.equal(owner.state().failed, false);
		assert.deepEqual(owner.state().page, page);
		assert.equal(vi.getTimerCount(), 0, "A finished run does not keep polling");
	},
);

test("a crossing selection also pauses an already-running poll until its next check after release", async () => {
	const owner = activity(true, true);
	await advance(0);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.deepEqual(owner.state().page, page);
	select(true);
	await advance(4000);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	select(false);
	await advance(2000);
	assert.equal(vi.mocked(client.call).mock.calls.length, 2);
	assert.equal(owner.state().failed, false);
	assert.equal(vi.getTimerCount(), 1, "A running owner retains only its next poll");
});

test("disposing activity polling while selection is held prevents a read after release", async () => {
	selected = true;
	const owner = activity(true, true);
	await advance(2000);
	owner.dispose();
	select(false);
	await advance(6000);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
	assert.equal(vi.getTimerCount(), 0);
});

test("search reading scrolls to the exact matching row and chunk, never follows the displayed window's end", () => {
	const anchor: SearchHistoryWindow = {
		...scope,
		messages: latest.messages,
		target: { ...scope, messageId: "b", text: "Second", offset: 0, nextOffset: null, textLength: 6 },
		matchStart: 0,
		matchEnd: 6,
		olderCursor: "opaque-older",
		newerCursor: "opaque-newer",
	};
	const owner = conversation({ key: "message:a", searchAnchor: anchor });
	owner.drive();
	assert.deepEqual(virtualizer.scrollToIndex.mock.calls, [[1, { align: "center" }]]);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	frame();
	frame();
	assert.deepEqual(searchMark.scrollIntoView.mock.calls, [[{ block: "center" }]]);
	root.scrollTop = 800;
	const wheel = new Event("wheel");
	Object.assign(wheel, { deltaY: 20, deltaX: 0 });
	act(() => {
		root.dispatchEvent(wheel);
	});
	owner.scroll();
	owner.drive();
	assert.equal(virtualizer.options.followOnAppend, false);
	assert.equal(virtualizer.options.scrollEndThreshold, -1);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	owner.dispose();
	assert.equal(
		owner.positions.read(scope)?.key,
		"message:a",
		"Search anchors never overwrite normal reading positions",
	);
});

test("selection during search settling cancels the scheduled exact-match scroll", () => {
	const owner = conversation({
		searchAnchor: {
			...scope,
			messages: latest.messages,
			target: { ...scope, messageId: "b", text: "Second", offset: 0, nextOffset: null, textLength: 6 },
			matchStart: 0,
			matchEnd: 6,
			olderCursor: null,
			newerCursor: null,
		},
	});
	owner.drive();
	select(true);
	owner.drive();
	frame();
	frame();
	assert.equal(searchMark.scrollIntoView.mock.calls.length, 0);
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
});

test("StrictMode effect replay retains the hydrated anchor and repositions its actual matching chunk", () => {
	const searchAnchor: SearchHistoryWindow = {
		...scope,
		messages: latest.messages,
		target: { ...scope, messageId: "b", text: "Second", offset: 0, nextOffset: null, textLength: 6 },
		matchStart: 0,
		matchEnd: 6,
		olderCursor: "opaque-older",
		newerCursor: "opaque-newer",
	};
	const owner = conversation({ searchAnchor, strict: true });
	owner.drive();
	frame();
	frame();
	assert.equal(searchMark.scrollIntoView.mock.calls.length, 1, "Replay restores cancelled exact-match positioning");
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	owner.dispose();
	searchMark.scrollIntoView.mockClear();
	const history = host(
		() => (
			<ConversationHistory
				scope={scope}
				snapshot={latest}
				error={false}
				searchAnchor={{ window: searchAnchor, locator: "opaque" }}
			/>
		),
		true,
	);
	history.drive();
	frame();
	frame();
	assert.equal(history.mount.querySelector(".message-scroll")?.getAttribute("data-reading-mode"), "search");
	assert.equal(history.mount.querySelector("[data-search-match]")?.textContent, "Second");
	assert.ok(history.mount.querySelector('[data-message-id="a"]'));
	assert.ok(history.mount.querySelector('[data-message-id="b"]'));
	assert.ok(
		searchMark.scrollIntoView.mock.calls.length > 0,
		"Replacement controller re-applies its hydrated search anchor",
	);
	// This checks the original hydrated-history contract, not an initial-jump
	// guarantee: History publishes its search anchor in a layout effect.
});
