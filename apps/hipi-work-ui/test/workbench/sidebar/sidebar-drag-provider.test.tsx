import assert from "node:assert/strict";
import type * as DndCore from "@dnd-kit/core";
import { DndContext, MeasuringStrategy } from "@dnd-kit/core";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS } from "../../../src/app/keybindings.ts";
import type {
	SidebarDragItem,
	SidebarPoint,
	SidebarRect,
} from "../../../src/features/workbench/sidebar/drag-controller.ts";
import {
	SidebarDragProvider,
	type SidebarOrderAction,
	useSidebarDragging,
	useSidebarSortable,
} from "../../../src/features/workbench/sidebar/drag-provider.tsx";
import {
	SidebarPointerSensor,
	type SidebarPointerSensorOptions,
} from "../../../src/features/workbench/sidebar/pointer-sensor.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
type DraggableAdapter = {
	options: Parameters<typeof DndCore.useDraggable>[0];
	setNodeRef: ReturnType<typeof vi.fn>;
	setActivatorNodeRef: ReturnType<typeof vi.fn>;
	onPointerDown: ReturnType<typeof vi.fn>;
};
type DroppableAdapter = {
	options: Parameters<typeof DndCore.useDroppable>[0];
	setNodeRef: ReturnType<typeof vi.fn>;
};
const hooks = vi.hoisted(() => ({
	cells: new Map<string, Cell[]>(),
	scope: "",
	cursor: 0,
	context: undefined as unknown,
	commits: [] as (() => void)[],
	draggables: new Map<DndCore.UniqueIdentifier, DraggableAdapter>(),
	droppables: new Map<DndCore.UniqueIdentifier, DroppableAdapter>(),
	locale: "en",
}));

// Callback-contract evidence only. Execute the real provider and sortable
// callbacks with narrow hook adapters, retaining actual dnd-kit component
// identities. Sensor lifecycle and real React integration have separate tests.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	function cell() {
		const cells = hooks.cells.get(hooks.scope) ?? [];
		hooks.cells.set(hooks.scope, cells);
		const index = hooks.cursor++;
		return { cells, index, previous: cells[index] };
	}
	function effect(callback: React.EffectCallback, deps?: React.DependencyList) {
		const { cells, index, previous } = cell();
		if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous.deps?.[offset]))) {
			hooks.commits.push(() => {
				previous?.cleanup?.();
				const cleanup = callback();
				cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
			});
		}
	}
	return {
		...actual,
		useContext: () => hooks.context,
		useState: <T,>(initial: T | (() => T)) => {
			const { cells, index, previous } = cell();
			const current = previous ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			cells[index] = current;
			return [
				current.value,
				(value: T | ((previous: T) => T)) => {
					current.value = typeof value === "function" ? (value as (previous: unknown) => T)(current.value) : value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const { cells, index, previous } = cell();
			const current = previous ?? { value: { current: initial } };
			cells[index] = current;
			return current.value;
		},
		useCallback: (callback: unknown, deps: React.DependencyList) => {
			const { cells, index, previous } = cell();
			const current =
				previous && deps.every((value, offset) => Object.is(value, previous.deps?.[offset]))
					? previous
					: { value: callback, deps };
			cells[index] = current;
			return current.value;
		},
		useId: () => `${hooks.scope}-${cell().index}`,
		useEffect: effect,
		useLayoutEffect: effect,
	};
});
vi.mock("@dnd-kit/core", async () => {
	const actual = await vi.importActual<typeof DndCore>("@dnd-kit/core");
	return {
		...actual,
		useSensor: <T extends DndCore.SensorOptions>(sensor: DndCore.Sensor<T>, options: T) => ({ sensor, options }),
		useSensors: (...sensors: DndCore.SensorDescriptor<DndCore.SensorOptions>[]) => sensors,
		useDraggable: (options: Parameters<typeof actual.useDraggable>[0]) => {
			const entry = hooks.draggables.get(options.id) ?? {
				options,
				setNodeRef: vi.fn(),
				setActivatorNodeRef: vi.fn(),
				onPointerDown: vi.fn(),
			};
			entry.options = options;
			hooks.draggables.set(options.id, entry);
			return {
				attributes: { "aria-describedby": "DndDescribedBy-test" },
				listeners: options.disabled ? undefined : { onPointerDown: entry.onPointerDown },
				setNodeRef: entry.setNodeRef,
				setActivatorNodeRef: entry.setActivatorNodeRef,
			};
		},
		useDroppable: (options: Parameters<typeof actual.useDroppable>[0]) => {
			const entry = hooks.droppables.get(options.id) ?? { options, setNodeRef: vi.fn() };
			entry.options = options;
			hooks.droppables.set(options.id, entry);
			return { setNodeRef: entry.setNodeRef };
		},
	};
});
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: hooks.locale }) }));

function drive<T>(scope: string, render: () => T) {
	hooks.scope = scope;
	hooks.cursor = 0;
	const result = render();
	for (const commit of hooks.commits.splice(0)) commit();
	return result;
}
function unmount(scope: string) {
	for (const cell of hooks.cells.get(scope) ?? []) cell?.cleanup?.();
	hooks.cells.delete(scope);
}
function invoke(callback: unknown, ...args: unknown[]) {
	assert.equal(typeof callback, "function");
	return Reflect.apply(callback as (...args: unknown[]) => unknown, undefined, args);
}
function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function element<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const found = elements(node, type);
	assert.equal(found.length, 1);
	const only = found[0];
	assert.ok(only);
	return only;
}

class CallbackDocument {
	readonly body = {};
	activeElement: unknown = this.body;
}
class CallbackElement {
	readonly ownerDocument: CallbackDocument;
	readonly rect: SidebarRect;
	parent: CallbackElement | null = null;
	kind = "row";
	isConnected = true;
	blocked = false;
	focus = vi.fn();
	constructor(document: CallbackDocument, rect: SidebarRect) {
		this.ownerDocument = document;
		this.rect = rect;
	}
	closest(selector: string): CallbackElement | null {
		if (selector === "button" && this.kind === "button") return this;
		if (selector === "[hidden], [inert]" && this.blocked) return this;
		return this.parent?.closest(selector) ?? null;
	}
	contains(target: unknown): boolean {
		return target === this || (target instanceof CallbackElement && !!target.parent && this.contains(target.parent));
	}
	getBoundingClientRect(): DndCore.ClientRect {
		return { ...this.rect, width: this.rect.right - this.rect.left, height: this.rect.bottom - this.rect.top };
	}
}
class CallbackHtmlElement extends CallbackElement {}

beforeEach(() => {
	hooks.cells.clear();
	hooks.commits = [];
	hooks.context = undefined;
	hooks.locale = "en";
	hooks.draggables.clear();
	hooks.droppables.clear();
	vi.clearAllMocks();
	vi.stubGlobal("Element", CallbackElement);
	vi.stubGlobal("HTMLElement", CallbackHtmlElement);
});
afterEach(() => {
	for (const scope of hooks.cells.keys()) unmount(scope);
	vi.unstubAllGlobals();
});

function harness() {
	const doc = new CallbackDocument();
	const scroll = new CallbackHtmlElement(doc, { left: 0, right: 240, top: 0, bottom: 200 });
	const row = new CallbackHtmlElement(doc, { left: 10, right: 210, top: 20, bottom: 60 });
	const button = new CallbackHtmlElement(doc, row.rect);
	button.kind = "button";
	button.parent = row;
	const text = new CallbackHtmlElement(doc, row.rect);
	text.kind = "span";
	text.parent = button;
	const icon = new CallbackElement(doc, row.rect);
	icon.kind = "svg";
	icon.parent = button;
	const target = new CallbackHtmlElement(doc, { left: 10, right: 210, top: 100, bottom: 140 });
	const move = vi.fn();
	const item: SidebarDragItem = {
		id: "source",
		group: "projects",
		label: "Source",
		revision: "order-1",
		disabled: false,
		after: "target",
		move,
	};
	const action: SidebarOrderAction = { item, up: "previous", down: "canonical-next" };
	const targetAction: SidebarOrderAction = {
		item: { ...item, id: "target", label: "Target", after: "canonical-next", move: vi.fn() },
		up: "source",
		down: null,
	};
	const scrollRef: React.RefObject<HTMLElement | null> = { current: null };
	const sourceRef: React.RefObject<HTMLElement | null> = { current: null };
	const targetRef: React.RefObject<HTMLElement | null> = { current: null };
	Object.assign(scrollRef, { current: scroll });
	Object.assign(sourceRef, { current: row });
	Object.assign(targetRef, { current: target });
	const keybindings: AppKeybindings = { ...DEFAULT_APP_KEYBINDINGS };
	const props = { children: null, scrollRef, disabled: false, keybindings };
	const render = () => {
		const tree = drive("provider", () => SidebarDragProvider(props));
		const context = element(tree, DndContext).props.children;
		assert.ok(isValidElement<{ value: unknown }>(context));
		hooks.context = context.props.value;
		return tree;
	};
	const dnd = () => element(render(), DndContext).props;
	const options = () => {
		const descriptor = dnd().sensors?.[0];
		assert.equal(descriptor?.sensor, SidebarPointerSensor);
		return descriptor.options as SidebarPointerSensorOptions;
	};
	const sortable = (nextAction = action) => drive("source", () => useSidebarSortable(nextAction, true, sourceRef));
	const targetSortable = () => drive("target", () => useSidebarSortable(targetAction, true, targetRef));
	const event = (collisions: DndCore.Collision[] | null = null): DndCore.DragMoveEvent => ({
		active: { id: "projects:source", data: { current: {} }, rect: { current: { initial: null, translated: null } } },
		activatorEvent: new Event("pointerdown"),
		collisions,
		delta: { x: 0, y: 100 },
		over: null,
	});
	const start = (targetNode: unknown = button, overrides: Record<string, unknown> = {}) => {
		const pointer = {
			target: targetNode,
			currentTarget: row,
			pointerId: 7,
			button: 0,
			isPrimary: true,
			clientX: 20,
			clientY: 30,
			defaultPrevented: false,
			preventDefault: vi.fn(),
			...overrides,
		};
		invoke(sortable().onPointerDown, pointer);
		return pointer;
	};
	const activate = (point: SidebarPoint = { x: 20, y: 130 }) => {
		options().onPointer(point);
		invoke(dnd().onDragStart, event());
		render();
	};
	const collision = (point: SidebarPoint = { x: 20, y: 130 }, measured = target.getBoundingClientRect()) => {
		options().onPointer(point);
		const detect = dnd().collisionDetection;
		assert.ok(detect);
		const key = `${targetAction.item.group}:${targetAction.item.id}`;
		return detect({
			active: event().active,
			collisionRect: row.getBoundingClientRect(),
			droppableRects: new Map([[key, measured]]),
			droppableContainers: [
				{ id: key, key, disabled: false, data: { current: {} }, node: targetRef, rect: { current: measured } },
			],
			pointerCoordinates: point,
		});
	};
	const preview = (point: SidebarPoint = { x: 20, y: 130 }) => {
		const collisions = collision(point);
		invoke(dnd().onDragMove, event(collisions));
		render();
		return collisions;
	};
	const end = (point: SidebarPoint = { x: 20, y: 130 }) => {
		options().onPointer(point);
		invoke(dnd().onDragEnd, event());
		options().onFinish("end", true);
		render();
	};
	const cancel = (restoreFocus = false) => {
		invoke(dnd().onDragCancel, event());
		options().onFinish("cancel", restoreFocus);
		render();
	};
	const dragging = () => {
		render();
		return drive("dragging", useSidebarDragging);
	};
	const click = (detail = 1) => {
		const clickEvent = { detail, preventDefault: vi.fn(), stopPropagation: vi.fn() };
		invoke(element(render(), "div").props.onClickCapture, clickEvent);
		return clickEvent;
	};
	render();
	sortable();
	targetSortable();
	return {
		doc,
		scroll,
		row,
		button,
		text,
		icon,
		target,
		move,
		action,
		targetAction,
		props,
		render,
		dnd,
		options,
		sortable,
		targetSortable,
		start,
		activate,
		collision,
		preview,
		end,
		cancel,
		dragging,
		click,
		event,
	};
}

test("sortable registers both actual library hook boundaries and delegates activation only to the pointer sensor", () => {
	const ui = harness();
	const draggable = hooks.draggables.get("projects:source");
	const droppable = hooks.droppables.get("projects:source");
	assert.deepEqual(draggable?.options, { id: "projects:source", disabled: false });
	assert.deepEqual(droppable?.options, { id: "projects:source", disabled: false });
	assert.deepEqual(draggable?.setNodeRef.mock.calls, [[ui.row]]);
	assert.deepEqual(droppable?.setNodeRef.mock.calls, [[ui.row]]);
	assert.equal(ui.sortable().describedBy, "DndDescribedBy-test");
	assert.equal(ui.dnd().sensors?.length, 1, "Space must not acquire a library keyboard sensor");
	assert.deepEqual(ui.options().activationConstraint, { distance: 6 });
	assert.equal(ui.options().keybindings, ui.props.keybindings);
	assert.equal(ui.dnd().measuring?.droppable?.strategy, MeasuringStrategy.WhileDragging);
	unmount("source");
	assert.deepEqual(draggable?.setNodeRef.mock.calls.at(-1), [null]);
	assert.deepEqual(droppable?.setNodeRef.mock.calls.at(-1), [null]);
});

for (const descendant of ["button", "text", "icon"] as const) {
	test(`drop callbacks from a ${descendant} commit once and restore the exact activating button`, () => {
		const ui = harness();
		if (descendant === "icon") assert.equal(ui.icon instanceof CallbackHtmlElement, false);
		ui.start(ui[descendant]);
		assert.equal(hooks.draggables.get("projects:source")?.onPointerDown.mock.calls.length, 1);
		assert.deepEqual(hooks.draggables.get("projects:source")?.setActivatorNodeRef.mock.calls, [[ui.button]]);
		ui.activate();
		ui.preview();
		assert.equal(ui.dragging(), true);
		assert.equal(ui.sortable()["data-drag-source"], true);
		assert.equal(ui.targetSortable()["data-drag-edge"], "after");
		ui.end();
		assert.deepEqual(ui.move.mock.calls, [["canonical-next"]]);
		assert.deepEqual(ui.button.focus.mock.calls, [[{ preventScroll: true }]]);
		assert.equal(ui.row.focus.mock.calls.length, 0);
		assert.equal(ui.dragging(), false);
		ui.end();
		assert.equal(ui.move.mock.calls.length, 1, "a duplicate completion cannot repeat persistence");
		assert.equal(ui.click().preventDefault.mock.calls.length, 1);
		assert.equal(ui.click().preventDefault.mock.calls.length, 0, "the scoped owner consumes exactly one pointer click");
	});
}

test("source metadata and its persistence callback are snapshotted at admission", () => {
	const ui = harness();
	ui.start();
	const laterMove = vi.fn();
	ui.action.item.move = laterMove;
	ui.action.item.label = "Changed label";
	ui.activate();
	assert.equal(invoke(ui.dnd().accessibility?.announcements?.onDragStart, ui.event()), "Moving Source");
	ui.end();
	assert.deepEqual(ui.move.mock.calls, [["canonical-next"]]);
	assert.equal(laterMove.mock.calls.length, 0);
});

test("invalid activation targets and nonprimary, secondary, consumed, or disabled starts never reach the sensor", () => {
	const ui = harness();
	for (const override of [{ button: 2 }, { isPrimary: false }, { defaultPrevented: true }])
		ui.start(ui.button, override);
	ui.start(ui.row);
	ui.start({});
	const outside = new CallbackHtmlElement(ui.doc, ui.row.rect);
	outside.kind = "button";
	ui.start(outside);
	ui.action.item.disabled = true;
	ui.start();
	ui.action.item.disabled = false;
	ui.props.disabled = true;
	ui.render();
	ui.start();
	assert.equal(hooks.draggables.get("projects:source")?.onPointerDown.mock.calls.length, 0);
	assert.equal(ui.dragging(), false);
	assert.equal(ui.move.mock.calls.length, 0);
});

test("the pending owner rejects replacement and ordinary below-threshold gestures remain normal clicks", () => {
	const ui = harness();
	ui.start();
	ui.start(ui.icon);
	assert.equal(hooks.draggables.get("projects:source")?.onPointerDown.mock.calls.length, 1);
	ui.options().onFinish("end", false);
	assert.equal(ui.dragging(), false);
	assert.equal(ui.click().preventDefault.mock.calls.length, 0);
	assert.equal(ui.button.focus.mock.calls.length, 0);
	ui.start(ui.icon);
	assert.equal(hooks.draggables.get("projects:source")?.onPointerDown.mock.calls.length, 2);
});

test("final pointer coordinates and fresh canonical anchors win over a previous collision preview", () => {
	const ui = harness();
	ui.start();
	ui.activate();
	ui.preview();
	ui.targetAction.item.after = "fresh-successor";
	ui.end();
	assert.deepEqual(ui.move.mock.calls, [["fresh-successor"]]);
	ui.start();
	ui.activate();
	ui.preview();
	ui.end({ x: 260, y: 130 });
	assert.equal(ui.move.mock.calls.length, 1, "leaving the sidebar on pointerup must discard the stale preview");
});

test("final geometry is measured again and does not trust stale or fabricated collision payloads", () => {
	const ui = harness();
	ui.start();
	ui.activate();
	invoke(
		ui.dnd().onDragMove,
		ui.event([
			{
				id: "projects:target",
				data: {
					sidebarDrop: {
						id: "target",
						edge: "after",
						before: "fabricated-anchor",
					},
				},
			},
		]),
	);
	Object.assign(ui.target.rect, { top: 120, bottom: 160 });
	ui.end({ x: 20, y: 130 });
	assert.equal(ui.move.mock.calls.length, 0, "the fresh before-target anchor equals the source successor");
});

for (const change of ["revision", "disabled", "missing", "hidden", "group", "provider-disabled"] as const) {
	test(`source ${change} invalidation blocks final persistence and requests sensor cancellation`, () => {
		const ui = harness();
		ui.start();
		ui.activate();
		const cancel = vi.fn();
		ui.options().onSession({ cancel });
		if (change === "revision") ui.sortable({ ...ui.action, item: { ...ui.action.item, revision: "order-2" } });
		else if (change === "disabled") ui.action.item.disabled = true;
		else if (change === "missing") unmount("source");
		else if (change === "hidden") ui.row.blocked = true;
		else if (change === "group") ui.sortable({ ...ui.action, item: { ...ui.action.item, group: "pinned" } });
		else ui.props.disabled = true;
		assert.equal(ui.options().isValid(), false);
		assert.ok(cancel.mock.calls.length > 0);
		ui.end();
		assert.equal(ui.move.mock.calls.length, 0);
	});
}

test("provider unmount cancels the active sensor and registration cleanup invalidates pending admission", () => {
	const ui = harness();
	ui.start();
	const cancel = vi.fn();
	ui.options().onSession({ cancel });
	unmount("provider");
	assert.equal(cancel.mock.calls.length, 1);
});

for (const activated of [false, true]) {
	test(`sensor-only finish clears ${activated ? "active" : "pending"} admission when dnd-kit emits no end callback`, () => {
		const ui = harness();
		ui.start();
		if (activated) ui.activate();
		const options = ui.options();
		ui.sortable({ ...ui.action, item: { ...ui.action.item, revision: "order-2" } });
		assert.equal(options.isValid(), false);
		options.onFinish("cancel", false);
		assert.equal(ui.dragging(), false);
		assert.equal(ui.move.mock.calls.length, 0);
		assert.equal(ui.click().preventDefault.mock.calls.length, activated ? 1 : 0);
		ui.start();
		assert.equal(
			hooks.draggables.get("projects:source")?.onPointerDown.mock.calls.length,
			2,
			"missing a library end event must not leave admission permanently occupied",
		);
	});
}

test("hidden, disconnected, disabled, and foreign-group targets never produce membership-changing drops", () => {
	const ui = harness();
	ui.start();
	ui.activate();
	for (const state of ["hidden", "disconnected", "disabled", "pinned", "sections"] as const) {
		ui.target.blocked = state === "hidden";
		ui.target.isConnected = state !== "disconnected";
		ui.targetAction.item.disabled = state === "disabled";
		ui.targetAction.item.group = state === "pinned" || state === "sections" ? state : "projects";
		ui.targetSortable();
		assert.deepEqual(ui.collision(), []);
	}
	ui.end();
	assert.equal(ui.move.mock.calls.length, 0);
});

test("collision detection consumes the library measurement map rather than separately measuring target DOM nodes", () => {
	const ui = harness();
	ui.start();
	ui.activate();
	Object.assign(ui.target.rect, { top: 300, bottom: 340 });
	const measured = { left: 10, right: 210, top: 100, bottom: 140, width: 200, height: 40 };
	assert.deepEqual(ui.collision({ x: 20, y: 130 }, measured), [
		{
			id: "projects:target",
			data: { sidebarDrop: { id: "target", edge: "after", before: "canonical-next" } },
		},
	]);
	assert.deepEqual(ui.collision(), []);
	assert.deepEqual(ui.collision({ x: 241, y: 130 }, measured), []);
});

test("malformed or absent collision previews clear the edge without dispatching a command", () => {
	const ui = harness();
	ui.start();
	ui.activate();
	ui.preview();
	assert.equal(ui.targetSortable()["data-drag-edge"], "after");
	for (const value of [
		null,
		{},
		{ id: "target", edge: "sideways", before: null },
		{ id: "target", edge: "after", before: 7 },
	]) {
		invoke(ui.dnd().onDragOver, ui.event([{ id: "projects:target", data: { sidebarDrop: value } }]));
		ui.render();
		assert.equal(ui.targetSortable()["data-drag-edge"], undefined);
	}
	assert.equal(ui.move.mock.calls.length, 0);
});

test("autoscroll is delegated to dnd-kit with a bounded edge zone and only the owning sidebar admitted", () => {
	const ui = harness();
	ui.start();
	ui.activate({ x: 20, y: 199 });
	const config = ui.dnd().autoScroll;
	assert.ok(config && typeof config === "object");
	assert.equal(config.acceleration, 14);
	assert.equal(config.interval, 16);
	assert.deepEqual(config.threshold, { x: 0, y: 36 / 200 });
	assert.equal(config.layoutShiftCompensation, false);
	assert.equal(invoke(config.canScroll, ui.scroll), true);
	assert.equal(invoke(config.canScroll, ui.row), false);
	for (const point of [
		{ x: 241, y: 199 },
		{ x: -1, y: 100 },
		{ x: 20, y: 201 },
		{ x: 20, y: -1 },
		{ x: 0, y: 199 },
		{ x: 240, y: 199 },
	]) {
		ui.options().onPointer(point);
		assert.equal(invoke(config.canScroll, ui.scroll), false);
	}
	Object.assign(ui.scroll.rect, { bottom: 30 });
	const small = ui.dnd().autoScroll;
	assert.ok(small && typeof small === "object");
	assert.equal(small.threshold?.y, 1 / 3);
	Object.assign(ui.scroll.rect, { bottom: 0 });
	const empty = ui.dnd().autoScroll;
	assert.ok(empty && typeof empty === "object");
	assert.equal(empty.threshold?.y, 0);
	ui.options().onPointer({ x: 20, y: 0 });
	assert.equal(invoke(empty.canScroll, ui.scroll), false, "a zero-height viewport has no valid edge speed ratio");
	ui.cancel();
	assert.equal(invoke(config.canScroll, ui.scroll), false);
});

test("an offscreen source remains valid but overflowed rows cannot receive an outside-sidebar release", () => {
	const ui = harness();
	ui.start();
	ui.activate();
	Object.assign(ui.row.rect, { top: -80, bottom: -40 });
	assert.equal(ui.options().isValid(), true);
	assert.equal(ui.collision().length, 1);
	Object.assign(ui.target.rect, { top: 220, bottom: 260 });
	assert.deepEqual(ui.collision({ x: 20, y: 250 }), []);
	ui.end({ x: 20, y: 250 });
	assert.equal(ui.move.mock.calls.length, 0);
});

function keyboard(overrides: Record<string, unknown> = {}) {
	return {
		key: "ArrowUp",
		altKey: true,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		repeat: false,
		defaultPrevented: false,
		nativeEvent: { isComposing: false },
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		...overrides,
	};
}

test("Alt-Up and Alt-Down use the same canonical command owner while Space remains navigation", () => {
	const ui = harness();
	const up = keyboard();
	invoke(ui.sortable().onKeyDown, up);
	invoke(ui.sortable().onKeyDown, keyboard({ key: "ArrowDown" }));
	ui.action.down = null;
	invoke(ui.sortable().onKeyDown, keyboard({ key: "ArrowDown" }));
	const space = keyboard({ key: " ", altKey: false });
	invoke(ui.sortable().onKeyDown, space);
	assert.deepEqual(ui.move.mock.calls, [["previous"], ["canonical-next"], [null]]);
	assert.equal(up.preventDefault.mock.calls.length, 1);
	assert.equal(up.stopPropagation.mock.calls.length, 1);
	assert.equal(space.preventDefault.mock.calls.length, 0);
	assert.equal(hooks.draggables.get("projects:source")?.onPointerDown.mock.calls.length, 0);
});

test("keyboard callbacks reject composition, repetition, consumed events, disabled state, and unavailable moves", () => {
	const ui = harness();
	for (const override of [
		{ repeat: true },
		{ defaultPrevented: true },
		{ nativeEvent: { isComposing: true } },
		{ nativeEvent: { isComposing: false, keyCode: 229 } },
		{ altKey: false },
	])
		invoke(ui.sortable().onKeyDown, keyboard(override));
	ui.action.item.disabled = true;
	invoke(ui.sortable().onKeyDown, keyboard());
	ui.action.item.disabled = false;
	ui.action.up = undefined;
	invoke(ui.sortable().onKeyDown, keyboard());
	ui.action.up = "previous";
	ui.props.disabled = true;
	ui.render();
	invoke(ui.sortable().onKeyDown, keyboard());
	ui.props.disabled = false;
	ui.render();
	ui.start();
	ui.activate();
	invoke(ui.sortable().onKeyDown, keyboard());
	assert.equal(ui.move.mock.calls.length, 0);
});

test("keyboard bindings remain configurable and cancellation options receive the same settings", () => {
	const ui = harness();
	ui.props.keybindings = {
		...ui.props.keybindings,
		moveSidebarUp: "Ctrl-k",
		moveSidebarDown: "Ctrl-j",
		cancelSidebarMove: "Ctrl-q",
	};
	ui.render();
	invoke(ui.sortable().onKeyDown, keyboard());
	for (const key of ["k", "j"]) invoke(ui.sortable().onKeyDown, keyboard({ key, ctrlKey: true, altKey: false }));
	assert.deepEqual(ui.move.mock.calls, [["previous"], ["canonical-next"]]);
	assert.equal(ui.options().keybindings.cancelSidebarMove, "Ctrl-q");
});

test("scoped cancellation suppression does not swallow keyboard clicks or a new pointer gesture", () => {
	const ui = harness();
	ui.start();
	ui.activate();
	ui.cancel(true);
	assert.deepEqual(ui.button.focus.mock.calls, [[{ preventScroll: true }]]);
	assert.equal(ui.click(0).preventDefault.mock.calls.length, 0);
	assert.equal(ui.click(1).preventDefault.mock.calls.length, 0);
	ui.start();
	ui.activate();
	ui.cancel();
	invoke(element(ui.render(), "div").props.onPointerDownCapture);
	assert.equal(ui.click().preventDefault.mock.calls.length, 0);
	assert.equal(ui.move.mock.calls.length, 0);
});

test("drag completion cannot steal a later dialog's focus or focus a hidden or detached activator", () => {
	const ui = harness();
	for (const owner of ["dialog", "hidden", "detached"] as const) {
		ui.start();
		ui.activate();
		if (owner === "dialog") ui.doc.activeElement = {};
		else if (owner === "hidden") ui.button.blocked = true;
		else ui.button.isConnected = false;
		ui.end();
		ui.button.blocked = false;
		ui.button.isConnected = true;
		ui.doc.activeElement = ui.doc.body;
	}
	assert.equal(ui.button.focus.mock.calls.length, 0);
});

for (const locale of ["en", "zh-CN"]) {
	test(`${locale} accessibility uses visible labels, configured bindings, and no internal drag identifiers`, () => {
		hooks.locale = locale;
		const ui = harness();
		ui.props.keybindings = { ...ui.props.keybindings, moveSidebarUp: "Ctrl-k", moveSidebarDown: "Ctrl-j" };
		ui.start();
		ui.activate();
		const accessibility = ui.dnd().accessibility;
		assert.equal(accessibility?.restoreFocus, false, "the exact button remains the provider's focus owner");
		const instructions = accessibility?.screenReaderInstructions?.draggable;
		assert.match(instructions ?? "", /Ctrl-k/);
		assert.match(instructions ?? "", /Ctrl-j/);
		assert.doesNotMatch(instructions ?? "", /Space|projects:source|DndDescribedBy/);
		const start = invoke(accessibility?.announcements?.onDragStart, ui.event());
		assert.equal(start, locale === "en" ? "Moving Source" : "正在移动Source");
		assert.equal(invoke(accessibility?.announcements?.onDragOver, ui.event()), undefined);
		assert.equal(invoke(accessibility?.announcements?.onDragEnd, ui.event()), undefined);
		assert.equal(
			invoke(accessibility?.announcements?.onDragCancel, ui.event()),
			locale === "en" ? "Move cancelled" : "已取消移动",
		);
	});
}
