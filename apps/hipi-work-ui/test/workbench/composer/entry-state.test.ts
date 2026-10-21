import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation } from "@hipi/work-runtime/contracts";
import { conversationEntryState, projectHomeState } from "../../../src/features/workbench/composer/entry-state.ts";

const current: Conversation = {
	workspaceId: "workspace",
	conversationId: "chat",
	title: "Chat",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
test("selected conversation loading/error never turns into an editable new-chat route", () => {
	const scope = { workspaceId: "workspace", conversationId: "chat" };
	assert.equal(conversationEntryState(scope, undefined), "pending");
	assert.equal(conversationEntryState(scope, current), "ready");
	assert.equal(conversationEntryState(scope, { ...current, conversationId: "old-chat" }), "pending");
	assert.equal(conversationEntryState(scope, { ...current, workspaceId: "old-workspace" }), "pending");
	assert.equal(conversationEntryState(scope, undefined), "pending");
});
test("only explicit home intent opens a draft; metadata remaining in cache does not override it", () => {
	assert.equal(conversationEntryState({ workspaceId: "workspace", conversationId: "" }, current), "home");
	assert.equal(conversationEntryState({ workspaceId: "", conversationId: "" }, undefined), "home");
});

test("project metadata loading, failure and stale identity never become intentional projectless home", () => {
	assert.equal(projectHomeState("selected", undefined, false), "pending");
	assert.equal(projectHomeState("selected", undefined, true), "error");
	assert.equal(projectHomeState("selected", { projectId: "previous" }, false), "pending");
	assert.equal(projectHomeState("selected", { projectId: "selected" }, true), "error");
	assert.equal(projectHomeState("selected", { projectId: "selected" }, false), "ready");
	assert.equal(projectHomeState(undefined, undefined, false), "pending");
	assert.equal(projectHomeState(null, undefined, false), "projectless");
});
