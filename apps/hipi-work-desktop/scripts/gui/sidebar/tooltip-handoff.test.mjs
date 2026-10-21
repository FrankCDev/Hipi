import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import {
	assertOwnedTooltip,
	assertPointerTooltipHandoff,
	assertTooltipPointerExit,
	observeTooltipLifecycle,
	observeTooltipPointer,
	sidebarTooltipOwners,
	sidebarTooltipOwnersRetained,
	sidebarTooltipState,
	startSidebarTooltipTrace,
	tooltipExitPath,
} from "./tooltip-handoff.mjs";

const state = () => ({
	collapse: { label: "Hide navigation", focused: false, focusVisible: false, hovered: false },
	toggle: {
		label: "Toggle navigation",
		expanded: "false",
		focused: true,
		focusVisible: false,
		hovered: false,
		box: { x: 8, y: 8, right: 36, bottom: 36 },
	},
	tooltips: [],
});
const trace = () => ({
	events: [{ type: "pointerdown", trusted: true }],
	frames: [0, 100, 300, 700].map((elapsed) => ({ elapsed, pointer: { x: 250, y: 20 }, ...state() })),
});

test("lifecycle diagnostics retain focus, key, ancestor scroll and tooltip mutation chronology without changing DOM", async () => {
	const dom = new JSDOM(
		`<section class="sidebar-surface"><button class="sidebar-collapse" data-tooltip-state="closed" aria-label="Hide"></button></section><button class="navigation-toggle" aria-label="Toggle"></button>`,
	);
	try {
		const { document } = dom.window;
		const surface = document.querySelector("section");
		const collapse = document.querySelector(".sidebar-collapse");
		const observer = runInNewContext(`(${observeTooltipLifecycle.toString()})(document,read)`, {
			document,
			read: sidebarTooltipState,
		});
		collapse.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
		collapse.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		Object.defineProperty(surface, "scrollLeft", { value: 24 });
		surface.dispatchEvent(new dom.window.Event("scroll"));
		collapse.setAttribute("data-tooltip-state", "instant-open");
		await Promise.resolve();
		collapse.setAttribute("data-tooltip-state", "closed");
		const markup = document.body.innerHTML;
		const result = observer.stop();
		assert.equal(document.body.innerHTML, markup);
		assert.deepEqual(
			Array.from(result.events, (event) => event.type),
			["start", "focusin", "keydown", "scroll", "attribute", "attribute"],
		);
		assert.equal(result.events[2].key, "Enter");
		assert.equal(result.events[1].trusted, false, "Model events must never be claimed as native evidence");
		assert.equal(result.events[3].target.scrollLeft, 24);
		assert.equal(result.events[3].target.containsCollapse, true);
		assert.equal(result.events[3].target.containsToggle, false);
		assert.equal(result.events[4].oldValue, "closed");
		assert.equal(result.events[4].state.collapse.tooltipState, "instant-open");
		assert.equal(result.events[5].oldValue, "instant-open");
		assert.equal(result.final.collapse.tooltipState, "closed");
		assert.equal(result.surface.scrollLeft, 24);
		collapse.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
		collapse.setAttribute("data-tooltip-state", "delayed-open");
		await Promise.resolve();
		assert.equal(result.events.length, 6, "stop removes listeners and disconnects mutations");
	} finally {
		dom.window.close();
	}
});

test("lifecycle diagnostics bound event storage and explicitly report overflow", () => {
	const dom = new JSDOM(`<button class="sidebar-collapse"></button><button class="navigation-toggle"></button>`);
	try {
		const { document } = dom.window;
		const observer = observeTooltipLifecycle(document, sidebarTooltipState);
		for (let index = 0; index < 300; index++) document.dispatchEvent(new dom.window.Event("scroll"));
		const result = observer.stop();
		assert.equal(result.events.length, 256);
		assert.equal(result.dropped, 45);
		assert.ok(result.final.collapse);
	} finally {
		dom.window.close();
	}
});

test("measured continuous exit ends beyond both rectangles and previous padded grace hull", () => {
	for (const [viewport, trigger, tip] of [
		[
			{ width: 1400, height: 900 },
			{ x: 12, y: 4.5, right: 48, bottom: 40.5 },
			{ x: 50, y: 8, right: 126, bottom: 38 },
		],
		[
			{ width: 300, height: 900 },
			{ x: 12, y: 4.5, right: 48, bottom: 40.5 },
			{ x: 50, y: 8, right: 126, bottom: 38 },
		],
		[
			{ width: 1400, height: 900 },
			{ x: 1300, y: 850, right: 1330, bottom: 880 },
			{ x: 1150, y: 840, right: 1290, bottom: 880 },
		],
	]) {
		const value = {
			viewport,
			toggle: { label: "Toggle navigation", box: trigger },
			tooltips: [{ label: "Toggle navigation", state: "instant-open", box: tip }],
		};
		const path = tooltipExitPath(value, "toggle");
		assert.equal(path.length, 4);
		const final = path.at(-1),
			prior = path.at(-2);
		assert.ok(final.x >= 0 && final.x < viewport.width && final.y >= 0 && final.y < viewport.height);
		// Convex hull is contained in this conservative bounding rectangle, including
		// the public primitive's5px padding around the preceding leave destination.
		const hull = {
			x: Math.min(trigger.x, tip.x, prior.x - 5),
			right: Math.max(trigger.right, tip.right, prior.x + 5),
			y: Math.min(trigger.y, tip.y, prior.y - 5),
			bottom: Math.max(trigger.bottom, tip.bottom, prior.y + 5),
		};
		assert.ok(final.x < hull.x || final.x > hull.right || final.y < hull.y || final.y > hull.bottom);
		assert.ok(Number.isInteger(final.x) && Number.isInteger(final.y));
		assert.throws(() => tooltipExitPath({ ...value, tooltips: [] }, "toggle"));
		assert.throws(() => tooltipExitPath({ ...value, viewport: { width: NaN, height: 900 } }, "toggle"));
	}
});

test("pointer diagnostics retain trusted leave/move coordinates and remove listeners", () => {
	const listeners = new Map();
	const document = {
		addEventListener: (type, fn) => listeners.set(type, fn),
		removeEventListener: (type) => listeners.delete(type),
	};
	const trace = observeTooltipPointer(document);
	for (const [type, x] of [
		["pointerleave", 138],
		["pointermove", 154],
	])
		listeners.get(type)({ type, clientX: x, clientY: 23, isTrusted: true });
	const result = trace.stop();
	assert.deepEqual(result.pointer, { x: 154, y: 23 });
	assert.deepEqual(
		result.events.map(({ type, trusted, x }) => ({ type, trusted, x })),
		[
			{ type: "pointerleave", trusted: true, x: 138 },
			{ type: "pointermove", trusted: true, x: 154 },
		],
	);
	assert.equal(listeners.size, 0);
});

test("continuous exit must close the tooltip without blurring or changing pointer-restored focus", () => {
	const entry = {
		path: [
			{ x: 138, y: 23 },
			{ x: 154, y: 23 },
		],
		input: {
			pointer: { x: 154, y: 23 },
			events: [
				{ type: "pointermove", trusted: true },
				{ type: "pointermove", trusted: true },
			],
		},
		final: state(),
	};
	assertTooltipPointerExit(entry);
	for (const mutate of [
		(v) => {
			v.final.toggle.focused = false;
		},
		(v) => {
			v.final.toggle.focusVisible = true;
		},
		(v) => {
			v.final.toggle.hovered = true;
		},
		(v) => {
			v.final.tooltips = [{ state: "instant-open" }];
		},
		(v) => {
			v.input.pointer.x = 138;
		},
		(v) => {
			v.input.events.pop();
		},
		(v) => {
			v.input.events[0].trusted = false;
		},
	]) {
		const changed = structuredClone(entry);
		mutate(changed);
		assert.throws(() => assertTooltipPointerExit(changed));
	}
});

test("content continuity cannot pass with absent, disconnected or replaced owners", () => {
	const nodes = new Map();
	const document = { querySelector: (selector) => nodes.get(selector) ?? null };
	assert.throws(() => sidebarTooltipOwners(document), /actual mounted content owner/);
	assert.equal(sidebarTooltipOwnersRetained(document, { home: null, composer: null, panel: null }), false);
	const home = { isConnected: true };
	nodes.set(".prepared-task-input", home);
	const retained = sidebarTooltipOwners(document);
	assert.equal(sidebarTooltipOwnersRetained(document, retained), true);
	home.isConnected = false;
	assert.equal(sidebarTooltipOwnersRetained(document, retained), false);
	nodes.set(".prepared-task-input", { isConnected: true });
	assert.equal(sidebarTooltipOwnersRetained(document, retained), false);
	nodes.clear();
	nodes.set(".composer textarea", { isConnected: true });
	assert.throws(() => sidebarTooltipOwners(document));
	nodes.set(".conversation-panel", { isConnected: true });
	assert.equal(sidebarTooltipOwnersRetained(document, sidebarTooltipOwners(document)), true);
});

test("pointer handoff samples beyond motion and tooltip delay and permits only retiring old hint", () => {
	const value = trace();
	value.frames[0].tooltips = [{ label: "Hide navigation", state: "closed" }];
	assertPointerTooltipHandoff(value);
	for (const mutate of [
		(v) => {
			v.frames[1].tooltips = [{ label: "Toggle navigation", state: "instant-open" }];
		},
		(v) => {
			v.frames[1].tooltips = [{ label: "Hide navigation", state: "delayed-open" }];
		},
		(v) => {
			v.frames[3].tooltips = [{ label: "Hide navigation", state: "closed" }];
		},
		(v) => {
			v.frames[0].tooltips = [{ label: "Toggle navigation", state: "closed" }];
		},
		(v) => {
			v.frames[1].toggle.focusVisible = true;
		},
		(v) => {
			v.frames[1].toggle.focused = false;
		},
		(v) => {
			v.frames[1].toggle.hovered = true;
		},
		(v) => {
			v.frames[1].pointer = { x: 20, y: 20 };
		},
		(v) => {
			v.frames[1].pointer = null;
		},
		(v) => {
			v.frames.pop();
		},
		(v) => {
			v.frames = [];
		},
		(v) => {
			v.events[0].trusted = false;
		},
	]) {
		const changed = structuredClone(value);
		mutate(changed);
		assert.throws(() => assertPointerTooltipHandoff(changed));
	}
});

test("fresh hover and real keyboard focus must expose exactly their own tooltip", () => {
	const value = state();
	value.toggle.hovered = true;
	value.tooltips = [{ label: "Toggle navigation", state: "delayed-open" }];
	assertOwnedTooltip(value, "toggle");
	assert.throws(() => assertOwnedTooltip(value, "toggle", true));
	value.toggle.focusVisible = true;
	value.toggle.hovered = false;
	assertOwnedTooltip(value, "toggle", true);
	for (const tips of [[], [{ label: "wrong", state: "instant-open" }], [...value.tooltips, ...value.tooltips]])
		assert.throws(() => assertOwnedTooltip({ ...value, tooltips: tips }, "toggle", true));
});

test("serialized observer records exact tooltip labels without hidden accessibility duplicates", () => {
	const dom = new JSDOM(
		`<button class="sidebar-collapse" aria-label="Hide navigation"></button><button class="navigation-toggle" aria-label="Toggle navigation" aria-expanded="false"></button><div data-slot="tooltip-content" data-state="instant-open"><span>Toggle navigation</span><span role="tooltip">Toggle navigation</span></div>`,
	);
	try {
		const document = dom.window.document;
		const before = document.body.innerHTML;
		const value = runInNewContext(`(${sidebarTooltipState.toString()})(document)`, { document });
		assert.equal(value.toggle.expanded, "false");
		assert.equal(value.tooltips[0].label, "Toggle navigation");
		assert.equal(document.body.innerHTML, before);
		document.querySelector(".sidebar-collapse").remove();
		assert.throws(() => sidebarTooltipState(document), /Expected one tooltip control/);
	} finally {
		dom.window.close();
	}
});

test("frame trace starts qualification at collapse commit and removes every read-only listener", () => {
	const listeners = new Map();
	let callback, cancelled;
	const document = {
		defaultView: {
			requestAnimationFrame: (fn) => {
				callback = fn;
				return 1;
			},
			cancelAnimationFrame: (id) => {
				cancelled = id;
			},
		},
		addEventListener: (type, fn) => listeners.set(type, fn),
		removeEventListener: (type) => listeners.delete(type),
	};
	const value = state();
	value.toggle.expanded = "true";
	const observer = startSidebarTooltipTrace(document, () => structuredClone(value));
	callback(100);
	assert.equal(observer.frames.length, 0);
	listeners.get("pointerdown")({ type: "pointerdown", clientX: 250, clientY: 20, isTrusted: true });
	value.toggle.expanded = "false";
	callback(200);
	callback(900);
	assertPointerTooltipHandoff(observer.stop());
	assert.equal(listeners.size, 0);
	assert.equal(cancelled, 1);
});

test("native tooltip regression preserves geometry/alias integration and uses no DOM input shortcuts", async () => {
	const source = await readFile(new URL("./tooltip-handoff.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /dispatchEvent|scrollIntoView|scrollTop\s*=|\.focus\(|\.click\(/);
	assert.match(source, /Input\.dispatchMouseEvent/);
	assert.match(source, /Input\.dispatchKeyEvent/);
	const journey = await readFile(new URL("./journey.mjs", import.meta.url), "utf8");
	assert.ok(
		journey.indexOf("await exerciseSidebarTooltipHandoff(") < journey.indexOf("await exerciseSidebarRowGeometry("),
	);
	assert.ok(journey.indexOf("await exerciseSidebarRowGeometry(") < journey.indexOf("await exerciseAliasSelection("));
	const registry = await readFile(new URL("../../verify-source.mjs", import.meta.url), "utf8");
	assert.match(
		registry,
		/nodeTests\.push\("apps\/hipi-work-desktop\/scripts\/gui\/sidebar\/tooltip-handoff\.test\.mjs"\)/,
	);
});
