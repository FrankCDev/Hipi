import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ConversationPreviewInteraction } from "../../../src/features/workbench/sidebar/conversation-preview-interaction.ts";
import { SidebarPreviewCoordinator } from "../../../src/features/workbench/sidebar/preview-coordinator.ts";

test("cold hover waits 200 ms, adjacent warm handoffs are immediate and old leave cannot close the new owner", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = new SidebarPreviewCoordinator();
	const events: string[] = [];
	const a = new ConversationPreviewInteraction((mode) => events.push(`a:${mode}`), coordinator);
	const b = new ConversationPreviewInteraction((mode) => events.push(`b:${mode}`), coordinator);
	const c = new ConversationPreviewInteraction((mode) => events.push(`c:${mode}`), coordinator);
	a.enter();
	t.mock.timers.tick(199);
	a.enter();
	assert.equal(a.mode, "closed", "Pointer moves must not postpone the original deadline");
	t.mock.timers.tick(1);
	assert.equal(a.mode, "hover");
	a.leave();
	b.enter();
	assert.deepEqual(events, ["a:hover", "a:closed", "b:hover"]);
	a.leave();
	a.release();
	a.setOverlayOpen("menu", true);
	assert.equal(b.mode, "hover");
	b.leave();
	c.enter();
	t.mock.timers.tick(1000);
	assert.equal(b.mode, "closed");
	assert.equal(c.mode, "hover");
	assert.deepEqual(events.slice(-2), ["b:closed", "c:hover"]);
	coordinator.dispose();
});

test("warmth expires exactly 300 ms after the last close, but remains warm while a card is open", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = new SidebarPreviewCoordinator();
	const a = new ConversationPreviewInteraction(() => {}, coordinator);
	const b = new ConversationPreviewInteraction(() => {}, coordinator);
	a.enter(true);
	t.mock.timers.tick(1000);
	b.enter();
	assert.equal(b.mode, "hover");
	b.close();
	t.mock.timers.tick(299);
	a.enter();
	assert.equal(a.mode, "hover");
	a.close();
	t.mock.timers.tick(300);
	b.enter();
	assert.equal(b.mode, "closed");
	t.mock.timers.tick(199);
	assert.equal(b.mode, "closed");
	t.mock.timers.tick(1);
	assert.equal(b.mode, "hover");
	coordinator.dispose();
});

test("only the newest cold intent may open and an immediate action cancels older delayed work", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = new SidebarPreviewCoordinator();
	const a = new ConversationPreviewInteraction(() => {}, coordinator);
	const b = new ConversationPreviewInteraction(() => {}, coordinator);
	a.enter();
	t.mock.timers.tick(150);
	b.enter();
	t.mock.timers.tick(50);
	assert.equal(a.mode, "closed");
	assert.equal(b.mode, "closed");
	b.enter(true);
	t.mock.timers.tick(1000);
	assert.equal(a.mode, "closed");
	assert.equal(b.mode, "hover");
	coordinator.dispose();
});

test("corridor ownership blocks pointer entry until capture-phase release, then the same move can retry warm", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = new SidebarPreviewCoordinator();
	const a = new ConversationPreviewInteraction(() => {}, coordinator);
	const b = new ConversationPreviewInteraction(() => {}, coordinator);
	a.enter(true);
	a.holdCorridor(true);
	a.leave();
	b.enter(true);
	assert.equal(b.mode, "closed");
	a.close();
	b.enter();
	assert.equal(b.mode, "hover");
	a.holdCorridor(false);
	a.release();
	t.mock.timers.tick(400);
	assert.equal(b.mode, "hover");
	coordinator.dispose();
});

test("card-control focus protects the owner, ordinary row focus and unfocused pinned mode do not", () => {
	const coordinator = new SidebarPreviewCoordinator();
	let cardFocused = false;
	const a = new ConversationPreviewInteraction(
		() => {},
		coordinator,
		() => cardFocused,
	);
	const b = new ConversationPreviewInteraction(() => {}, coordinator);
	a.enter(true, true);
	b.enter();
	assert.equal(a.mode, "closed", "Row keyboard focus is not a sticky card-control lease");
	a.pin();
	cardFocused = true;
	b.enter(true);
	assert.equal(a.mode, "pinned");
	assert.equal(b.mode, "closed");
	b.enter(true, true);
	assert.equal(a.mode, "closed", "Explicit keyboard focus owns a deliberate transfer");
	assert.equal(a.consumeFocusReturn(), false);
	a.pin();
	cardFocused = false;
	b.enter();
	assert.equal(a.mode, "closed");
	assert.equal(b.mode, "hover");
	coordinator.dispose();
});

test("existing row menu and dialog sets exclude peers until both close, without a warm auto-reopen", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = new SidebarPreviewCoordinator();
	const a = new ConversationPreviewInteraction(() => {}, coordinator);
	const b = new ConversationPreviewInteraction(() => {}, coordinator);
	a.pin();
	a.setOverlayOpen("menu", true);
	a.setOverlayOpen("dialog", true);
	a.setOverlayOpen("menu", false);
	b.enter(true, true);
	b.activate();
	t.mock.timers.tick(500);
	assert.equal(a.mode, "closed");
	assert.equal(a.consumeFocusReturn(), false);
	assert.equal(b.mode, "closed");
	a.setOverlayOpen("dialog", false);
	t.mock.timers.tick(500);
	assert.equal(b.mode, "closed");
	b.enter();
	t.mock.timers.tick(199);
	assert.equal(b.mode, "closed");
	t.mock.timers.tick(1);
	assert.equal(b.mode, "hover");
	coordinator.dispose();
});

test("providers are isolated and blur/navigation/drag resets cancel pending work and restore cold timing", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const first = new SidebarPreviewCoordinator();
	const second = new SidebarPreviewCoordinator();
	const a = new ConversationPreviewInteraction(() => {}, first);
	const b = new ConversationPreviewInteraction(() => {}, second);
	a.pin();
	b.enter();
	assert.equal(a.mode, "pinned");
	assert.equal(b.mode, "closed");
	first.reset();
	assert.equal(a.consumeFocusReturn(), false);
	t.mock.timers.tick(200);
	assert.equal(b.mode, "hover");
	a.enter();
	first.setEnabled(false);
	a.enter(true, true);
	t.mock.timers.tick(1000);
	assert.equal(a.mode, "closed");
	first.setEnabled(true);
	a.enter();
	t.mock.timers.tick(199);
	assert.equal(a.mode, "closed");
	t.mock.timers.tick(1);
	assert.equal(a.mode, "hover");
	first.dispose();
	second.dispose();
});

test("unmount removes only its own blocker and Strict Mode activation can reuse a disposed coordinator", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = new SidebarPreviewCoordinator();
	const a = new ConversationPreviewInteraction(() => {}, coordinator);
	const b = new ConversationPreviewInteraction(() => {}, coordinator);
	a.setOverlayOpen("menu", true);
	b.setOverlayOpen("dialog", true);
	a.release();
	a.enter(true);
	assert.equal(a.mode, "closed");
	b.release();
	a.resume();
	a.enter(true);
	assert.equal(a.mode, "hover");
	coordinator.dispose();
	a.release();
	coordinator.setEnabled(true);
	a.resume();
	a.enter();
	t.mock.timers.tick(200);
	assert.equal(a.mode, "hover");
	coordinator.dispose();
});

test("rich sidebar cards bypass entry animation in every motion preference without changing ordinary popovers", async () => {
	const css = await readFile(new URL("../../../src/features/workbench/sidebar/layout.css", import.meta.url), "utf8");
	assert.match(
		css,
		/\[data-slot="popover-content"\]\.conversation-preview-card\[data-state="open"\]\s*\{[^}]*animation: none;/,
	);
	assert.doesNotMatch(css, /warm.*animation|animation: work-surface-enter/);
	assert.match(css, /\[data-drag-edge\]::after\s*\{[^}]*background: var\(--brand\)/);
});
