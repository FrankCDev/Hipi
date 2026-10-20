import assert from "node:assert/strict";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { SidebarTitle } from "../src/features/workbench/sidebar-title.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[] }));

// A bounded DOM-measurement/effect adapter; it does not claim to exercise a browser's animation engine.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: { current: initial } };
			hooks.cells[index] = cell;
			return cell.value;
		},
		useState: <T,>(initial: T) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: initial };
			hooks.cells[index] = cell;
			return [
				cell.value,
				(value: React.SetStateAction<T>) => {
					cell.value = typeof value === "function" ? (value as (prior: T) => T)(cell.value as T) : value;
				},
			];
		},
		useLayoutEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const previous = hooks.cells[index];
			if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps?.[offset]))) {
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
			}
		},
	};
});

type Span = React.ReactElement<React.ComponentProps<"span">>;
function child(parent: Span): Span {
	const node = parent.props.children;
	assert.ok(isValidElement<React.ComponentProps<"span">>(node));
	return node;
}
function setRef(node: Span, current: object) {
	assert.ok(node.props.ref && typeof node.props.ref === "object");
	Object.assign(node.props.ref, { current });
}
function attr(node: Span, name: string): unknown {
	return Reflect.get(node.props, name);
}

beforeEach(() => {
	hooks.cells = [];
	hooks.cursor = 0;
	hooks.commits = [];
});
afterEach(() => {
	for (const cell of hooks.cells) cell.cleanup?.();
	vi.unstubAllGlobals();
});

function mount() {
	const dimensions = { viewport: 100.25, content: 240.25, scale: 1.5, fontSize: 14, direction: "ltr" };
	const frames = new Map<number, FrameRequestCallback>();
	const windowEvents = new Map<string, () => void>();
	const fontEvents = new Map<string, () => void>();
	let nextFrame = 0;
	const ancestor = { parentElement: null };
	const resizeObservers: {
		callback: () => void;
		observe: ReturnType<typeof vi.fn>;
		disconnect: ReturnType<typeof vi.fn>;
	}[] = [];
	const appearanceObservers: {
		callback: () => void;
		observe: ReturnType<typeof vi.fn>;
		disconnect: ReturnType<typeof vi.fn>;
	}[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn();
			disconnect = vi.fn();
			constructor(callback: () => void) {
				resizeObservers.push({ callback, observe: this.observe, disconnect: this.disconnect });
			}
		},
	);
	vi.stubGlobal(
		"MutationObserver",
		class {
			observe = vi.fn();
			disconnect = vi.fn();
			constructor(callback: () => void) {
				appearanceObservers.push({ callback, observe: this.observe, disconnect: this.disconnect });
			}
		},
	);
	const label = {
		getBoundingClientRect: () => ({ width: dimensions.content * dimensions.scale }),
		scrollWidth: 0,
	};
	const view = {
		getComputedStyle: (element: object) =>
			element === label
				? { fontSize: `${dimensions.fontSize}px`, direction: dimensions.direction }
				: { width: `${dimensions.viewport}px` },
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		addEventListener: (type: string, listener: () => void) => windowEvents.set(type, listener),
		removeEventListener: (type: string) => windowEvents.delete(type),
	};
	const viewport = {
		getBoundingClientRect: () => ({ width: dimensions.viewport * dimensions.scale }),
		offsetWidth: 100,
		clientWidth: 100,
		parentElement: ancestor,
		ownerDocument: {
			defaultView: view,
			fonts: {
				addEventListener: (type: string, listener: () => void) => fontEvents.set(type, listener),
				removeEventListener: (type: string) => fontEvents.delete(type),
			},
		},
	};
	const props = { text: "A title which actually overflows", hovered: false };
	const render = () => {
		hooks.cursor = 0;
		const output = SidebarTitle(props);
		setRef(output, viewport);
		setRef(child(child(output)), label);
		for (const commit of hooks.commits.splice(0)) commit();
		return output;
	};
	render();
	return {
		props,
		dimensions,
		render,
		frames,
		resizeObservers,
		appearanceObservers,
		windowEvents,
		fontEvents,
		viewport,
		label,
		flush() {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(0);
		},
	};
}

test("the title observes actual viewport/content geometry and coalesces layout notifications", () => {
	const ui = mount();
	const title = ui.render();
	assert.equal(attr(title, "data-overflowing"), true);
	assert.equal(attr(title, "data-hovered"), false);
	assert.equal(Reflect.get(title.props.style ?? {}, "--sidebar-title-offset"), "-140px");
	assert.deepEqual(ui.resizeObservers[0]?.observe.mock.calls, [[ui.viewport], [ui.label]]);
	ui.dimensions.viewport -= 28;
	ui.resizeObservers[0]?.callback();
	ui.appearanceObservers[0]?.callback();
	ui.windowEvents.get("resize")?.();
	assert.equal(ui.frames.size, 1);
	ui.flush();
	assert.equal(Reflect.get(ui.render().props.style ?? {}, "--sidebar-title-offset"), "-168px");
	assert.equal(ui.frames.size, 0, "Measurement must not create a permanent frame loop");
});

test("font loading and direction changes refresh speed and translation without character-count estimates", () => {
	const ui = mount();
	ui.dimensions.fontSize = 28;
	ui.fontEvents.get("loadingdone")?.();
	ui.flush();
	assert.equal(Reflect.get(ui.render().props.style ?? {}, "--sidebar-title-duration"), "2500ms");
	ui.dimensions.direction = "rtl";
	ui.appearanceObservers[0]?.callback();
	ui.flush();
	assert.equal(attr(ui.render(), "data-direction"), "rtl");
	assert.equal(Reflect.get(ui.render().props.style ?? {}, "--sidebar-title-offset"), "140px");
	ui.dimensions.content = ui.dimensions.viewport + 0.5;
	ui.resizeObservers[0]?.callback();
	ui.flush();
	assert.equal(attr(ui.render(), "data-overflowing"), false);
	assert.deepEqual(ui.render().props.style, {});
});

test("parent hover controls movement, leaving removes it and a renamed title resets the animated subtree", () => {
	const ui = mount();
	const resting = ui.render();
	ui.props.hovered = true;
	assert.equal(attr(ui.render(), "data-hovered"), true);
	ui.props.hovered = false;
	assert.equal(attr(ui.render(), "data-hovered"), false);
	assert.equal(resting.props.onFocus, undefined);
	assert.equal(resting.props.onPointerEnter, undefined);
	const previousClip = child(resting);
	ui.props.text = "A replacement title";
	const changed = ui.render();
	assert.notEqual(child(changed).key, previousClip.key);
	assert.equal(child(child(changed)).props.children, "A replacement title");
});

test("unmount releases observers, font/window listeners and queued measurement callbacks", () => {
	const ui = mount();
	const resize = ui.resizeObservers[0];
	const appearance = ui.appearanceObservers[0];
	assert.ok(resize && appearance);
	resize.callback();
	const queued = [...ui.frames.values()];
	assert.equal(queued.length, 1);
	for (const cell of hooks.cells) {
		cell.cleanup?.();
		cell.cleanup = undefined;
	}
	assert.equal(resize.disconnect.mock.calls.length, 1);
	assert.equal(appearance.disconnect.mock.calls.length, 1);
	assert.equal(ui.frames.size, 0);
	assert.equal(ui.fontEvents.size, 0);
	assert.equal(ui.windowEvents.size, 0);
	resize.callback();
	appearance.callback();
	for (const callback of queued) callback(0);
	assert.equal(ui.frames.size, 0, "Late observer delivery cannot resubscribe after disposal");
});
