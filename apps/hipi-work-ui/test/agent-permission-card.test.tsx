import assert from "node:assert/strict";
import { parseAgentContext, parseFileOperation, parseToolApproval } from "@hipi/work-runtime/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { ApprovalCard } from "../src/features/agent-permissions/approval-card.tsx";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const digest = "a".repeat(64);
const grant = parseAgentContext({
	purpose: "live-files",
	...scope,
	requestId: "request",
	rootId: "root",
	pathPrefixes: [""],
	model: { provider: "fake", modelId: "model" },
	expiresAt: 10000,
	disclosureVersion: 1,
	grantId: "grant",
	revision: 1,
	status: "active",
});
const approval = parseToolApproval({
	...scope,
	approvalId: "approval",
	taskId: "task",
	callId: "call",
	submissionIds: ["submission"],
	receiptIds: ["receipt"],
	toolName: "hipi_files_save",
	model: grant.model,
	rootId: "root",
	path: "src/example.ts",
	ifMatch: digest,
	text: "after",
	beforeText: "before",
	beforeTextTruncated: true,
	argumentsDigest: digest,
	contentDigest: digest,
	grantId: "grant",
	grantRevision: 1,
	expiresAt: 10000,
	createdAt: 1,
	revision: 1,
	status: "pending",
	operationId: "operation",
});
const operation = parseFileOperation({
	...scope,
	operationId: "operation",
	approvalId: "approval",
	taskId: "task",
	callId: "call",
	rootId: "root",
	path: "src/example.ts",
	argumentsDigest: digest,
	contentDigest: digest,
	status: "observed_match",
	revision: 1,
});
function render(status: typeof approval.status = "pending", locale = "en", revoked = false, atCapacity = false) {
	return renderToStaticMarkup(
		<ApprovalCard
			approval={{ ...approval, status }}
			operation={operation}
			contexts={[{ ...grant, status: revoked ? "revoked" : "active" }]}
			now={2}
			locale={locale}
			disabled={false}
			approveDisabled={atCapacity}
			reconcileDisabled={false}
			onDecide={() => {}}
			onReconcile={() => {}}
		/>,
	);
}
test("review card exposes bound identity, truncation and honest read-only outcome", () => {
	const html = render();
	for (const text of [
		"workspace / conversation",
		"root / src/example.ts",
		"fake / model",
		"NOT a complete diff",
		"does not prove who wrote it",
		"Read-only outcome check",
		"Approval does not resume a paused workspace",
	])
		assert.ok(html.includes(text), text);
	assert.match(html, /<summary>Review proposed diff<\/summary>/);
	assert.doesNotMatch(html, /disabled=""/);
});
test("all nonpending or revoked approvals render disabled decision buttons, with bilingual labels", () => {
	for (const status of ["approved", "rejected", "consumed", "expired", "invalidated"] as const)
		assert.equal((render(status).match(/disabled=""/g) ?? []).length, 2);
	assert.equal((render("pending", "en", true).match(/disabled=""/g) ?? []).length, 2);
	assert.match(render("pending", "zh-CN"), /这不是完整 Diff/);
	assert.match(render("pending", "zh-CN"), /不能据此证明由谁写入/);
});

test("attention capacity blocks approval while leaving explicit rejection available", () => {
	const html = render("pending", "en", false, true);
	const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(([value]) => value);
	assert.match(buttons.find((value) => value.includes("Approve this write")) ?? "", /disabled=""/);
	assert.doesNotMatch(buttons.find((value) => value.includes("Reject this write")) ?? "", /disabled=""/);
});
