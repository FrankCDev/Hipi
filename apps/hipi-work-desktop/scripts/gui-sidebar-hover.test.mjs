import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertPreviewBounds } from "./gui-sidebar-hover.mjs";

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
});
