import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	parseResult,
	type SearchHistoryWindow,
	type Snapshot,
	type ToolActivityPage,
} from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ActivityState } from "../../../src/features/tool-activities/activity-session.ts";
import { ActivityTranscriptProvider } from "../../../src/features/tool-activities/activity-transcript.tsx";
import { ConversationHistory } from "../../../src/features/workbench/conversation/history.tsx";
import { ConversationMessages } from "../../../src/features/workbench/conversation/messages.tsx";
import { ConversationReadingPositions } from "../../../src/features/workbench/conversation/reading-position.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void; setup?: React.EffectCallback };
type Hooks = { cells: Cell[]; cursor: number; commits: (() => void)[]; changed: boolean };
const adapter = vi.hoisted(() => ({ current: undefined as Hooks | undefined }));

// Bounded hook adapter: run production layout/effect and JSX callbacks with
// deterministic ref, selection, virtualizer and frame ports. This is not a DOM
// mount, React reconciliation test, browser selection test or native scroll test.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	function cell() {
		const hooks = adapter.current;
		if (!hooks) throw new Error("No active hook adapter");
		const index = hooks.cursor++;
		return { hooks, index, previous: hooks.cells[index] };
	}
	const changed = (before: React.DependencyList | undefined, after: React.DependencyList | undefined) =>
		!before ||
		!after ||
		before.length !== after.length ||
		after.some((value, index) => !Object.is(value, before[index]));
	function memo<T>(create: () => T, deps: React.DependencyList) {
		const { hooks, index, previous } = cell();
		if (!previous || changed(previous.deps, deps)) hooks.cells[index] = { value: create(), deps };
		return hooks.cells[index]?.value;
	}
	function effect(create: React.EffectCallback, deps?: React.DependencyList) {
		const { hooks, index, previous } = cell();
		if (!previous || changed(previous.deps, deps))
			hooks.commits.push(() => {
				previous?.cleanup?.();
				const cleanup = create();
				hooks.cells[index] = {
					value: undefined,
					deps,
					setup: create,
					cleanup: typeof cleanup === "function" ? cleanup : undefined,
				};
			});
	}
	return {
		...actual,
		useState: <T,>(initial?: T | (() => T)) => {
			const { hooks, index, previous } = cell();
			const current = previous ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = current;
			return [
				current.value,
				(next: T | ((value: T) => T)) => {
					const value = typeof next === "function" ? (next as (value: T) => T)(current.value as T) : next;
					if (!Object.is(value, current.value)) hooks.changed = true;
					current.value = value;
				},
			];
		},
		useRef: <T,>(initial: T) => memo(() => ({ current: initial }), []),
		useMemo: memo,
		useCallback: <T,>(callback: T, deps: React.DependencyList) => memo(() => callback, deps),
		useId: () => {
			const { hooks, index } = cell();
			hooks.cells[index] = { value: `selection-${index}` };
			return `selection-${index}`;
		},
		useLayoutEffect: effect,
		useEffect: effect,
		useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => {
			const hooks = adapter.current;
			effect(
				() =>
					subscribe(() => {
						if (hooks) hooks.changed = true;
					}),
				[subscribe],
			);
			return snapshot();
		},
	};
});
vi.mock("@tanstack/react-virtual", async () => ({
	...(await vi.importActual("@tanstack/react-virtual")),
	useVirtualizer: (options: VirtualOptions) => {
		virtualizer.options = options;
		return virtualizer;
	},
}));
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));

class EventPort extends EventTarget {
	readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
		if (!listener) return;
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
		super.addEventListener(type, listener);
	}
	override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
		if (!listener) return;
		this.listeners.get(type)?.delete(listener);
		super.removeEventListener(type, listener);
	}
	get listenerCount() {
		return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}
}
class ElementPort extends EventPort {
	scrollTop = 0;
	scrollHeight = 1000;
	clientHeight = 200;
	parentElement = null;
	dataset = {};
	closest() {
		return null;
	}
	contains(node: unknown) {
		return node === this;
	}
	querySelector() {
		return searchMark;
	}
}
type VirtualOptions = {
	count: number;
	getItemKey: (index: number) => string;
	followOnAppend: boolean;
	scrollEndThreshold: number;
	anchorTo: string;
};
function createVirtualizer() {
	const options: VirtualOptions = {
		count: 0,
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
let root = new ElementPort();
let documentEvents = new EventPort();
let windowEvents = new EventPort();
let virtualizer = createVirtualizer();
let selected = false;
const searchMark = { scrollIntoView: vi.fn() };
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const observers = new Set<{ disconnect: () => void }>();
const hosts: Hooks[] = [];
const outsideAnchor = new ElementPort();
const outsideFocus = new ElementPort();
const selection = {
	get isCollapsed() {
		return !selected;
	},
	rangeCount: 1,
	anchorNode: outsideAnchor,
	focusNode: outsideFocus,
	getRangeAt: () => ({ intersectsNode: (node: unknown) => selected && node === root }),
};

function elements(node: React.ReactNode, type: string): React.ReactElement<Record<string, unknown>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	return [
		...(node.type === type ? [node as React.ReactElement<Record<string, unknown>>] : []),
		...elements(node.props.children, type),
	];
}
function host(render: () => React.ReactNode, attach: (node: React.ReactNode) => void = () => {}) {
	const hooks: Hooks = { cells: [], cursor: 0, commits: [], changed: false };
	hosts.push(hooks);
	return {
		drive() {
			for (let attempt = 0; attempt < 8; attempt++) {
				adapter.current = hooks;
				hooks.cursor = 0;
				hooks.changed = false;
				const node = render();
				attach(node);
				for (const commit of hooks.commits.splice(0)) commit();
				if (!hooks.changed) return node;
			}
			throw new Error("Production component did not settle");
		},
		dispose() {
			for (const cell of hooks.cells) {
				cell.cleanup?.();
				cell.cleanup = undefined;
			}
		},
		replayEffects() {
			for (const cell of hooks.cells) {
				cell.cleanup?.();
				cell.cleanup = undefined;
			}
			for (const cell of hooks.cells) {
				const cleanup = cell.setup?.();
				cell.cleanup = typeof cleanup === "function" ? cleanup : undefined;
			}
		},
	};
}
function conversation(options: { key?: string; snapshot?: Snapshot; searchAnchor?: SearchHistoryWindow } = {}) {
	const positions = new ConversationReadingPositions();
	if (options.key) positions.save(scope, { key: options.key, pixel: -25.5, following: false }, []);
	let snapshot = options.snapshot ?? latest;
	const onNearTop = vi.fn();
	const onJumpLatest = vi.fn();
	const owner = host(
		() =>
			ConversationMessages({
				snapshot,
				error: false,
				scope,
				readingPositions: positions,
				onNearTop,
				searchAnchor: options.searchAnchor,
				onJumpLatest: options.searchAnchor ? onJumpLatest : undefined,
			}),
		(node) => {
			const section = elements(node, "section")[0];
			assert.ok(section?.props.ref && typeof section.props.ref === "object");
			Reflect.set(section.props.ref, "current", root);
		},
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
			const section = elements(owner.drive(), "section")[0];
			assert.ok(section && typeof section.props.onScroll === "function");
			Reflect.apply(section.props.onScroll, undefined, [{ currentTarget: root }]);
		},
	};
}
function frame() {
	const batch = [...frames.keys()];
	for (const id of batch) {
		const callback = frames.get(id);
		if (!callback) continue;
		frames.delete(id);
		callback(performance.now());
	}
}
function select(value: boolean) {
	selected = value;
	documentEvents.dispatchEvent(new Event("selectionchange"));
}
function activity(providedRoot: boolean, running = false) {
	const rootRef: React.RefObject<HTMLElement | null> = { current: null };
	// Ref assignment is the adapter boundary, not a cast to a complete DOM.
	Reflect.set(rootRef, "current", root);
	const outer = host(() =>
		ActivityTranscriptProvider({
			scope,
			connected: true,
			running,
			children: null,
			rootRef: providedRoot ? rootRef : undefined,
		}),
	);
	const child = outer.drive();
	assert.ok(isValidElement(child) && typeof child.type === "function");
	const component = child.type;
	const inner = host(
		() => Reflect.apply(component, undefined, [child.props]),
		(node) => {
			assert.ok(isValidElement<{ value: { summary: React.RefObject<HTMLSpanElement | null> } }>(node));
			Reflect.set(node.props.value.summary, "current", { closest: () => root });
		},
	);
	inner.drive();
	return {
		...inner,
		state() {
			const node = inner.drive();
			assert.ok(isValidElement<{ value: { state: ActivityState } }>(node));
			return node.props.value.state;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	root = new ElementPort();
	documentEvents = new EventPort();
	windowEvents = new EventPort();
	virtualizer = createVirtualizer();
	selected = false;
	nextFrame = 0;
	frames.clear();
	hosts.length = 0;
	vi.stubGlobal("Element", ElementPort);
	vi.stubGlobal("document", {
		visibilityState: "visible",
		documentElement: { dataset: { reducedMotion: "on" } },
		activeElement: null,
		getSelection: () => selection,
		addEventListener: documentEvents.addEventListener.bind(documentEvents),
		removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
	});
	vi.stubGlobal("window", {
		addEventListener: windowEvents.addEventListener.bind(windowEvents),
		removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
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
			disconnect() {
				observers.delete(this);
			}
		},
	);
});
afterEach(async () => {
	try {
		for (const hooks of hosts.reverse())
			for (const cell of hooks.cells) {
				cell.cleanup?.();
				cell.cleanup = undefined;
			}
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(frames.size, 0, "All production RAF owners clean up");
		assert.equal(observers.size, 0, "All production resize observers disconnect");
		assert.equal(documentEvents.listenerCount + windowEvents.listenerCount + root.listenerCount, 0);
		assert.equal(vi.getTimerCount(), 0, "No projection, polling or request timers survive cleanup");
	} finally {
		adapter.current = undefined;
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
	root.dispatchEvent(wheel);
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
		await vi.advanceTimersByTimeAsync(6000);
		assert.equal(vi.mocked(client.call).mock.calls.length, 0, "Ranges crossing the root block all page reads");
		select(false);
		await vi.advanceTimersByTimeAsync(1999);
		assert.equal(vi.mocked(client.call).mock.calls.length, 0);
		await vi.advanceTimersByTimeAsync(1);
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
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	assert.deepEqual(owner.state().page, page);
	select(true);
	await vi.advanceTimersByTimeAsync(4000);
	assert.equal(vi.mocked(client.call).mock.calls.length, 1);
	select(false);
	await vi.advanceTimersByTimeAsync(2000);
	assert.equal(vi.mocked(client.call).mock.calls.length, 2);
	assert.equal(owner.state().failed, false);
	assert.equal(vi.getTimerCount(), 1, "A running owner retains only its next poll");
});

test("disposing activity polling while selection is held prevents a read after release", async () => {
	selected = true;
	const owner = activity(true, true);
	await vi.advanceTimersByTimeAsync(2000);
	owner.dispose();
	select(false);
	await vi.advanceTimersByTimeAsync(6000);
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
	root.dispatchEvent(wheel);
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
	const owner = conversation({ searchAnchor });
	owner.drive();
	owner.replayEffects();
	owner.drive();
	frame();
	frame();
	assert.equal(searchMark.scrollIntoView.mock.calls.length, 1, "Replay restores cancelled exact-match positioning");
	assert.equal(virtualizer.scrollToEnd.mock.calls.length, 0);
	const outer = ConversationHistory({
		scope,
		snapshot: latest,
		error: false,
		searchAnchor: { window: searchAnchor, locator: "opaque" },
	});
	assert.equal(typeof outer.type, "function");
	const scoped = host(() =>
		Reflect.apply(outer.type as (...args: unknown[]) => React.ReactNode, undefined, [outer.props]),
	);
	const first = scoped.drive();
	assert.ok(isValidElement<React.ComponentProps<typeof ConversationMessages>>(first));
	assert.equal(first.props.searchAnchor, searchAnchor);
	scoped.replayEffects();
	const replayed = scoped.drive();
	assert.ok(isValidElement<React.ComponentProps<typeof ConversationMessages>>(replayed));
	assert.equal(replayed.props.searchAnchor, searchAnchor, "A replacement controller re-applies the same prop anchor");
	assert.deepEqual(replayed.props.snapshot?.messages, searchAnchor.messages);
	assert.equal(replayed.props.snapshot?.historyCursor, null);
});
