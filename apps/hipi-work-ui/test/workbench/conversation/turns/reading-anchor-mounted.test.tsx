// @vitest-environment jsdom
import assert from "node:assert/strict";
import { test } from "vitest";
import { ConversationReadingPositions } from "../../../../src/features/workbench/conversation/reading-position.ts";
import {
	captureMessageViewport,
	messageViewportPixel,
} from "../../../../src/features/workbench/conversation/turns/reading-anchor.ts";

test("child reading anchor preserves fractional CSS pixels across turn reparenting and zoom", () => {
	const viewport = document.createElement("div");
	document.body.append(viewport);
	Object.defineProperty(viewport, "offsetHeight", { value: 400 });
	viewport.getBoundingClientRect = () => new DOMRect(0, 10, 500, 800);
	const before = document.createElement("div"),
		message = document.createElement("div");
	before.dataset.messageId = "1";
	before.dataset.messageKey = "m1";
	message.dataset.messageId = "2";
	message.dataset.messageKey = "m2";
	before.getBoundingClientRect = () => new DOMRect(0, -100, 500, 50);
	message.getBoundingClientRect = () => new DOMRect(0, -15.5, 500, 120);
	viewport.append(before, message);
	assert.deepEqual(captureMessageViewport(viewport), { key: "m2", pixel: -12.75 });
	const turn = document.createElement("div");
	viewport.append(turn);
	turn.append(message);
	assert.equal(messageViewportPixel(viewport, "m2"), -12.75);
	const positions = new ConversationReadingPositions();
	positions.save(
		{ workspaceId: "w", conversationId: "c" },
		{ key: "turn:2", messageKey: "m2", pixel: -12.75, following: false },
		[],
	);
	assert.equal(positions.read({ workspaceId: "w", conversationId: "c" })?.messageKey, "m2");
	message.remove();
	assert.equal(messageViewportPixel(viewport, "m2"), undefined);
	viewport.remove();
});
