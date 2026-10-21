import assert from "node:assert/strict";
import { test } from "vitest";
import type { BrowserStorage } from "../../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { createNavigation } from "../../../src/features/workbench/navigation/state.ts";

function preferences(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const writes: [string, string][] = [];
	return {
		values,
		writes,
		read: (key: string) => values.get(key) ?? null,
		write(key: string, value: string) {
			writes.push([key, value]);
			values.set(key, value);
			return true;
		},
	};
}

test("restoration distinguishes unresolved legacy projects from explicitly projectless and known destinations", () => {
	for (const [saved, projectId] of [
		[{}, null],
		[{ workspace: "legacy" }, undefined],
		[{ workspace: "home", project: "" }, null],
		[{ workspace: "home", project: "logical" }, "logical"],
	] as const) {
		const persisted = preferences(saved);
		const navigation = createNavigation(persisted);
		assert.equal(navigation.store.getState().projectId, projectId);
		assert.equal(navigation.store.getState().sidebarLocation, null);
		assert.equal(navigation.store.getState().newChatLookup, null);
		assert.deepEqual(persisted.writes, []);
	}
});

test("home transition publishes one coherent tuple after its complete persisted selection", () => {
	const persisted = preferences({ workspace: "before", conversation: "task" });
	const navigation = createNavigation(persisted);
	let count = 0;
	const initial = navigation.store.getState();
	navigation.store.subscribe((state, previous) => {
		count++;
		assert.equal(previous, initial);
		assert.deepEqual(state, {
			scope: { workspaceId: "physical", conversationId: "" },
			projectId: "logical",
			sidebarLocation: null,
			revision: 1,
			newChatLookup: null,
		});
		assert.equal(persisted.read("workspace"), state.scope.workspaceId);
		assert.equal(persisted.read("conversation"), state.scope.conversationId);
		assert.equal(persisted.read("project"), state.projectId);
	});
	navigation.selectHome("physical", "logical");
	assert.equal(count, 1);
	assert.equal(navigation.store.getInitialState(), initial);
});

test("same conversation alias changes only presentation intent and preserves route identity without persistence", () => {
	const persisted = preferences({ workspace: "home", conversation: "task", project: "logical" });
	const navigation = createNavigation(persisted);
	const initial = navigation.store.getState();
	const alias = { kind: "workspace", workspaceId: "home" } as const;
	assert.equal(navigation.selectConversation(initial.scope, alias), "alias");
	const after = navigation.store.getState();
	assert.equal(after.scope, initial.scope);
	assert.equal(after.projectId, "logical");
	assert.equal(after.revision, 1);
	assert.deepEqual(after.sidebarLocation, alias);
	assert.notEqual(after.sidebarLocation, alias);
	assert.deepEqual(persisted.writes, []);
	navigation.clearSidebarLocation();
	assert.equal(navigation.store.getState().scope, initial.scope);
	assert.equal(navigation.store.getState().revision, 1);
	assert.equal(navigation.store.getState().sidebarLocation, null);
});

test("explicit non-sidebar selection resets alias and persists only canonical IDs", () => {
	const persisted = preferences();
	const navigation = createNavigation(persisted);
	const item = { workspaceId: "home", conversationId: "task", title: "Never stored here" };
	assert.equal(navigation.selectConversation(item, { kind: "recent" }), "route");
	const route = navigation.store.getState().scope;
	assert.deepEqual(route, { workspaceId: "home", conversationId: "task" });
	assert.equal(navigation.selectConversation(item, null), "route");
	assert.notEqual(navigation.store.getState().scope, route);
	assert.equal(navigation.store.getState().sidebarLocation, null);
	assert.equal(navigation.store.getState().projectId, null);
	assert.equal(navigation.store.getState().revision, 2);
	item.workspaceId = "mutated";
	assert.equal(navigation.store.getState().scope.workspaceId, "home");
	assert.equal(persisted.read("project"), "");
});

test("repeated new-chat intents and intervening navigation retire stale failure publication", () => {
	const navigation = createNavigation(preferences({ workspace: "home", conversation: "task" }));
	const scope = navigation.store.getState().scope;
	const first = navigation.beginNewChat();
	const second = navigation.beginNewChat();
	assert.equal(navigation.store.getState().scope, scope);
	navigation.failNewChat(first);
	assert.deepEqual(navigation.store.getState().newChatLookup, { revision: second, failed: false });
	navigation.failNewChat(second);
	assert.deepEqual(navigation.store.getState().newChatLookup, { revision: second, failed: true });
	navigation.selectHome("other", "other-project");
	navigation.failNewChat(second);
	assert.equal(navigation.store.getState().newChatLookup, null);
	assert.equal(navigation.store.getState().scope.workspaceId, "other");
});

test("legacy project reconciliation cannot replace a different route or an already known project", () => {
	const persisted = preferences({ workspace: "legacy" });
	const navigation = createNavigation(persisted);
	navigation.resolveProject("wrong", "wrong-project");
	assert.equal(navigation.store.getState().projectId, undefined);
	navigation.resolveProject("legacy", "resolved");
	assert.equal(navigation.store.getState().projectId, "resolved");
	assert.equal(navigation.store.getState().revision, 0);
	navigation.resolveProject("legacy", "stale");
	assert.equal(navigation.store.getState().projectId, "resolved");
	navigation.selectConversation({ workspaceId: "legacy", conversationId: "task" }, null);
	navigation.resolveProject("legacy", "stale");
	assert.equal(navigation.store.getState().projectId, null);
	assert.equal(persisted.read("project"), "");
});

test("connection instances isolate snapshots, actions and subscription cleanup", () => {
	const first = createNavigation(preferences());
	const second = createNavigation(preferences());
	const initial = second.store.getState();
	let notifications = 0;
	const unsubscribe = second.store.subscribe(() => notifications++);
	first.selectHome("first", "first-project");
	assert.equal(second.store.getState(), initial);
	assert.equal(notifications, 0);
	second.selectHome("second", null);
	assert.equal(notifications, 1);
	unsubscribe();
	second.beginNewChat();
	assert.equal(notifications, 1);
	assert.equal(first.store.getState().scope.workspaceId, "first");
});

test("restoration uses the existing durable decoder and never imports persisted alias or malformed IDs", () => {
	const values = new Map<string, string>();
	const storage: BrowserStorage = {
		get length() {
			return values.size;
		},
		key: (index) => [...values.keys()][index] ?? null,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
	};
	for (const key of ["workspace", "conversation", "project", "sidebar.selection"]) {
		storage.setItem(
			`hipi.work.local.v1.store.value.${key}`,
			JSON.stringify({
				version: 1,
				storeId: "store",
				kind: "value",
				key,
				value: "../invalid/path",
			}),
		);
	}
	const navigation = createNavigation(new LocalState("store", storage));
	assert.deepEqual(navigation.store.getState().scope, { workspaceId: "", conversationId: "" });
	assert.equal(navigation.store.getState().projectId, null);
	assert.equal(navigation.store.getState().sidebarLocation, null);
	navigation.selectHome("current", "logical");
	const current = navigation.store.getState();
	storage.setItem("hipi.work.local.v1.store.value.project", "malformed late record");
	assert.equal(navigation.store.getState(), current);
});
