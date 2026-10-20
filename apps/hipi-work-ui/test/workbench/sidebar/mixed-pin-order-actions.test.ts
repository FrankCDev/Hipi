import assert from "node:assert/strict";
import type { Params, SidebarPinItem, SidebarPinPage } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import {
	mixedPinKey,
	mixedPinOrderActions,
	pinKey,
} from "../../../src/features/workbench/sidebar/mixed-pin-order-actions.ts";

const project: SidebarPinItem = {
	kind: "project",
	project: { projectId: "same", name: "Project", revision: 1, homeWorkspaceId: "adapter" },
	presentation: { projectId: "same", pinned: true, revision: 1 },
};
const chat: SidebarPinItem = {
	kind: "conversation",
	conversation: {
		workspaceId: "same",
		conversationId: "chat",
		title: "Chat",
		revision: 1,
		archivedAt: null,
		createdAt: 1,
	},
	presentation: { workspaceId: "same", conversationId: "chat", revision: 1, pinned: true },
	membership: { workspaceId: "same", conversationId: "chat", projectId: "same", revision: 1 },
};
const page: SidebarPinPage = {
	items: [project, chat],
	nextCursor: "next",
	nextPinKey: { kind: "project", projectId: "unloaded" },
	orderRevision: 8,
};
test("mixed loaded-edge insertion targets verified unloaded project instead of absolute end", () => {
	const calls: Params<"reorderSidebarPin">[] = [];
	const actions = mixedPinOrderActions([page], page.items, false, (input) => calls.push(input));
	const first = actions.get(mixedPinKey(pinKey(project)));
	assert.ok(first);
	assert.equal(first.down, mixedPinKey(page.nextPinKey ?? { kind: "project", projectId: "missing" }));
	assert.ok(first.down);
	first.item.move(first.down);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.moved, { kind: "project", projectId: "same" });
	assert.deepEqual(calls[0]?.before, page.nextPinKey);
	assert.equal(calls[0]?.expectedOrderRevision, 8);
	assert.equal(actions.get(mixedPinKey(pinKey(chat)))?.down, undefined);
});
test("same-text logical and canonical identifiers remain distinct, unknown/self anchors do not dispatch", () => {
	const calls: Params<"reorderSidebarPin">[] = [];
	const actions = mixedPinOrderActions([page], page.items, false, (input) => calls.push(input));
	assert.equal(actions.size, 2);
	const first = actions.get(mixedPinKey(pinKey(project)));
	assert.ok(first);
	first.item.move("same");
	first.item.move(first.item.id);
	assert.equal(calls.length, 0);
	first.item.move(mixedPinKey(pinKey(chat)));
	assert.deepEqual(calls[0]?.before, { kind: "conversation", workspaceId: "same", conversationId: "chat" });
});
test("mixed stale pages and blocked state disable every move without rebasing", () => {
	for (const pages of [[page, { ...page, orderRevision: 9 }], [page]]) {
		const calls: unknown[] = [];
		const actions = mixedPinOrderActions(pages, page.items, pages.length === 1, (input) => calls.push(input));
		for (const action of actions.values()) {
			assert.equal(action.item.disabled, true);
			action.item.move(null);
		}
		assert.equal(calls.length, 0);
	}
});
test("verified terminal page permits absolute mixed-end move", () => {
	const calls: Params<"reorderSidebarPin">[] = [];
	const actions = mixedPinOrderActions([{ ...page, nextCursor: null, nextPinKey: null }], page.items, false, (input) =>
		calls.push(input),
	);
	const first = actions.get(mixedPinKey(pinKey(project)));
	assert.ok(first);
	assert.equal(first.down, null);
	first.item.move(first.down);
	assert.equal(calls[0]?.before, null);
});
