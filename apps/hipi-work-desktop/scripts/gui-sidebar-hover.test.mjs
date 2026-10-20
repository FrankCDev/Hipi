import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	assertPreviewBounds,
	assertSidebarHoverProtection,
	assertSidebarHoverTrace,
	startSidebarHoverTrace,
} from "./gui-sidebar-hover.mjs";

function validWarmHoverTrace() {
	const targets = ["pinned-title", "project-title", "recent-title"].map((owner, index) => ({
		owner,
		point: { x: 120, y: 100 + index * 80 },
		title: index === 1 ? "GUI disclosure empty project" : "Same conversation in two rows",
		metadata: {
			titles: [index === 1 ? "GUI disclosure empty project" : "Same conversation in two rows"],
			created: index === 1 ? [] : ["2026-10-20T12:00:00.000Z"],
			workspaces: index === 0 ? ["Chats"] : [],
			projects: index === 1 ? 1 : 0,
			projectMetadata: index === 1 ? ["0 chats", "No local folder connected"] : [],
		},
	}));
	const card = (target) => ({
		owner: target.owner,
		x: 270,
		y: 200,
		width: 320,
		height: 100,
		viewportWidth: 1400,
		viewportHeight: 872,
		positioned: true,
		visible: true,
		interactive: true,
		hit: true,
		title: target.title,
		contentFits: true,
		animationName: "none",
		runningAnimations: 0,
		metadata: structuredClone(target.metadata),
	});
	return {
		targets,
		armedAt: 0,
		truncated: false,
		moves: targets.map((target, index) => ({
			at: [10, 260, 300][index],
			owner: target.owner,
			...target.point,
			trusted: true,
		})),
		frames: [
			{ at: 1, owner: null, cards: [] },
			{ at: 100, owner: targets[0].owner, cards: [] },
			{ at: 210, owner: targets[0].owner, cards: [{ ...card(targets[0]), y: -1000, positioned: false }] },
			{ at: 230, owner: targets[0].owner, cards: [card(targets[0])] },
			{ at: 270, owner: targets[1].owner, cards: [card(targets[1])] },
			{ at: 310, owner: targets[2].owner, cards: [card(targets[2])] },
			{ at: 330, owner: targets[2].owner, cards: [card(targets[2])] },
		],
	};
}

test("frame oracle allows only initial cold positioning and checks all three distinct row owners", () => {
	const trace = validWarmHoverTrace();
	assert.deepEqual(assertSidebarHoverTrace(trace), {
		frames: 7,
		owners: ["pinned-title", "project-title", "recent-title"],
		coldDelayMs: 220,
	});
	for (const mutate of [
		(trace) => {
			trace.frames[4].cards = [];
		},
		(trace) => {
			trace.frames[4].cards.push(structuredClone(trace.frames[3].cards[0]));
		},
		(trace) => {
			trace.frames[4].cards[0].visible = false;
		},
		(trace) => {
			trace.frames[4].cards[0].positioned = false;
		},
		(trace) => {
			trace.frames[4].cards[0].interactive = false;
		},
		(trace) => {
			trace.frames[4].cards[0].hit = false;
		},
		(trace) => {
			trace.frames[4].cards[0].x = -1;
		},
		(trace) => {
			trace.frames[4].cards[0].contentFits = false;
		},
		(trace) => {
			trace.frames[5].cards[0].owner = trace.targets[0].owner;
		},
		(trace) => {
			trace.frames[4].cards[0].title = trace.targets[0].title;
		},
		(trace) => {
			trace.frames[5].cards[0].metadata.workspaces = ["Chats"];
		},
		(trace) => {
			trace.frames[5].cards[0].metadata.created = ["2026-10-19T12:00:00.000Z"];
		},
		(trace) => {
			trace.frames[4].cards[0].metadata.created = trace.targets[0].metadata.created;
		},
		(trace) => {
			trace.frames[4].cards[0].metadata.projectMetadata = ["Loading…"];
		},
		(trace) => {
			trace.frames[2].cards[0].animationName = "popover-in";
		},
		(trace) => {
			trace.frames[2].cards[0].runningAnimations = 1;
		},
	]) {
		const invalid = validWarmHoverTrace();
		mutate(invalid);
		assert.throws(() => assertSidebarHoverTrace(invalid));
	}
});

test("frame oracle rejects incomplete, nonnative, mistimed and owner-skipping qualification", () => {
	for (const mutate of [
		(trace) => {
			trace.truncated = true;
		},
		(trace) => {
			trace.moves[1].trusted = false;
		},
		(trace) => {
			trace.moves[1].x++;
		},
		(trace) => {
			trace.moves[1].owner = trace.targets[0].owner;
		},
		(trace) => {
			trace.moves[1].at = NaN;
		},
		(trace) => {
			trace.frames[3].at = 140;
			trace.frames.splice(2, 1);
		},
		(trace) => {
			trace.frames.splice(4, 1);
		},
		(trace) => {
			trace.frames[4].owner = trace.targets[0].owner;
		},
		(trace) => {
			trace.frames[3].cards = [];
		},
		(trace) => {
			trace.moves[2].at = 560;
			trace.frames[5].at = 570;
			trace.frames[6].at = 590;
		},
	]) {
		const invalid = validWarmHoverTrace();
		mutate(invalid);
		assert.throws(() => assertSidebarHoverTrace(invalid));
	}
});

test("protection oracle distinguishes card-control focus from ordinary retained row focus", () => {
	const warm = validWarmHoverTrace();
	const [project, recent] = warm.targets.slice(1);
	const moves = [{ owner: recent.owner, cardOwner: null, ...recent.point }];
	const trace = {
		armedAt: 200,
		truncated: false,
		targets: [project, recent],
		moves: [{ at: 260, ...moves[0], trusted: true }],
		frames: [
			{
				at: 230,
				owner: null,
				cards: [structuredClone(warm.frames[4].cards[0])],
				focusedCardOwner: project.owner,
			},
			{
				at: 270,
				owner: recent.owner,
				cards: [structuredClone(warm.frames[4].cards[0])],
				focusedCardOwner: project.owner,
			},
		],
	};
	const blocked = {
		initialOwner: project.owner,
		moves,
		focus: { field: "focusedCardOwner", owner: project.owner },
	};
	assertSidebarHoverProtection(trace, blocked);
	for (const mutate of [
		(trace) => {
			trace.frames[1].cards = [structuredClone(warm.frames[5].cards[0])];
		},
		(trace) => {
			trace.frames[1].focusedCardOwner = null;
		},
		(trace) => {
			trace.moves = [];
		},
		(trace) => {
			trace.frames.pop();
		},
		(trace) => {
			trace.frames[1].cards = [];
		},
	]) {
		const invalid = structuredClone(trace);
		mutate(invalid);
		assert.throws(() => assertSidebarHoverProtection(invalid, blocked));
	}
	const rowTrace = structuredClone(trace);
	for (const frame of rowTrace.frames) {
		frame.focusedCardOwner = null;
		frame.focusedRowOwner = project.owner;
	}
	rowTrace.frames[1].cards = [structuredClone(warm.frames[5].cards[0])];
	const handoff = {
		initialOwner: project.owner,
		handoffOwner: recent.owner,
		moves,
		focus: { field: "focusedRowOwner", owner: project.owner },
	};
	assertSidebarHoverProtection(rowTrace, handoff);
	rowTrace.frames[1].cards = [structuredClone(warm.frames[4].cards[0])];
	assert.throws(() => assertSidebarHoverProtection(rowTrace, handoff));
});

test("corridor oracle requires observed native gap and card entry while every sampled card retains its owner", () => {
	const warm = validWarmHoverTrace();
	const target = warm.targets[2];
	const moves = [
		{ owner: null, cardOwner: null, x: 269, y: 210 },
		{ owner: null, cardOwner: target.owner, x: 430, y: 250 },
	];
	const trace = {
		armedAt: 0,
		truncated: false,
		targets: [target],
		moves: moves.map((move, index) => ({ ...move, at: [10, 50][index], trusted: true })),
		frames: [1, 30, 70].map((at) => ({ at, owner: null, cards: structuredClone(warm.frames[5].cards) })),
	};
	const expected = { initialOwner: target.owner, moves };
	assertSidebarHoverProtection(trace, expected);
	const missing = structuredClone(trace);
	missing.frames[1].cards = [];
	assert.throws(() => assertSidebarHoverProtection(missing, expected));
	const teleported = structuredClone(trace);
	teleported.moves.shift();
	assert.throws(() => assertSidebarHoverProtection(teleported, expected));
});

test("renderer sampler records every frame and actual input ownership without settling, then releases resources", async () => {
	const targets = validWarmHoverTrace().targets;
	let now = 0;
	let serial = 0;
	let cards = [];
	let listener;
	const callbacks = new Map();
	const timers = new Map();
	const title = {
		textContent: targets[0].title,
		scrollWidth: 250,
		clientWidth: 250,
		scrollHeight: 30,
		clientHeight: 30,
		getBoundingClientRect: () => ({ x: 275, y: 205, right: 525, bottom: 235 }),
	};
	const card = {
		parentElement: null,
		owner: targets[0].owner,
		opacity: "1",
		getAttribute: () => card.owner,
		getBoundingClientRect: () => ({ x: 270, y: 200, width: 320, height: 100, right: 590, bottom: 300 }),
		querySelector: () => title,
		querySelectorAll: (selector) => (selector === ".preview-title, .project-preview-title" ? [title] : []),
		contains: (node) => node === card,
		closest: () => null,
		getAnimations: () => [],
	};
	const document = {
		defaultView: {
			innerWidth: 1400,
			innerHeight: 872,
			performance: { now: () => now },
			getComputedStyle: (node) => ({
				display: "block",
				visibility: "visible",
				opacity: node.opacity,
				pointerEvents: "auto",
				animationName: "none",
			}),
			requestAnimationFrame: (callback) => {
				callbacks.set(++serial, callback);
				return serial;
			},
			cancelAnimationFrame: (id) => callbacks.delete(id),
			setTimeout: (callback) => {
				timers.set(++serial, callback);
				return serial;
			},
			clearTimeout: (id) => timers.delete(id),
		},
		querySelectorAll: () => cards,
		elementFromPoint: () => card,
		addEventListener: (type, callback, capture) => {
			assert.equal(type, "pointermove");
			assert.equal(capture, true);
			listener = callback;
		},
		removeEventListener: (type, callback, capture) => {
			assert.equal(type, "pointermove");
			assert.equal(callback, listener);
			assert.equal(capture, true);
			listener = undefined;
		},
	};
	const advance = (at) => {
		now = at;
		const pending = [...callbacks.values()];
		callbacks.clear();
		for (const callback of pending) callback();
	};
	const move = (index) => {
		listener({
			target: {
				closest: (selector) =>
					selector === ".sidebar-preview-row" ? { getAttribute: () => targets[index].owner } : null,
			},
			clientX: targets[index].point.x,
			clientY: targets[index].point.y,
			isTrusted: true,
		});
	};
	const sampler = startSidebarHoverTrace(document, targets);
	const cold = sampler.coldOpen();
	advance(1);
	now = 10;
	move(0);
	advance(100);
	cards = [card];
	advance(230);
	assert.equal(await cold, true);
	assert.equal(timers.size, 0);
	now = 260;
	move(1);
	card.owner = targets[1].owner;
	card.opacity = "0";
	advance(270);
	card.opacity = "1";
	cards = [card, card];
	advance(280);
	cards = [];
	advance(290);
	const trace = sampler.stop();
	assert.deepEqual(
		trace.frames.map((frame) => frame.at),
		[1, 100, 230, 270, 280, 290],
	);
	assert.deepEqual(
		trace.frames.map((frame) => frame.cards.length),
		[0, 0, 1, 1, 2, 0],
	);
	assert.equal(trace.frames[3].cards[0].visible, false);
	assert.equal(trace.frames[3].owner, targets[1].owner);
	assert.equal(trace.moves[1].at, 260);
	assert.equal(callbacks.size, 0);
	assert.equal(listener, undefined);
});

test("sidebar preview acceptance rejects clipping, coverage and incomplete title", () => {
	const valid = {
		x: 270,
		y: 200,
		width: 320,
		height: 100,
		viewportWidth: 1400,
		viewportHeight: 872,
		hit: true,
		title: true,
		contentFits: true,
	};
	assertPreviewBounds(valid);
	for (const change of [
		{ x: -1 },
		{ y: -1 },
		{ width: 0 },
		{ height: 0 },
		{ x: 1300 },
		{ y: 850 },
		{ hit: false },
		{ title: false },
		{ contentFits: false },
		{ width: NaN },
	])
		assert.throws(() => assertPreviewBounds({ ...valid, ...change }));
});

test("legacy cold-delay probe explicitly expires shared warmth after its prior card closes", async () => {
	const helper = await readFile(new URL("./gui-sidebar-hover.mjs", import.meta.url), "utf8");
	const closed = helper.indexOf('"prior preview closes"');
	const started = helper.indexOf('const hoverStart = await read("performance.now()")');
	assert.ok(closed >= 0 && started > closed);
	assert.ok(
		helper.slice(closed, started).includes("await new Promise((resolve) => setTimeout(resolve, 350))"),
		"The legacy cold assertion must wait longer than the shared 300 ms grace after observing no card",
	);
});

test("sidebar journey restores canonical fixture before existing cold pin and uses native input only", async () => {
	const flow = await readFile(new URL("./gui-flow.mjs", import.meta.url), "utf8");
	assert.ok(
		flow.indexOf("const sidebarHover = await exerciseSidebarHover") <
			flow.indexOf(
				"const conversationPin = await exerciseConversationPin(cdp, directory, scope, fixture.conversation, false)",
			),
	);
	const helper = await readFile(new URL("./gui-sidebar-hover.mjs", import.meta.url), "utf8");
	assert.ok(helper.includes("await rename(originalTitle)"));
	assert.ok(helper.includes('await filter("Active conversations")'));
	assert.ok(helper.includes("await continuity()"));
	assert.ok(helper.includes("Input.insertText"));
	assert.equal(/dispatchEvent|\.click\(|\.focus\(|localStorage\.setItem/.test(helper), false);
	for (const action of ["pin-conversation-direct", "archive-conversation-direct", "restore-conversation-direct"])
		assert.ok(helper.includes(action));
	const observer = helper.slice(
		helper.indexOf("async function sampleSidebarHover("),
		helper.indexOf("async function sampleTwoFrames("),
	);
	assert.ok(observer.indexOf("startSidebarHoverTrace.toString()") < observer.indexOf("await move()"));
	assert.ok(observer.indexOf("await writeFile") < observer.lastIndexOf("return trace"));
	const measured = helper.slice(
		helper.indexOf('"sidebar-warm-hover-frames", targets'),
		helper.indexOf("const result = assertSidebarHoverTrace(trace)"),
	);
	assert.ok(measured.includes("targets.slice(1)"));
	assert.ok(measured.includes("sampleTwoFrames(cdp)"));
	assert.equal(/await (?:until|hover|capture)\(/.test(measured), false);
	assert.ok(helper.includes("if (pinned) warmHover = await exerciseWarmSidebarHover"));
	assert.ok(helper.indexOf('"sidebar-warm-pinned-source"') < helper.indexOf('"sidebar-warm-hover-frames", targets'));
	assert.ok(helper.indexOf('"sidebar-warm-recent-result"') > helper.indexOf("assertSidebarHoverTrace(trace)"));
	for (const name of ["sidebar-corridor-frames", "sidebar-card-focus-frames", "sidebar-row-focus-frames"])
		assert.ok(helper.includes(name));
});
