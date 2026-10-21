import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { openRecentConversation, recentTargetState, revealRecentConversation } from "./new-chat-navigation.mjs";

const scope = { workspaceId: "chats", conversationId: "exact-id" };
const state = (overrides = {}) => ({
	expanded: true,
	matches: 0,
	mounted: [],
	point: null,
	scrollTop: 0,
	maxScroll: 265,
	height: 725,
	wheelPoint: { x: 100, y: 400 },
	...overrides,
});

function renderer(states) {
	const inputs = [];
	const evaluations = [];
	return {
		inputs,
		evaluations,
		async request(method, params) {
			if (method === "Input.dispatchMouseEvent") {
				inputs.push(params);
				return {};
			}
			assert.equal(method, "Runtime.evaluate");
			evaluations.push(params.expression);
			if (params.expression.startsWith("(function recentTargetState")) {
				assert.ok(states.length, "Unexpected extra DOM observation");
				return { result: { value: states.shift() } };
			}
			return { result: { value: true } };
		},
	};
}

test("read-only target observer rejects duplicate identities and clipped mounted targets", () => {
	const viewport = {
		clientTop: 0,
		clientLeft: 0,
		clientHeight: 100,
		clientWidth: 200,
		scrollTop: 0,
		scrollHeight: 400,
		getBoundingClientRect: () => ({ top: 20, left: 0 }),
	};
	let y = 150;
	const row = {
		dataset: scope,
		isConnected: true,
		disabled: false,
		getBoundingClientRect: () => ({ x: 10, y, width: 100, height: 30 }),
		contains: (node) => node === row,
	};
	let rows = [row];
	const document = {
		querySelector: (selector) => (selector === ".navigation-list" ? viewport : { getAttribute: () => "true" }),
		querySelectorAll: () => rows,
		elementFromPoint: () => row,
	};
	assert.equal(recentTargetState(document, scope).point, null);
	y = 40;
	assert.deepEqual(recentTargetState(document, scope).point, { x: 60, y: 55 });
	assert.equal(recentTargetState(document, { ...scope, workspaceId: "other" }).matches, 0);
	rows = [row, row];
	assert.equal(recentTargetState(document, scope).matches, 2);
	assert.equal(recentTargetState(document, scope).point, null);
});

test("unmounted exact target is revealed by native wheel before native click", async () => {
	const point = { x: 50, y: 600 };
	const cdp = renderer([state(), state({ scrollTop: 265, matches: 1, point })]);
	const evidence = [];
	await openRecentConversation(cdp, scope, evidence);
	assert.deepEqual(
		cdp.inputs.map((input) => input.type),
		["mouseMoved", "mouseWheel", "mousePressed", "mouseReleased"],
	);
	assert.ok(cdp.inputs[1].deltaY > 0);
	assert.deepEqual(cdp.inputs[2], { type: "mousePressed", ...point, button: "left", clickCount: 1 });
	assert.equal(evidence[0].observations[0].matches, 0);
	assert.equal(evidence[0].observations[1].matches, 1);
	assert.match(cdp.evaluations.at(-1), /selected.length===1/);
	assert.match(cdp.evaluations.at(-1), /dataset.sidebarLocation==='recent'/);
});

test("revealing a target above the viewport scrolls upward without selecting it", async () => {
	const point = { x: 50, y: 100 };
	const cdp = renderer([state({ scrollTop: 265 }), state({ matches: 1, point })]);
	assert.deepEqual(await revealRecentConversation(cdp, scope, []), point);
	assert.ok(cdp.inputs[1].deltaY < 0);
	assert.deepEqual(
		cdp.inputs.map((input) => input.type),
		["mouseMoved", "mouseWheel"],
	);
});

test("missing target after full sweep, duplicate owner and collapsed Recent fail without substitute selection", async () => {
	for (const states of [[state(), state({ scrollTop: 265 })], [state({ matches: 2 })], [state({ expanded: false })]]) {
		const cdp = renderer(states);
		await assert.rejects(openRecentConversation(cdp, scope, []));
		assert.ok(cdp.inputs.every((input) => !["mousePressed", "mouseReleased"].includes(input.type)));
	}
});

test("native reveal cannot mutate scroll, selection, focus or fabricate DOM owners", async () => {
	const source = await readFile(new URL("./new-chat-navigation.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(
		source,
		/scrollIntoView|scrollTo\(|scrollTop\s*=|\.focus\(|\.click\(|\.value\s*=|dispatchEvent|cloneNode|createElement/,
	);
	assert.match(source, /type: "mouseWheel"/);
});
