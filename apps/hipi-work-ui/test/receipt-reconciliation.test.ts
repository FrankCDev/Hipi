import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReceiptView, Submit } from "@hipi/work-runtime/contracts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { reconcileReceipt } from "../src/features/workbench/receipt-reconciliation.ts";

const pending: Submit = {
	workspaceId: "workspace",
	conversationId: "conversation",
	requestId: "request",
	text: "original goal",
};
const receipt: ReceiptView = { ...pending, receiptId: "receipt", state: "accepted" };

for (const mismatch of [
	{ requestId: "other" },
	{ workspaceId: "other" },
	{ conversationId: "other" },
	{ state: "reconciliation_required" as const },
]) {
	test(`receipt mismatch ${JSON.stringify(mismatch)} cannot confirm or clear pending work`, () => {
		const local = new LocalState();
		local.remember("scope", pending);
		local.write("draft.scope", pending.text);
		assert.equal(reconcileReceipt(local, "scope", pending.text, pending, { ...receipt, ...mismatch }), null);
		assert.equal(local.isConfirmed(pending.requestId), false);
		assert.equal(local.isConfirmed("other"), false);
		assert.equal(local.read("draft.scope"), pending.text);
		assert.deepEqual(local.pending("scope"), pending);
		assert.equal(local.hasUnsavedWork(), true);
	});
}

test("matching receipt confirms acceptance and clears only the unchanged draft", () => {
	for (const draft of [pending.text, "later edited goal"]) {
		const local = new LocalState();
		local.remember("scope", pending);
		local.write("draft.scope", draft);
		const expected = draft === pending.text ? "" : draft;
		assert.equal(reconcileReceipt(local, "scope", draft, pending, receipt), expected);
		assert.equal(local.read("draft.scope"), expected);
		assert.equal(local.isConfirmed(pending.requestId), true);
		assert.deepEqual(local.pending("scope"), pending);
	}
});

test("withdrawn local delivery confirms its outcome without clearing the unsent goal", () => {
	const local = new LocalState();
	local.remember("scope", pending);
	local.write("draft.scope", pending.text);
	assert.equal(
		reconcileReceipt(local, "scope", pending.text, pending, { ...receipt, state: "cancelled" }),
		pending.text,
	);
	assert.equal(local.read("draft.scope"), pending.text);
	assert.equal(local.isConfirmed(pending.requestId), true);
	assert.equal(local.hasUnsavedWork(), true);
});
