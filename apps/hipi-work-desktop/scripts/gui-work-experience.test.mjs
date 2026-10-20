import assert from "node:assert/strict";
import test from "node:test";
import {
	assertWorkExperienceGeometry,
	layoutCases,
	nativeEditorKey,
	workExperienceGeometry,
} from "./gui-work-experience.mjs";

function geometry() {
	const rect = (x, y, width, height) => ({ x, y, width, height, hit: true, disabled: false });
	return {
		width: 1024,
		height: 900,
		scrollWidth: 1024,
		regions: {
			toolbar: rect(260, 0, 764, 64),
			conversation: rect(260, 64, 764, 836),
			composer: rect(280, 700, 724, 160),
			input: rect(296, 716, 692, 80),
			submit: rect(948, 808, 40, 36),
			model: rect(296, 808, 100, 36),
			permissions: rect(410, 808, 160, 36),
			context: rect(580, 808, 100, 36),
			tools: rect(690, 808, 100, 36),
		},
	};
}

test("matrix covers every requested width, language and resolved theme without duplicates", () => {
	assert.equal(layoutCases.length, 16);
	assert.equal(new Set(layoutCases.map((item) => JSON.stringify(item))).size, 16);
	for (const width of [1440, 1280, 1024, 640])
		for (const locale of ["en", "zh-CN"])
			for (const theme of ["light", "dark"])
				assert.ok(layoutCases.some((item) => item.width === width && item.locale === locale && item.theme === theme));
});

test("geometry rejects missing, covered and offscreen key controls rather than accepting screenshots alone", () => {
	assert.doesNotThrow(() => assertWorkExperienceGeometry(geometry()));
	for (const name of ["input", "submit", "model", "permissions", "context", "tools"]) {
		const hidden = geometry();
		hidden.regions[name] = null;
		assert.throws(() => assertWorkExperienceGeometry(hidden), /missing or collapsed/);
		const covered = geometry();
		covered.regions[name].hit = false;
		assert.throws(() => assertWorkExperienceGeometry(covered), /covered/);
		const disabled = geometry();
		disabled.regions[name].disabled = true;
		assert.throws(() => assertWorkExperienceGeometry(disabled), /must be actionable/);
		const offscreen = geometry();
		offscreen.regions[name].x = 1024;
		assert.throws(() => assertWorkExperienceGeometry(offscreen), /escapes the visible viewport/);
	}
});

test("geometry rejects document overflow and composer overlap even with positive control dimensions", () => {
	const overflow = geometry();
	overflow.scrollWidth = 1050;
	assert.throws(() => assertWorkExperienceGeometry(overflow), /overflows horizontally/);
	const overlap = geometry();
	overlap.regions.input.height = 120;
	assert.throws(() => assertWorkExperienceGeometry(overlap), /controls overlap editable text/);
	const escaped = geometry();
	escaped.regions.composer.height = 100;
	assert.throws(() => assertWorkExperienceGeometry(escaped), /Send control escapes composer/);
});

test("geometry collector requires unique semantic targets and observes actual center hit testing", () => {
	const node = {
		getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 30 }),
		contains: (value) => value === node,
	};
	let duplicate = false;
	let covered = false;
	const document = {
		documentElement: { scrollWidth: 1024 },
		querySelectorAll: () => (duplicate ? [node, node] : [node]),
		elementFromPoint: (x, y) => {
			assert.equal(x, 60);
			assert.equal(y, 35);
			return covered ? {} : node;
		},
	};
	assert.equal(workExperienceGeometry(document, { width: 1024, height: 900 }).regions.input.hit, true);
	covered = true;
	assert.equal(workExperienceGeometry(document, { width: 1024, height: 900 }).regions.input.hit, false);
	duplicate = true;
	assert.equal(workExperienceGeometry(document, { width: 1024, height: 900 }).regions.input, null);
});

test("editor harness sends native Shift+Enter and composition key229 without JavaScript-dispatched UI events", async () => {
	const calls = [];
	const cdp = {
		request: async (method, params) => {
			calls.push({ method, ...params });
		},
	};
	await nativeEditorKey(cdp, "Enter", { modifiers: 8 });
	assert.deepEqual(
		calls.map((item) => [item.method, item.type, item.modifiers, item.windowsVirtualKeyCode]),
		[
			["Input.dispatchKeyEvent", "keyDown", 8, 13],
			["Input.dispatchKeyEvent", "keyUp", 8, 13],
		],
	);
	calls.length = 0;
	await nativeEditorKey(cdp, "Enter", { composing: true });
	assert.ok(calls.every((item) => item.windowsVirtualKeyCode === 229 && !("text" in item)));
	await assert.rejects(nativeEditorKey(cdp, "Delete"), /Unsupported work-experience key/);
	assert.equal(calls.length, 2);
});

test("Darwin cleanup supplies Cocoa editing commands on keydown only without changing other platforms", async () => {
	for (const platform of ["darwin", "linux", "win32"]) {
		const calls = [];
		const cdp = { request: async (_method, params) => calls.push(params) };
		await nativeEditorKey(cdp, "a", { platform, modifiers: platform === "darwin" ? 4 : 2 });
		await nativeEditorKey(cdp, "Backspace", { platform });
		assert.deepEqual(
			calls.map((item) => item.commands),
			platform === "darwin"
				? [["selectAll"], undefined, ["deleteBackward"], undefined]
				: [undefined, undefined, undefined, undefined],
		);
		assert.ok(
			calls.filter((item) => item.type === "keyUp").every((item) => !("commands" in item) && !("text" in item)),
		);
	}
});

test("native Enter activates focused buttons with carriage return on keydown only", async () => {
	const calls = [];
	const cdp = { request: async (method, params) => calls.push({ method, ...params }) };
	await nativeEditorKey(cdp, "Enter");
	assert.deepEqual(calls, [
		{
			method: "Input.dispatchKeyEvent",
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			modifiers: 0,
			text: "\r",
		},
		{
			method: "Input.dispatchKeyEvent",
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			modifiers: 0,
		},
	]);
});
