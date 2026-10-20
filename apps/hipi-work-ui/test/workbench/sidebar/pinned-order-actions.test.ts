import assert from "node:assert/strict";
import type { Params, PinnedConversation, PinnedConversationPage, Scope } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { pinnedOrderActions } from "../../../src/features/workbench/sidebar/pinned-order-actions.ts";

function pin(workspaceId: string, conversationId: string): PinnedConversation {
	return {
		conversation: { workspaceId, conversationId, title: conversationId, revision: 1, archivedAt: null, createdAt: 1 },
		presentation: { workspaceId, conversationId, pinned: true, revision: 1 },
	};
}
function fixture(successor: Scope | null = { workspaceId: "unloaded", conversationId: "next" }) {
	const items = [pin("one", "same-id"), pin("two", "same-id"), pin("three", "last")];
	const page: PinnedConversationPage = {
		items,
		orderGeneration: 7,
		nextCursor: successor ? "cursor" : null,
		nextPinnedScope: successor,
	};
	const calls: Params<"reorderPinnedConversation">[] = [];
	return { items, page, calls, actions: pinnedOrderActions([page], items, false, (input) => calls.push(input)) };
}

test("after the last visible row uses its unloaded canonical successor, not list end", () => {
	const f = fixture();
	const first = f.actions.get("one.same-id");
	const last = f.actions.get("three.last");
	assert.ok(first && last);
	assert.equal(last.item.after, "unloaded.next");
	first.item.move(last.item.after);
	assert.deepEqual(f.calls[0]?.moved, { workspaceId: "one", conversationId: "same-id" });
	assert.deepEqual(f.calls[0]?.before, { workspaceId: "unloaded", conversationId: "next" });
	assert.equal(f.calls[0]?.expectedOrderGeneration, 7);
	assert.equal(last.down, undefined, "An unknown successor's successor is not guessed for Move down");
});

test("canonical workspace plus conversation identity prevents collisions across projects", () => {
	const f = fixture();
	f.actions.get("one.same-id")?.item.move("two.same-id");
	assert.deepEqual(f.calls[0]?.before, { workspaceId: "two", conversationId: "same-id" });
	assert.equal(f.actions.size, 3);
});

test("complete-list end is explicit null and keyboard Down uses the same canonical anchor", () => {
	const f = fixture(null);
	const second = f.actions.get("two.same-id");
	assert.ok(second);
	assert.equal(second.down, null);
	assert.equal(second.up, "one.same-id");
	second.item.move(second.down);
	assert.equal(f.calls[0]?.before, null);
	assert.equal(f.actions.get("one.same-id")?.up, undefined);
});

test("unknown target identities never dispatch a placement", () => {
	const f = fixture();
	f.actions.get("one.same-id")?.item.move("foreign.missing");
	assert.deepEqual(f.calls, []);
});

test.each(["pending", "mixed", "missing"] as const)(
	"unsafe %s page state disables pointer and menu mutations",
	(mode) => {
		const f = fixture();
		const pages = mode === "missing" ? [] : mode === "mixed" ? [f.page, { ...f.page, orderGeneration: 8 }] : [f.page];
		const actions = pinnedOrderActions(pages, f.items, mode === "pending", (input) => f.calls.push(input));
		for (const action of actions.values()) {
			assert.equal(action.item.disabled, true);
			action.item.move(null);
		}
		assert.deepEqual(f.calls, []);
	},
);

test("captured callbacks retain the original generation rather than silently adopting a later order", () => {
	const f = fixture();
	const action = f.actions.get("one.same-id");
	assert.ok(action);
	f.page.orderGeneration = 99;
	action.item.move("two.same-id");
	assert.equal(f.calls[0]?.expectedOrderGeneration, 7);
});
