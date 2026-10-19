import assert from "node:assert/strict";
import { test } from "node:test";
import { navigateConversation } from "../src/features/workbench/conversation-navigation.ts";

function fixture(changesWorkspace: boolean) {
	const state = { selection: "old", detailsOpen: false, returnFocus: "old-trigger", draft: "unsaved" };
	let pending: (() => void) | undefined;
	let guardCalls = 0;
	const order: string[] = [];
	navigateConversation({
		changesWorkspace,
		guard: (action) => {
			guardCalls++;
			pending = action;
		},
		select: () => {
			order.push("select");
			state.selection = "target";
			state.detailsOpen = false;
			if (changesWorkspace) state.draft = "";
		},
		onSelected: () => {
			order.push("details");
			state.returnFocus = "target-trigger";
			state.detailsOpen = true;
		},
	});
	return {
		state,
		order,
		guardCalls,
		cancel: () => {
			pending = undefined;
		},
		confirm: () => {
			const action = pending;
			pending = undefined;
			action?.();
		},
	};
}

test("dirty cross-workspace Details cancellation preserves selection, draft and focus target", () => {
	const view = fixture(true);
	assert.equal(view.guardCalls, 1);
	assert.deepEqual(view.order, []);
	assert.deepEqual(view.state, { selection: "old", detailsOpen: false, returnFocus: "old-trigger", draft: "unsaved" });
	view.cancel();
	view.confirm();
	assert.deepEqual(view.order, []);
	assert.deepEqual(view.state, { selection: "old", detailsOpen: false, returnFocus: "old-trigger", draft: "unsaved" });
});

test("dirty cross-workspace Details confirmation selects before opening the target details", () => {
	const view = fixture(true);
	assert.equal(view.state.detailsOpen, false);
	view.confirm();
	assert.equal(view.guardCalls, 1);
	assert.deepEqual(view.order, ["select", "details"]);
	assert.deepEqual(view.state, { selection: "target", detailsOpen: true, returnFocus: "target-trigger", draft: "" });
});

test("same-workspace Details opens immediately without clearing the editor or adding a guard", () => {
	const view = fixture(false);
	assert.equal(view.guardCalls, 0);
	assert.deepEqual(view.order, ["select", "details"]);
	assert.deepEqual(view.state, {
		selection: "target",
		detailsOpen: true,
		returnFocus: "target-trigger",
		draft: "unsaved",
	});
});
