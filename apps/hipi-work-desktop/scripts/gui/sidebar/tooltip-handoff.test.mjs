import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import {
	assertOwnedTooltip,
	assertPointerTooltipHandoff,
	sidebarTooltipOwners,
	sidebarTooltipOwnersRetained,
	sidebarTooltipState,
	startSidebarTooltipTrace,
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
