import assert from "node:assert/strict";
import type { ConversationExecution, ToolApproval } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { matchesExecutionApproval } from "../../src/features/agent-permissions/approval-correlation.ts";

const scope = { workspaceId: "w", conversationId: "c" };
const approval: ToolApproval = {
	...scope,
	approvalId: "a",
	taskId: "12",
	callId: "call",
	submissionIds: ["10"],
	receiptIds: [],
	toolName: "hipi_files_save",
	model: { provider: "test", modelId: "test" },
	rootId: "r",
	path: "a.txt",
	ifMatch: "a".repeat(64),
	text: "a",
	beforeText: "",
	beforeTextTruncated: false,
	argumentsDigest: "a".repeat(64),
	contentDigest: "a".repeat(64),
	grantId: "g",
	grantRevision: 1,
	expiresAt: 1000,
	createdAt: 1,
	revision: 1,
	status: "pending",
};
const execution: ConversationExecution = {
	ownerTaskId: "11",
	submissionIds: ["10"],
	submissionCount: 1,
	tools: { items: [{ taskId: "12", callId: "call", name: "hipi_files_save", status: "pending" }], total: 1, active: 1 },
	blockingCompactionCount: 0,
};
test("approval can block before tool execution starts, but requires exact live identity", () => {
	assert.equal(matchesExecutionApproval(approval, scope, execution, 2), true);
	for (const patch of [
		{ taskId: "other" },
		{ callId: "other" },
		{ submissionIds: ["old"] },
		{ workspaceId: "other" },
		{ conversationId: "other" },
		{ status: "approved" as const },
		{ expiresAt: 2 },
	])
		assert.equal(matchesExecutionApproval({ ...approval, ...patch }, scope, execution, 2), false);
});
test("done, unbound and bounded-out slots cannot be guessed into waiting approvals", () => {
	for (const tools of [
		{
			items: [{ taskId: "12", callId: "call", name: "hipi_files_save", status: "done" as const }],
			total: 1,
			active: 0,
		},
		{ items: [], total: 20, active: 20 },
		{ items: [{ callId: "call", name: "hipi_files_save", status: "running" as const }], total: 1, active: 1 },
	])
		assert.equal(matchesExecutionApproval(approval, scope, { ...execution, tools }, 2), false);
	assert.equal(matchesExecutionApproval(approval, scope, undefined, 2), false);
	assert.equal(matchesExecutionApproval(null, scope, execution, 2), false);
	assert.equal(
		matchesExecutionApproval(approval, scope, { ...execution, submissionIds: [], submissionCount: 100 }, 2),
		false,
	);
});
