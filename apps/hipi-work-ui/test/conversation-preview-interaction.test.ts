import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ConversationPreviewInteraction,
	inPreviewCorridor,
	type PreviewMode,
} from "../src/features/workbench/conversation-preview-interaction.ts";

test("hover waits and leaving before the delay never opens the preview", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const modes: PreviewMode[] = [];
	const preview = new ConversationPreviewInteraction((mode) => modes.push(mode));
	preview.enter();
	context.mock.timers.tick(199);
	assert.equal(preview.mode, "closed");
	preview.leave();
	context.mock.timers.tick(1000);
	assert.deepEqual(modes, []);
});

test("hover can cross the gap into the card and closes after leaving it", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(200);
	assert.equal(preview.mode, "hover");
	preview.leave();
	context.mock.timers.tick(99);
	preview.cancelPending();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "hover");
	preview.leave();
	context.mock.timers.tick(100);
	assert.equal(preview.mode, "closed");
});

test("click and keyboard activation pin an existing preview rather than dismiss it", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(200);
	preview.activate();
	preview.leave();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "pinned");
	preview.activate();
	assert.equal(preview.mode, "closed");
	preview.activate();
	assert.equal(preview.mode, "pinned");
});

test("dismissal cancels pending opens and focus keeps card controls available", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	preview.close();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "closed");
	preview.enter();
	context.mock.timers.tick(200);
	preview.leave();
	preview.pin();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "pinned");
	preview.close();
	assert.equal(preview.mode, "closed");
});

test("unmount cleanup releases either timer and Strict Mode can re-enter afterwards", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const modes: PreviewMode[] = [];
	const preview = new ConversationPreviewInteraction((mode) => modes.push(mode));
	preview.enter();
	preview.cancelPending();
	context.mock.timers.tick(1000);
	assert.deepEqual(modes, []);
	preview.enter();
	context.mock.timers.tick(200);
	preview.leave();
	preview.cancelPending();
	context.mock.timers.tick(1000);
	assert.deepEqual(modes, ["hover"]);
});

test("Tab focus entering a hover card owns focus return after Escape dismissal", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(200);
	preview.pin();
	preview.close();
	assert.equal(preview.consumeFocusReturn(), true);
	assert.equal(preview.consumeFocusReturn(), false);
});

test("hover dismissal never steals focus and navigation yields focus to its destination", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(200);
	preview.leave();
	context.mock.timers.tick(100);
	assert.equal(preview.consumeFocusReturn(), false);
	preview.activate();
	preview.close("navigate");
	assert.equal(preview.consumeFocusReturn(), false);
	preview.activate();
	preview.close();
	assert.equal(preview.consumeFocusReturn(), true);
});

test("the more menu cancels a pending hover, and its preview item pins with one focus return", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	preview.close("navigate");
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "closed");
	assert.equal(preview.consumeFocusReturn(), false);
	preview.activate();
	preview.leave();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "pinned");
	preview.close();
	assert.equal(preview.consumeFocusReturn(), true);
	assert.equal(preview.consumeFocusReturn(), false);
});

test("an open menu continuously excludes hover, focus pinning and preview activation", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	preview.setOverlayOpen("menu", true);
	preview.enter();
	preview.pin();
	preview.activate();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "closed");
	assert.equal(preview.consumeFocusReturn(), false);
	preview.setOverlayOpen("menu", false);
	preview.activate();
	assert.equal(preview.mode, "pinned");
});

test("menu closure cannot release a dialog owner during rename or archive handoff", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.activate();
	preview.setOverlayOpen("menu", true);
	preview.setOverlayOpen("dialog", true);
	preview.setOverlayOpen("menu", false);
	preview.enter();
	preview.pin();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "closed");
	assert.equal(preview.consumeFocusReturn(), false, "the dialog owns focus, not the previous pinned preview");
	preview.setOverlayOpen("dialog", false);
	preview.enter();
	context.mock.timers.tick(200);
	assert.equal(preview.mode, "hover");
});

test("keyboard focus opens immediately and opening another card retires only the earlier preview", () => {
	const first = new ConversationPreviewInteraction(() => {});
	const second = new ConversationPreviewInteraction(() => {});
	first.enter(true);
	assert.equal(first.mode, "hover");
	second.enter(true);
	assert.equal(first.mode, "closed");
	assert.equal(second.mode, "hover");
	first.release();
	assert.equal(second.mode, "hover");
	second.release();
});

test("the pointer corridor admits diagonal travel in either placement but not motion away from the card", () => {
	const right = { left: 280, right: 600, top: 40, bottom: 220 };
	const origin = { x: 260, y: 100 };
	assert.equal(inPreviewCorridor({ x: 270, y: 70 }, origin, right), true);
	assert.equal(inPreviewCorridor({ x: 290, y: 200 }, origin, right), true);
	assert.equal(inPreviewCorridor({ x: 265, y: 250 }, origin, right), false);
	assert.equal(inPreviewCorridor({ x: 250, y: 100 }, origin, right), false);
	const left = { left: 10, right: 240, top: 40, bottom: 220 };
	assert.equal(inPreviewCorridor({ x: 250, y: 70 }, origin, left), true);
	assert.equal(inPreviewCorridor({ x: 270, y: 100 }, origin, left), false);
});
