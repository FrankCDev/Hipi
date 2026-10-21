import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	assertSidebarKeyboardDelivery,
	assertSidebarKeyboardRestored,
	assertSidebarKeyboardSelection,
	observeSidebarKeyboard,
	prepareSidebarKeyboardBoundary,
	sidebarKeyboardMenuPoint,
	sidebarKeyboardState,
} from "./item-navigation.mjs";

const scope = {
	kind: "conversation",
	workspaceId: "project-a",
	conversationId: "same-title",
	location: "pinned",
	projectId: null,
};
const baseline = () => ({
	selected: [scope],
	surface: "conversation",
	draft: "Unsent 中文",
	messages: [{ id: "message-one", text: "Persisted answer" }],
});

test("menu setup observes only the unique exact pinned source and an exposed hit-testable trigger", () => {
	let hit,
		opacity = "1",
		duplicate = false,
		triggerCount = 1;
	const node = () => ({
		isConnected: true,
		closest: () => null,
		getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 30 }),
		contains: (value) => value === hit && value !== null,
	});
	const source = node(),
		trigger = node();
	source.dataset = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
	source.closest = (selector) =>
		selector === ".sidebar-preview-row" ? { querySelectorAll: () => Array(triggerCount).fill(trigger) } : null;
	const document = {
		querySelectorAll: () => (duplicate ? [source, source] : [source]),
		defaultView: { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity }) },
		elementFromPoint: () => hit,
	};
	source.contains = (value) => value === source;
	trigger.contains = (value) => value === trigger;
	hit = source;
	assert.deepEqual(sidebarKeyboardMenuPoint(document, scope, "source"), { x: 50, y: 35 });
	assert.equal(sidebarKeyboardMenuPoint(document, scope, "trigger"), null);
	hit = trigger;
	assert.deepEqual(sidebarKeyboardMenuPoint(document, scope, "trigger"), { x: 50, y: 35 });
	opacity = "0";
	assert.equal(sidebarKeyboardMenuPoint(document, scope, "trigger"), null);
	opacity = "1";
	duplicate = true;
	assert.equal(sidebarKeyboardMenuPoint(document, scope, "source"), null);
	duplicate = false;
	triggerCount = 2;
	assert.equal(sidebarKeyboardMenuPoint(document, scope, "trigger"), null);
	triggerCount = 1;
	assert.equal(sidebarKeyboardMenuPoint(document, { ...scope, workspaceId: "foreign" }, "source"), null);
	trigger.isConnected = false;
	assert.equal(sidebarKeyboardMenuPoint(document, scope, "trigger"), null);
});

test("menu setup reveals with native motion before clicking and never repairs a tested shortcut", async () => {
	const source = await readFile(new URL("./item-navigation.mjs", import.meta.url), "utf8");
	const setup = source.slice(source.indexOf("const menuScope ="), source.indexOf("const menuEvents ="));
	assert.doesNotMatch(setup, /await click\(|scrollIntoView|scrollTop\s*=|\.focus\(|dispatchEvent/);
	assert.ok(setup.indexOf('menuPoint("source")') < setup.indexOf('menuPoint("trigger")'));
	assert.ok(setup.indexOf('type: "mouseMoved"') < setup.indexOf('"mousePressed"'));
	assert.equal(setup.split("assertSidebarKeyboardRestored(await read(), baseline)").length - 1, 2);
	const measured = source.slice(source.indexOf("const menuEvents ="), source.indexOf('case: "menu owns shortcut'));
	assert.doesNotMatch(measured, /menuPoint|mouseMoved|await restore\(|await click\(/);
});

test("independent row observation keeps project and alias identities in DOM order, excluding inaccessible rows", () => {
	const row = (chat, current = false, hidden = false) => ({
		isConnected: true,
		dataset: {
			workspaceId: "project-a",
			conversationId: "same-title",
			sidebarLocation: "project",
			sidebarLocationProject: "logical-a",
		},
		classList: { contains: () => chat },
		closest: (selector) =>
			selector === ".workspace-branch" ? { dataset: { workspaceId: "project-a", projectId: "logical-a" } } : hidden,
		matches: () => false,
		getClientRects: () => [{}],
		getAttribute: () => (current ? "page" : null),
	});
	const nodes = [row(false), row(true, true), row(true, false, true)];
	const document = {
		defaultView: { getComputedStyle: () => ({ visibility: "visible" }), CSS: { escape: (value) => value } },
		querySelectorAll: (selector) => {
			if (selector === ".sidebar .project-open,.sidebar .conversation-link") return nodes;
			assert.ok(["[data-message-id]", '[role="menu"]'].includes(selector));
			return [];
		},
		querySelector: (selector) =>
			selector === ".composer textarea" || selector === ".conversation-panel .composer textarea"
				? { value: "Draft" }
				: null,
	};
	const state = sidebarKeyboardState(document);
	assert.deepEqual(
		state.rows.map((item) => item.identity),
		[
			{ kind: "project", workspaceId: "project-a", projectId: "logical-a" },
			{
				kind: "conversation",
				workspaceId: "project-a",
				conversationId: "same-title",
				location: "project",
				projectId: "logical-a",
			},
		],
	);
	assert.deepEqual(state.selected, [state.rows[1].identity]);
	assert.match(state.rows[1].selector, /data-sidebar-location-project="logical-a"/);
	assert.equal(state.draft, "Draft");
	assert.equal(state.surface, "conversation");
});

test("keyboard selection requires exact canonical location, not title or conversation ID alone", () => {
	assertSidebarKeyboardSelection(baseline(), scope);
	for (const selected of [
		[],
		[scope, scope],
		[{ ...scope, workspaceId: "other" }],
		[{ ...scope, location: "recent" }],
		[{ ...scope, projectId: "wrong-project" }],
	])
		assert.throws(() => assertSidebarKeyboardSelection({ selected }, scope));
	assertSidebarKeyboardSelection(
		{ selected: [{ kind: "project", workspaceId: "project-a" }], surface: "project" },
		{ kind: "project", workspaceId: "project-a" },
	);
	assert.throws(() => assertSidebarKeyboardSelection({ ...baseline(), surface: "project" }, scope));
});

test("boundary setup stabilizes newly mounted terminal rows before any measured chord", async () => {
	const rows = [0, 1, 2].map((index) => ({
		identity: { ...scope, conversationId: `chat-${index}` },
		selector: `row-${index}`,
	}));
	let mounted = rows.slice(0, 2);
	let selected = rows[0].identity;
	const clicks = [];
	const result = await prepareSidebarKeyboardBoundary({
		read: async () => ({ rows: mounted, selected: [selected], surface: "conversation" }),
		select: async (row) => {
			clicks.push(row.selector);
			selected = row.identity;
			mounted = rows;
		},
		boundary: "last",
		limit: 3,
	});
	assert.deepEqual(clicks, ["row-1", "row-2"]);
	assert.deepEqual(result.target.identity, rows[2].identity);
	assert.equal(result.setupSelections, 2);
});

test("boundary setup rejects an unstable fixture or failed selection rather than qualifying a chord", async () => {
	let version = 0;
	await assert.rejects(
		prepareSidebarKeyboardBoundary({
			read: async () => ({
				rows: [{ identity: { ...scope, conversationId: `${++version}` } }],
				selected: [scope],
				surface: "conversation",
			}),
			select: async () => {},
			boundary: "last",
			limit: 2,
		}),
		/no boundary chord was tested/,
	);
	await assert.rejects(
		prepareSidebarKeyboardBoundary({
			read: async () => ({ rows: [{ identity: scope }], selected: [], surface: "conversation" }),
			select: async () => {},
			boundary: "first",
			limit: 1,
		}),
		/Exactly one canonical/,
	);
});

test("keyboard restoration rejects missing draft, wrong history identity/content and alias drift", () => {
	assertSidebarKeyboardRestored(baseline(), baseline());
	for (const changed of [
		{ ...baseline(), draft: "" },
		{ ...baseline(), selected: [{ ...scope, location: "recent" }] },
		{ ...baseline(), messages: [] },
		{ ...baseline(), messages: [{ id: "replacement", text: "Persisted answer" }] },
		{ ...baseline(), messages: [{ id: "message-one", text: "Wrong text" }] },
	])
		assert.throws(() => assertSidebarKeyboardRestored(changed, baseline()));
});

test("delivery oracle requires every trusted event, exact modifiers and genuine renderer repeat flag", () => {
	for (const platform of ["darwin", "linux", "win32"]) {
		const events = [false, true].map((repeat) => ({
			key: "ArrowRight",
			repeat,
			trusted: true,
			alt: true,
			ctrl: platform !== "darwin",
			meta: platform === "darwin",
			shift: false,
		}));
		assertSidebarKeyboardDelivery(events, "ArrowRight", 1, platform);
		for (const field of ["trusted", "alt", "ctrl", "meta", "shift", "repeat"]) {
			const bad = structuredClone(events);
			bad[1][field] = !bad[1][field];
			assert.throws(() => assertSidebarKeyboardDelivery(bad, "ArrowRight", 1, platform));
		}
		assert.throws(() => assertSidebarKeyboardDelivery(events.slice(0, 1), "ArrowRight", 1, platform));
		assert.throws(() => assertSidebarKeyboardDelivery([...events, events[0]], "ArrowRight", 1, platform));
		assert.throws(() => assertSidebarKeyboardDelivery(events, "]", 1, platform));
	}
});

test("read-only key observer records delivery without cancelling input and removes its listener", () => {
	const listeners = new Map();
	const window = {
		addEventListener: (name, listener, capture) => {
			assert.equal(capture, true);
			listeners.set(name, listener);
		},
		removeEventListener: (name, listener, capture) => {
			assert.equal(capture, true);
			assert.equal(listeners.get(name), listener);
			listeners.delete(name);
		},
	};
	const trace = observeSidebarKeyboard(window);
	listeners.get("keydown")({ key: "Escape" });
	assert.equal(trace.events.length, 0);
	listeners.get("keydown")({
		key: "]",
		repeat: false,
		isTrusted: true,
		altKey: true,
		ctrlKey: true,
		metaKey: false,
		shiftKey: false,
	});
	assertSidebarKeyboardDelivery(trace.events, "]", 0, "linux");
	trace.stop();
	assert.equal(listeners.size, 0);
});

test("native keyboard harness uses CDP input, preserves previous acceptance and declares physical limits", async () => {
	const source = await readFile(new URL("./item-navigation.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /dispatchEvent|new KeyboardEvent|\.focus\(|\.click\(|\.value\s*=/);
	assert.match(source, /Input\.dispatchKeyEvent/);
	assert.match(source, /physicalOsAccelerators:.*qualified: false/s);
	assert.match(source, /physicalIme:.*qualified: false/s);
	assert.doesNotMatch(source, /imeSetComposition|CompositionEvent/);
	const journey = await readFile(new URL("./journey.mjs", import.meta.url), "utf8");
	const invocation = journey.indexOf("await exerciseSidebarKeyboard(");
	assert.ok(invocation > journey.indexOf("text: seed.draft"));
	assert.ok(invocation < journey.indexOf("void(window.__sidebarContinuity="));
	assert.match(journey, /assert\.equal\(baseline\.messages\.length, 2/);
});
