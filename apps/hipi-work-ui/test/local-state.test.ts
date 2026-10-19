import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReceiptView, Submit } from "@hipi/work-runtime/contracts";
import { LocalState, reconciledDraft } from "../src/features/workbench/local-state.ts";

const input: Submit = {
	workspaceId: "workspace",
	conversationId: "conversation",
	requestId: "request",
	text: "original goal",
};
const receipt: ReceiptView = {
	workspaceId: "workspace",
	conversationId: "conversation",
	requestId: "request",
	receiptId: "receipt",
	state: "accepted",
};

test("separate connections cannot restore each other's navigation, drafts or requests, even with identical IDs", () => {
	const first = new LocalState();
	first.navigation = { workspaces: [{ workspaceId: "workspace", name: "Private A" }], conversations: [] };
	first.write("draft.workspace.conversation", "Private A draft");
	first.remember("workspace.conversation", input);
	const second = new LocalState();
	assert.deepEqual(second.navigation, { workspaces: [], conversations: [] });
	assert.equal(second.read("draft.workspace.conversation"), null);
	assert.equal(second.pending("workspace.conversation"), null);
	assert.equal(first.hasUnsavedWork(), true);
	assert.equal(second.hasUnsavedWork(), false);
});

test("same-connection pending retry retains the original ID and exact payload despite later draft edits", () => {
	const local = new LocalState();
	local.remember("scope", input);
	local.write("draft.scope", "edited after ambiguous disconnect");
	assert.deepEqual(local.pending("scope"), input);
	assert.equal(local.hasUnsavedWork(), true);
	local.confirmed(input.requestId);
	assert.equal(local.hasUnsavedWork(), true);
	local.write("draft.scope", "");
	assert.equal(local.hasUnsavedWork(), false);
	const copy = local.pending("scope");
	assert(copy);
	copy.text = "accidental caller mutation";
	assert.deepEqual(local.pending("scope"), input);
});

test("a null receipt preserves the submitted draft; confirmed acceptance clears only that unchanged draft", () => {
	assert.equal(reconciledDraft(input.text, input, null), input.text);
	assert.equal(reconciledDraft(input.text, input, receipt), "");
	assert.equal(reconciledDraft("later edit", input, receipt), "later edit");
});

test("unknown execution or mismatched request/scope cannot clear user input", () => {
	assert.equal(reconciledDraft(input.text, input, { ...receipt, state: "reconciliation_required" }), input.text);
	assert.equal(reconciledDraft(input.text, input, { ...receipt, requestId: "other" }), input.text);
	assert.equal(reconciledDraft(input.text, input, { ...receipt, workspaceId: "other" }), input.text);
	assert.equal(reconciledDraft(input.text, input, { ...receipt, conversationId: "other" }), input.text);
});

test("connection-owned reconciliation marker survives pane remount and preserves a newly authored identical draft", () => {
	const local = new LocalState();
	local.remember("scope", input);
	local.confirmed(receipt.requestId);
	local.write("draft.scope", input.text);
	const reopened = local.pending("scope");
	assert(reopened);
	const reconciledRequest = local.isConfirmed(reopened.requestId) ? reopened.requestId : "";
	assert.equal(reconciledRequest, receipt.requestId);
	assert.equal(local.read("draft.scope"), input.text);
	local.remember("scope", { ...input, requestId: "next-request" });
	assert.equal(local.isConfirmed("next-request"), false);
	assert.equal(new LocalState().isConfirmed(receipt.requestId), false);
});
