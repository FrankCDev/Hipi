import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	assertContextContinuity,
	assertContextMenuClosed,
	assertContextMenuOpen,
	contextHoverReady,
	contextMenuState,
	contextRowSurfaceSettled,
	retainedTargetPoint,
} from "./context-menu.mjs";

test("native ellipsis geometry rejects detached, hidden and obstructed retained targets without scrolling", () => {
	let rect = { x: 12, y: 24, width: 28, height: 28 };
	const child = {};
	let hit = child;
	const node = {
		isConnected: true,
		getBoundingClientRect: () => rect,
		contains: (candidate) => candidate === child,
		scrollIntoView: () => assert.fail("Native input must not repair geometry by scrolling"),
	};
	const document = {
		elementFromPoint: (x, y) => {
			assert.equal(x, 26);
			assert.equal(y, 38);
			return hit;
		},
	};
	assert.deepEqual(retainedTargetPoint(document, node), { x: 26, y: 38 });
	hit = {};
	assert.equal(retainedTargetPoint(document, node), null);
	hit = null;
	assert.equal(retainedTargetPoint(document, node), null);
	node.isConnected = false;
	assert.equal(retainedTargetPoint(document, node), null);
	node.isConnected = true;
	rect = { ...rect, width: 0 };
	assert.equal(retainedTargetPoint(document, node), null);
});

// These synthetic observations test only the oracle, never native browser behavior.
const baseline = {
	route: "hipi-work://app/index.html",
	selected: [{ workspaceId: "project-a", conversationId: "current", location: "pinned" }],
	draft: "Unsent 中文",
	messages: [
		{ id: "user", text: "Request" },
		{ id: "assistant", text: "Answer" },
	],
};
const expected = {
	menuWidth: 320,
	hoverSurface: "rgb(240, 240, 240)",
	labels: ["Unpin conversation", "Rename conversation", "Archive conversation"],
	title: "Identical title",
	created: "2026-10-20T00:00:00.000Z",
};
const opened = (entry = "context") => ({
	...structuredClone(baseline),
	samePanel: true,
	sameComposer: true,
	sameHistory: true,
	sameMessages: true,
	sameRows: true,
	sameTriggers: true,
	sameStaticRows: true,
	sameStaticTriggers: true,
	sameSourceRow: true,
	sameSourceTrigger: true,
	uniqueSource: true,
	sourceConnected: true,
	dialogCount: 0,
	menuCount: 1,
	menuOpen: true,
	menuVisible: true,
	menuWidth: 320,
	previewPadding: ["8px", "8px", "8px", "8px"],
	rowBackground: expected.hoverSurface,
	rowAnimations: [],
	sourceHovered: false,
	railVisible: true,
	menuSlot: `${entry === "context" ? "context" : "dropdown"}-menu-content`,
	previewCount: 0,
	contextOwners: entry === "context" ? 1 : 0,
	ellipsisOwners: entry === "ellipsis" ? 1 : 0,
	sourceContextOpen: entry === "context",
	sourceEllipsisOpen: entry === "ellipsis",
	focusInMenu: true,
	previousMenuConnected: false,
	freshMenu: true,
	itemsReady: true,
	labels: [...expected.labels],
	titles: [expected.title],
	created: [expected.created],
});

test("surface observation flushes the genuine row style and reads its animations without altering them", () => {
	const reads = [];
	const animation = Object.freeze({ pending: true, playState: "running" });
	const row = {
		dataset: {},
		isConnected: true,
		closest: () => null,
		querySelector: () => null,
		matches: (selector) => selector === ":hover",
		getAnimations() {
			reads.push("animations");
			return [animation];
		},
	};
	const source = { isConnected: true, closest: () => row };
	const document = {
		querySelector: () => null,
		querySelectorAll: (selector) => (selector === ".sidebar-preview-row" ? [row] : []),
		defaultView: {
			location: { href: baseline.route },
			getComputedStyle(node) {
				assert.equal(node, row, "Sample the retained source's row, never a clone");
				reads.push("style");
				return { backgroundColor: expected.hoverSurface };
			},
		},
	};
	const retained = {
		source,
		sourceRow: row,
		sourceSelector: ".source",
		messages: [],
		rows: [row],
		triggers: [],
		staticRows: [row],
		staticTriggers: [],
	};
	const value = contextMenuState(document, retained);
	assert.deepEqual(reads, ["style", "animations"]);
	assert.equal(value.rowBackground, expected.hoverSurface);
	assert.equal(value.triggerDataState, null);
	assert.equal(value.triggerDataSlot, null);
	assert.equal(value.railComputedWidth, null);
	assert.equal(value.railComputedOpacity, null);
	assert.deepEqual(value.rowAnimations, [animation]);
	assert.equal(contextRowSurfaceSettled(value), false);
	row.getAnimations = undefined;
	assert.throws(() => contextMenuState(document, retained), /requires Element.getAnimations/);
	row.getAnimations = () => [];
	const rail = { getClientRects: () => [], getBoundingClientRect: () => ({ width: 0 }) };
	row.querySelector = () => rail;
	retained.trigger = {
		getAttribute: (name) =>
			({ "data-state": "closed", "data-slot": "tooltip-trigger", "aria-expanded": "true" })[name] ?? null,
	};
	let railStyle = { width: "0px", opacity: "0" };
	document.defaultView.getComputedStyle = (node) =>
		node === rail ? railStyle : { backgroundColor: expected.hoverSurface };
	const collision = contextMenuState(document, retained);
	assert.equal(collision.triggerDataState, "closed");
	assert.equal(collision.triggerDataSlot, "tooltip-trigger");
	assert.equal(collision.sourceEllipsisOpen, true);
	assert.equal(collision.railComputedWidth, 0);
	assert.equal(collision.railComputedOpacity, 0);
	assert.equal(collision.railVisible, false);
	railStyle = { width: "auto", opacity: "Infinity" };
	const invalid = contextMenuState(document, retained);
	assert.equal(invalid.railComputedWidth, null);
	assert.equal(invalid.railComputedOpacity, null);
});

test("hover sampling waits for actual animation settlement, not repeated matching colors", () => {
	const hovered = {
		...opened(),
		sourceHovered: true,
		menuCount: 0,
		contextOwners: 0,
		ellipsisOwners: 0,
	};
	assert.equal(contextHoverReady(hovered), true);
	for (const rowAnimations of [
		undefined,
		[{ pending: true, playState: "running" }],
		[{ pending: false, playState: "running" }],
		[{ pending: false, playState: "paused" }],
		[{ pending: true, playState: "finished" }],
		[{ pending: true, playState: "idle" }],
		[{ playState: "finished" }],
	]) {
		// The sampled color already equals the expected color; it must still be rejected.
		const value = { ...hovered, rowAnimations };
		assert.equal(contextHoverReady(value), false);
		assert.equal(contextHoverReady(value), false);
		assert.equal(contextRowSurfaceSettled(value), false);
	}
	for (const playState of ["finished", "idle"])
		assert.equal(contextHoverReady({ ...hovered, rowAnimations: [{ pending: false, playState }] }), true);
	for (const [field, value] of [
		["sourceConnected", false],
		["sourceHovered", false],
		["railVisible", false],
		["menuCount", 1],
		["contextOwners", 1],
		["ellipsisOwners", 1],
		["rowBackground", ""],
	])
		assert.equal(contextHoverReady({ ...hovered, [field]: value }), false, field);
});

test("native menu oracle accepts distinct context and ellipsis observations", () => {
	for (const entry of ["context", "ellipsis"]) assertContextMenuOpen(opened(entry), baseline, expected, entry);
});

test("context continuity rejects navigation, duplicate selection, draft loss and remounted owners", () => {
	for (const [field, value] of [
		["route", "hipi-work://app/index.html#other"],
		["selected", [{ workspaceId: "project-a", conversationId: "source", location: "recent" }]],
		["selected", [...baseline.selected, ...baseline.selected]],
		["draft", ""],
		["messages", [{ id: "replacement", text: "Answer" }]],
		...[
			"samePanel",
			"sameComposer",
			"sameHistory",
			"sameMessages",
			"sameStaticRows",
			"sameStaticTriggers",
			"sameSourceRow",
			"sameSourceTrigger",
			"uniqueSource",
			"sourceConnected",
		].map((field) => [field, false]),
		["dialogCount", 1],
	])
		assert.throws(() => assertContextContinuity({ ...opened(), [field]: value }, baseline), undefined, field);
});

test("unowned virtual-window turnover does not weaken exact menu ownership", () => {
	const value = { ...opened(), sameRows: false, sameTriggers: false };
	assertContextMenuOpen(value, baseline, expected, "context");
	for (const field of [
		"sameSourceRow",
		"sameSourceTrigger",
		"uniqueSource",
		"sourceConnected",
		"sameStaticRows",
		"sameStaticTriggers",
	])
		assert.throws(
			() => assertContextMenuOpen({ ...value, [field]: false }, baseline, expected, "context"),
			undefined,
			field,
		);
});

test("DOM observation distinguishes virtual turnover from replacing the exact row or trigger", () => {
	const makeRow = (id, virtual) => {
		const item = { dataset: { workspaceId: "project", conversationId: id } };
		const row = { isConnected: true, dataset: {}, getAnimations: () => [], matches: () => false };
		row.closest = (selector) => (selector === "[data-window-row]" && virtual ? item : null);
		const trigger = { isConnected: true, closest: row.closest, getAttribute: () => null };
		row.querySelector = (selector) => (selector === ".conversation-actions-trigger" ? trigger : null);
		return { row, trigger };
	};
	const fixed = makeRow("pinned", false);
	const owned = makeRow("source", true);
	const retired = makeRow("old-window", true);
	const entered = makeRow("new-window", true);
	let currentOwner = owned;
	const source = { isConnected: true, closest: () => currentOwner.row };
	const document = {
		querySelectorAll: (selector) =>
			({
				".sidebar-preview-row": [fixed.row, currentOwner.row, entered.row],
				".conversation-actions-trigger": [fixed.trigger, currentOwner.trigger, entered.trigger],
				".source": [source],
			})[selector] ?? [],
		querySelector: (selector) => (selector === ".source" ? source : null),
		defaultView: {
			location: { href: baseline.route },
			getComputedStyle: () => ({ backgroundColor: expected.hoverSurface }),
		},
	};
	const retained = {
		source,
		sourceSelector: ".source",
		sourceRow: owned.row,
		trigger: owned.trigger,
		messages: [],
		rows: [fixed.row, owned.row, retired.row],
		triggers: [fixed.trigger, owned.trigger, retired.trigger],
		staticRows: [fixed.row],
		staticTriggers: [fixed.trigger],
	};
	let state = contextMenuState(document, retained);
	assert.equal(state.sameRows, false);
	assert.equal(state.sameTriggers, false);
	for (const field of ["sameStaticRows", "sameStaticTriggers", "sameSourceRow", "sameSourceTrigger", "uniqueSource"])
		assert.equal(state[field], true, field);
	assert.deepEqual(
		state.virtualRows.map((row) => row.conversationId),
		["source", "new-window"],
	);
	currentOwner = makeRow("source", true);
	state = contextMenuState(document, retained);
	assert.equal(state.sourceConnected, true, "A connected child alone cannot establish its row/trigger ownership");
	assert.equal(state.sameSourceRow, false);
	assert.equal(state.sameSourceTrigger, false);
	currentOwner = owned;
	owned.trigger.isConnected = false;
	assert.equal(contextMenuState(document, retained).sameSourceTrigger, false);
});

test("open oracle rejects stale menus, duplicate owners, hover leakage and wrong actions", () => {
	for (const [field, value] of [
		["menuCount", 0],
		["menuCount", 2],
		["menuOpen", false],
		["menuVisible", false],
		["menuWidth", 160],
		["previewPadding", ["5px", "8px", "5px", "8px"]],
		["rowBackground", "transparent"],
		["rowBackground", "oklab(0.928879 -0.0000321567 -0.000340641 / 0.162903)"],
		["rowAnimations", [{ pending: false, playState: "running" }]],
		["rowAnimations", undefined],
		["sourceHovered", true],
		["railVisible", false],
		["menuSlot", "dropdown-menu-content"],
		["previewCount", 1],
		["contextOwners", 2],
		["ellipsisOwners", 1],
		["sourceContextOpen", false],
		["sourceEllipsisOpen", true],
		["focusInMenu", false],
		["previousMenuConnected", true],
		["freshMenu", false],
		["itemsReady", false],
		["labels", []],
		["labels", [...expected.labels, expected.labels[0]]],
		["labels", ["Pin conversation", ...expected.labels.slice(1)]],
		["titles", ["Other title"]],
		["created", ["2026-10-19T00:00:00.000Z"]],
	])
		assert.throws(
			() => assertContextMenuOpen({ ...opened(), [field]: value }, baseline, expected, "context"),
			undefined,
			field,
		);
	assert.throws(() => assertContextMenuOpen(opened(), baseline, expected, "synthetic"));
});

test("Escape oracle requires unmounted menus and the exact entry-specific focus owner", () => {
	for (const entry of ["context", "ellipsis"]) {
		const closed = {
			...opened(entry),
			menuCount: 0,
			contextOwners: 0,
			ellipsisOwners: 0,
			focusOnSource: entry === "context",
			focusOnTrigger: entry === "ellipsis",
		};
		assertContextMenuClosed(closed, baseline, entry);
		for (const [field, value] of [
			["menuCount", 1],
			["contextOwners", 1],
			["ellipsisOwners", 1],
			["previousMenuConnected", true],
			["previewCount", 1],
			[entry === "context" ? "focusOnSource" : "focusOnTrigger", false],
		])
			assert.throws(() => assertContextMenuClosed({ ...closed, [field]: value }, baseline, entry), undefined, field);
	}
});

test("probe uses real right mouse and Escape input without synthetic or destructive fallbacks", async () => {
	const source = await readFile(new URL("./context-menu.mjs", import.meta.url), "utf8");
	assert.match(source, /Input\.dispatchMouseEvent/);
	assert.match(source, /button: "right"/);
	assert.match(source, /button: "left"/);
	assert.doesNotMatch(source, /\bclick\s*\(/);
	assert.match(source, /retainedTargetPoint\.toString\(\)/);
	assert.match(source, /Input\.dispatchKeyEvent/);
	assert.doesNotMatch(
		source,
		/dispatchEvent|new (?:MouseEvent|PointerEvent|KeyboardEvent)|\.focus\(|\.value\s*=|no-sandbox|Input\.insertText|scrollIntoView/,
	);
	assert.match(source, /await revealRecentConversation\(cdp, scope, revealEvidence\)/);
	assert.match(source, /keyboardContextMenu:.*verified: false/s);
});
