import assert from "node:assert/strict";
import {
	type DroppableContainer,
	PointerSensor,
	type Sensor,
	type SensorContext,
	type SensorProps,
} from "@dnd-kit/core";
import { afterEach, beforeEach, test, vi } from "vitest";
import { DEFAULT_APP_KEYBINDINGS } from "../src/app/keybindings.ts";
import type { SidebarPoint } from "../src/features/workbench/sidebar-drag-controller.ts";
import {
	SidebarPointerSensor,
	type SidebarPointerSensorOptions,
	type SidebarPointerSession,
} from "../src/features/workbench/sidebar-pointer-sensor.ts";

// Public Sensor integration on explicit DOM adapters, with the real installed
// PointerSensor as the activation/lifecycle oracle. This is not native browser DOM,
// React event propagation, pointer capture, focus, or platform input methods.
class TrackedTarget extends EventTarget {
	readonly listeners = new Map<string, Map<EventListenerOrEventListenerObject, Set<boolean>>>();
	override addEventListener(
		name: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: AddEventListenerOptions | boolean,
	) {
		if (!listener) return;
		const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
		const handlers = this.listeners.get(name) ?? new Map<EventListenerOrEventListenerObject, Set<boolean>>();
		const captures = handlers.get(listener) ?? new Set<boolean>();
		captures.add(capture);
		handlers.set(listener, captures);
		this.listeners.set(name, handlers);
		super.addEventListener(name, listener, { ...(typeof options === "object" ? options : {}), capture });
	}
	override removeEventListener(
		name: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean,
	) {
		if (!listener) return;
		const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
		const handlers = this.listeners.get(name);
		const captures = handlers?.get(listener);
		captures?.delete(capture);
		if (!captures?.size) handlers?.delete(listener);
		if (!handlers?.size) this.listeners.delete(name);
		super.removeEventListener(name, listener, { capture });
	}
	emit(name: string, properties: Record<string, unknown> = {}) {
		const event = Object.assign(new Event(name, { cancelable: true }), properties);
		this.dispatchEvent(event);
		return event;
	}
}

class TestPointerEvent extends Event {
	readonly pointerId: number;
	readonly clientX: number;
	readonly clientY: number;
	readonly buttons: number;
	readonly button: number;
	readonly isPrimary: boolean;
	readonly relatedTarget: EventTarget | null;
	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 7;
		this.clientX = init.clientX ?? 20;
		this.clientY = init.clientY ?? 30;
		this.buttons = init.buttons ?? 1;
		this.button = init.button ?? 0;
		this.isPrimary = init.isPrimary ?? true;
		this.relatedTarget = init.relatedTarget ?? null;
	}
}
class TestElement extends TrackedTarget {
	readonly nodeType = 1;
	readonly ownerDocument: TestDocument;
	constructor(doc: TestDocument) {
		super();
		this.ownerDocument = doc;
	}
}
class TestWindow extends TrackedTarget {
	readonly [Symbol.toStringTag] = "Window";
	readonly Document = TestDocument;
	readonly HTMLElement = TestElement;
	readonly SVGElement = TestElement;
	readonly PointerEvent = TestPointerEvent;
	readonly frames = new Map<number, FrameRequestCallback>();
	nextFrame = 0;
	requestAnimationFrame(callback: FrameRequestCallback) {
		const id = ++this.nextFrame;
		this.frames.set(id, callback);
		return id;
	}
	cancelAnimationFrame(id: number) {
		this.frames.delete(id);
	}
	tick() {
		const callbacks = [...this.frames.values()];
		this.frames.clear();
		for (const callback of callbacks) callback(16);
	}
}
class TestDocument extends TrackedTarget {
	readonly nodeType = 9;
	readonly defaultView = new TestWindow();
	readonly removeAllRanges = vi.fn();
	hidden = false;
	getSelection() {
		return { removeAllRanges: this.removeAllRanges };
	}
}

const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.runAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const publicSensor: Sensor<SidebarPointerSensorOptions> = SidebarPointerSensor;

function harness(doc = new TestDocument(), pointerId = 7) {
	const view = doc.defaultView;
	const source = new TestElement(doc);
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", view);
	const node: { current: HTMLElement | null } = { current: null };
	// The sole DOM boundary in this adapter fixture; production receives real nodes.
	Object.assign(node, { current: source });
	const event = new TestPointerEvent("pointerdown", { pointerId });
	source.dispatchEvent(event);
	const context: SensorContext = {
		activatorEvent: event,
		active: null,
		activeNode: null,
		collisionRect: null,
		collisions: null,
		draggableNodes: new Map(),
		draggingNode: null,
		draggingNodeRect: null,
		droppableRects: new Map(),
		droppableContainers: Object.assign(new Map<string | number, DroppableContainer>(), {
			toArray: () => [],
			getEnabled: () => [],
			getNodeFor: () => undefined,
		}),
		over: null,
		scrollableAncestors: [],
		scrollAdjustedTranslate: null,
	};
	const state = { valid: true, session: null as SidebarPointerSession | null, point: null as SidebarPoint | null };
	const order: string[] = [];
	const onStart = vi.fn((point: SidebarPoint) => {
		order.push("start");
		return point;
	});
	const onMove = vi.fn();
	const onEnd = vi.fn(() => order.push("end"));
	const onCancel = vi.fn(() => order.push("cancel"));
	const onAbort = vi.fn();
	const onPending = vi.fn();
	const options: SidebarPointerSensorOptions = {
		keybindings: { ...DEFAULT_APP_KEYBINDINGS },
		onSession: vi.fn((session) => {
			state.session = session;
		}),
		onPointer: vi.fn((point) => {
			state.point = point;
			order.push(`pointer:${point.x},${point.y}`);
		}),
		onFinish: vi.fn((outcome) => order.push(`finish:${outcome}`)),
		isValid: () => state.valid,
	};
	const props: SensorProps<SidebarPointerSensorOptions> = {
		active: "row",
		activeNode: { id: "row", key: "row", node, activatorNode: node, data: { current: undefined } },
		event,
		context: { current: context },
		options,
		onStart,
		onMove,
		onEnd,
		onCancel,
		onAbort,
		onPending,
	};
	const sensor = new publicSensor(props);
	const cancel = () => state.session?.cancel();
	cleanups.push(cancel);
	const pointer = (type: string, init: PointerEventInit = {}) => {
		const next = new TestPointerEvent(type, { pointerId, cancelable: true, clientY: 130, ...init });
		doc.dispatchEvent(next);
		return next;
	};
	const key = (properties: Record<string, unknown> = {}) =>
		doc.emit("keydown", {
			key: "Escape",
			code: "Escape",
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			shiftKey: false,
			isComposing: false,
			keyCode: 27,
			...properties,
		});
	const assertClean = () => {
		assert.equal(state.session, null);
		assert.equal(view.frames.size, 0);
		assert.equal(view.listeners.size, 0);
		vi.advanceTimersByTime(50);
		assert.equal(doc.listeners.size, 0);
	};
	return {
		doc,
		view,
		source,
		state,
		sensor,
		props,
		options,
		order,
		onStart,
		onMove,
		onEnd,
		onCancel,
		onAbort,
		onPending,
		pointer,
		key,
		cancel,
		assertClean,
	};
}

test("the public sensor observes the latest point before activation and end, including the activating move", () => {
	const ui = harness();
	assert.equal(ui.sensor.autoScrollEnabled, true);
	ui.pointer("pointermove", { clientX: 26, clientY: 30 });
	assert.equal(ui.onStart.mock.calls.length, 0, "activation is strictly beyond the six-pixel constraint");
	assert.equal(ui.onPending.mock.calls.length, 2);
	ui.pointer("pointermove", { clientX: 27, clientY: 30 });
	assert.deepEqual(ui.onStart.mock.calls, [[{ x: 20, y: 30 }]], "DndContext starts at the original point");
	assert.deepEqual(ui.state.point, { x: 27, y: 30 });
	assert.deepEqual(ui.order.slice(-2), ["pointer:27,30", "start"]);
	assert.deepEqual(ui.onMove.mock.calls, [[{ x: 27, y: 30 }]], "the overlay receives the activating move");
	assert.equal(ui.pointer("pointermove").defaultPrevented, true);
	assert.deepEqual(ui.onMove.mock.calls.at(-1), [{ x: 20, y: 130 }]);
	ui.pointer("pointerup", { clientX: 90, clientY: 145 });
	assert.deepEqual(ui.order.slice(-3), ["pointer:90,145", "end", "finish:end"]);
	assert.deepEqual(vi.mocked(ui.options.onFinish).mock.calls, [["end", true]]);
	ui.pointer("pointerup");
	ui.key();
	assert.equal(ui.onEnd.mock.calls.length, 1);
	assert.equal(ui.onCancel.mock.calls.length, 0, "finished sessions cannot create late outcomes");
	ui.assertClean();
});

test("an ordinary click never activates, clears selection, or installs drag click suppression", () => {
	const ui = harness();
	ui.pointer("pointermove", { clientX: 23, clientY: 34 });
	ui.pointer("pointerup", { clientX: 23, clientY: 34 });
	assert.equal(ui.onStart.mock.calls.length, 0);
	assert.equal(ui.onAbort.mock.calls.length, 1);
	assert.equal(ui.doc.removeAllRanges.mock.calls.length, 0);
	assert.equal(ui.doc.listeners.has("click"), false);
	assert.deepEqual(vi.mocked(ui.options.onFinish).mock.calls, [["end", false]]);
	ui.assertClean();
});

test("the custom sensor leaves click and selection suppression to the owning sidebar, not the document", () => {
	const ui = harness();
	ui.pointer("pointermove");
	assert.equal(ui.doc.removeAllRanges.mock.calls.length, 0);
	ui.doc.emit("selectionchange");
	assert.equal(ui.doc.removeAllRanges.mock.calls.length, 0);
	assert.equal(ui.doc.listeners.has("click"), false);
	assert.equal(ui.doc.emit("click").cancelBubble, false);
	ui.pointer("pointerup");
	ui.assertClean();
});

test("the real installed PointerSensor confirms the public adapter's strict six-pixel activation boundary", () => {
	const ui = harness();
	ui.cancel();
	ui.assertClean();
	const onStart = vi.fn();
	const onEnd = vi.fn();
	const onAbort = vi.fn();
	const onPending = vi.fn();
	new PointerSensor({
		...ui.props,
		options: { activationConstraint: { distance: 6 } },
		onStart,
		onEnd,
		onAbort,
		onPending,
	});
	ui.pointer("pointermove", { clientX: 26, clientY: 30 });
	assert.equal(onStart.mock.calls.length, 0);
	assert.equal(onPending.mock.calls.length, 2);
	ui.pointer("pointermove", { clientX: 27, clientY: 30 });
	assert.deepEqual(onStart.mock.calls, [[{ x: 20, y: 30 }]]);
	ui.pointer("pointerup");
	assert.equal(onEnd.mock.calls.length, 1);
	assert.equal(onAbort.mock.calls.length, 0);
	ui.assertClean();
});

for (const reason of [
	"blur",
	"resize",
	"hidden",
	"pointercancel",
	"lostpointercapture",
	"pointerout",
	"buttons",
	"owner",
] as const) {
	for (const active of [false, true]) {
		test(`${reason} cancels a ${active ? "live" : "pending"} session once without committing`, () => {
			const ui = harness();
			const session = ui.state.session;
			assert.ok(session);
			if (active) ui.pointer("pointermove");
			if (reason === "blur" || reason === "resize") ui.view.emit(reason);
			else if (reason === "hidden") {
				ui.doc.hidden = true;
				ui.doc.emit("visibilitychange");
			} else if (reason === "buttons") ui.pointer("pointermove", { buttons: 0 });
			else if (reason === "owner") session.cancel();
			else ui.pointer(reason);
			session.cancel();
			ui.pointer("pointerup");
			ui.key();
			assert.equal(ui.onCancel.mock.calls.length, 1);
			assert.equal(ui.onEnd.mock.calls.length, 0);
			assert.equal(ui.onAbort.mock.calls.length, active ? 0 : 1);
			assert.deepEqual(vi.mocked(ui.options.onFinish).mock.calls, [["cancel", false]]);
			ui.assertClean();
		});
	}
}

test("foreign pointer moves, releases and losses cannot activate or cancel the initiating pointer", () => {
	const ui = harness();
	for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture", "pointerout"]) {
		ui.pointer(type, { pointerId: 8, buttons: 0 });
	}
	assert.equal(ui.onStart.mock.calls.length, 0);
	assert.equal(ui.onCancel.mock.calls.length, 0);
	assert.equal(ui.onEnd.mock.calls.length, 0);
	ui.pointer("pointermove");
	for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture", "pointerout"]) {
		ui.pointer(type, { pointerId: 8, buttons: 0 });
	}
	ui.pointer("pointerout", { relatedTarget: ui.source });
	ui.doc.emit("visibilitychange");
	assert.equal(ui.onCancel.mock.calls.length, 0);
	ui.pointer("pointerup");
	assert.equal(ui.onEnd.mock.calls.length, 1);
	ui.assertClean();
});

test("the configured cancel binding respects composition without intercepting unconfigured Escape", () => {
	const ui = harness();
	const unrelated = vi.fn();
	ui.doc.addEventListener("keydown", unrelated);
	ui.pointer("pointermove");
	for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
		const event = ui.key(properties);
		assert.equal(event.defaultPrevented, false);
		assert.equal(event.cancelBubble, false);
		assert.equal(ui.onCancel.mock.calls.length, 0);
	}
	ui.options.keybindings = { ...ui.options.keybindings, cancelSidebarMove: "Ctrl-q" };
	const unconfigured = ui.key();
	assert.equal(unconfigured.defaultPrevented, false);
	assert.equal(unconfigured.cancelBubble, false);
	assert.equal(ui.onCancel.mock.calls.length, 0);
	assert.equal(unrelated.mock.calls.length, 3, "composition and unconfigured keys remain visible to other listeners");
	assert.equal(ui.key({ key: "q", code: "KeyQ", ctrlKey: true }).defaultPrevented, true);
	assert.deepEqual(vi.mocked(ui.options.onFinish).mock.calls, [["cancel", true]]);
	ui.doc.removeEventListener("keydown", unrelated);
	ui.assertClean();
});

test("an already-consumed cancel command does not cancel another input owner's session", () => {
	const ui = harness();
	const event = new Event("keydown", { cancelable: true });
	Object.assign(event, {
		key: "Escape",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
	});
	event.preventDefault();
	ui.doc.dispatchEvent(event);
	assert.equal(ui.onCancel.mock.calls.length, 0);
	ui.cancel();
	ui.assertClean();
});

for (const active of [false, true]) {
	for (const boundary of ["move", "up", "frame"] as const) {
		test(`${boundary} invalidation cancels a ${active ? "live" : "pending"} session before any commit`, () => {
			const ui = harness();
			if (active) ui.pointer("pointermove");
			ui.state.valid = false;
			if (boundary === "frame") ui.view.tick();
			else ui.pointer(boundary === "up" ? "pointerup" : "pointermove");
			assert.equal(ui.onEnd.mock.calls.length, 0);
			assert.equal(ui.onCancel.mock.calls.length, 1);
			ui.assertClean();
		});
	}
}

test("end and cancel remain exclusive when the owner reenters cancellation from abort", () => {
	const ui = harness();
	const session = ui.state.session;
	assert.ok(session);
	ui.onAbort.mockImplementation(() => session.cancel());
	ui.pointer("pointerup");
	assert.equal(ui.onEnd.mock.calls.length, 1);
	assert.equal(ui.onCancel.mock.calls.length, 0);
	ui.assertClean();
});

for (const boundary of ["move", "frame"] as const) {
	test(`reentrant ownership cleanup during ${boundary} validation cannot publish or schedule late work`, () => {
		const ui = harness();
		const before = vi.mocked(ui.options.onPointer).mock.calls.length;
		ui.options.isValid = () => {
			ui.cancel();
			return true;
		};
		if (boundary === "frame") ui.view.tick();
		else ui.pointer("pointermove");
		assert.equal(ui.onCancel.mock.calls.length, 1);
		assert.equal(ui.onStart.mock.calls.length, 0);
		assert.equal(vi.mocked(ui.options.onPointer).mock.calls.length, before);
		ui.assertClean();
	});
}

test("independent contexts and unrelated document listeners are unaffected by another session's cancellation", () => {
	const first = harness();
	first.pointer("pointermove");
	const second = harness(first.doc, 8);
	const unrelated = vi.fn();
	first.doc.addEventListener("pointermove", unrelated);
	first.doc.addEventListener("pointercancel", unrelated);
	second.pointer("pointermove");
	assert.equal(first.onCancel.mock.calls.length, 0);
	assert.equal(second.onStart.mock.calls.length, 1);
	assert.equal(unrelated.mock.calls.length, 1, "foreign-pointer events remain visible to later document listeners");
	first.cancel();
	assert.equal(second.onCancel.mock.calls.length, 0);
	assert.equal(unrelated.mock.calls.length, 1, "owned cancellation must not synthesize a global DOM event");
	second.pointer("pointerup");
	assert.equal(first.onEnd.mock.calls.length, 0);
	assert.equal(first.onCancel.mock.calls.length, 1);
	assert.equal(second.onEnd.mock.calls.length, 1);
	first.doc.removeEventListener("pointermove", unrelated);
	first.doc.removeEventListener("pointercancel", unrelated);
	second.assertClean();
});

test("only the public pointer activator is installed, with no keyboard pickup", () => {
	assert.deepEqual(
		SidebarPointerSensor.activators.map(({ eventName }) => eventName),
		["onPointerDown"],
	);
	const activator = SidebarPointerSensor.activators[0];
	assert.ok(activator);
	for (const init of [{ isPrimary: false }, { button: 2 }]) {
		assert.equal(
			Reflect.apply(activator.handler, undefined, [{ nativeEvent: new TestPointerEvent("pointerdown", init) }, {}]),
			false,
		);
	}
});
