import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ConversationPreviewInteraction,
	type PreviewMode,
} from "../src/features/workbench/conversation-preview-interaction.ts";

test("hover waits and leaving before the delay never opens the preview", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const modes: PreviewMode[] = [];
	const preview = new ConversationPreviewInteraction((mode) => modes.push(mode));
	preview.enter();
	context.mock.timers.tick(349);
	assert.equal(preview.mode, "closed");
	preview.leave();
	context.mock.timers.tick(1000);
	assert.deepEqual(modes, []);
});

test("hover can cross the gap into the card and closes after leaving it", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(350);
	assert.equal(preview.mode, "hover");
	preview.leave();
	context.mock.timers.tick(199);
	preview.cancelPending();
	context.mock.timers.tick(1000);
	assert.equal(preview.mode, "hover");
	preview.leave();
	context.mock.timers.tick(200);
	assert.equal(preview.mode, "closed");
});

test("click and keyboard activation pin an existing preview rather than dismiss it", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(350);
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
	context.mock.timers.tick(350);
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
	context.mock.timers.tick(350);
	preview.leave();
	preview.cancelPending();
	context.mock.timers.tick(1000);
	assert.deepEqual(modes, ["hover"]);
});

test("Tab focus entering a hover card owns focus return after Escape dismissal", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(350);
	preview.pin();
	preview.close();
	assert.equal(preview.consumeFocusReturn(), true);
	assert.equal(preview.consumeFocusReturn(), false);
});

test("hover dismissal never steals focus and navigation yields focus to its destination", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = new ConversationPreviewInteraction(() => {});
	preview.enter();
	context.mock.timers.tick(350);
	preview.leave();
	context.mock.timers.tick(200);
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
	context.mock.timers.tick(350);
	assert.equal(preview.mode, "hover");
});
