import assert from "node:assert/strict";
import {
	parseAgentContext,
	parseFileOperation,
	parseToolApproval,
	type ToolActivity,
} from "@hipi/work-runtime/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { ApprovalCard } from "../src/features/agent-permissions/approval-card.tsx";
import type { ActivityState } from "../src/features/tool-activities/activity-session.ts";
import { ActivityTranscriptProvider } from "../src/features/tool-activities/activity-transcript.tsx";
import { activityLabels } from "../src/features/tool-activities/labels.ts";
import { ActivityHistoryAction, ToolActivities } from "../src/features/tool-activities/tool-activities.tsx";

const fixture = vi.hoisted(() => ({ state: { busy: false, failed: false } as ActivityState, locale: "en" }));
vi.mock("../src/app/client-provider.tsx", () => ({ useAppClient: () => ({}) }));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: fixture.locale }) }));
vi.mock("../src/features/tool-activities/activity-session.ts", () => ({
	ActivitySession: class {
		snapshot = () => fixture.state;
		subscribe = () => () => {};
	},
}));
vi.mock("../src/features/files/code-editor.tsx", () => ({
	CodeDiff: ({ before, after }: { before: string; after: string }) => <div data-before={before} data-after={after} />,
}));

const activity: ToolActivity = {
	activityId: "task:1",
	taskId: "1",
	callId: "call",
	toolName: "hipi_files_read",
	source: "task",
	inherited: false,
	phase: "running",
	toolResult: "unavailable",
	abortRequested: false,
	receiptIds: [],
	textAvailable: false,
	outputTruncated: false,
};
beforeEach(() => {
	fixture.state = { busy: false, failed: false };
	fixture.locale = "en";
});
function activityMarkup(connected = true, running = false) {
	return renderToStaticMarkup(
		<ToolActivities
			scope={{ workspaceId: "workspace", conversationId: "conversation" }}
			connected={connected}
			running={running}
		/>,
	);
}
test("idle and empty scanned pages do not add composer chrome; progressive details retains history access", () => {
	for (const page of [
		undefined,
		{ items: [], nextCursor: "more-records", coverage: "tasks" as const, membershipFence: "fence" },
	]) {
		fixture.state = { busy: false, failed: false, page };
		const html = activityMarkup(true, true);
		assert.doesNotMatch(html, /activity-context|View activity/);
		assert.doesNotMatch(html, /No activity in this scanned page|Records not yet read|Execution completed|Last read/);
	}
	const details = renderToStaticMarkup(
		<ActivityTranscriptProvider scope={scope} connected running={false}>
			<ActivityHistoryAction />
		</ActivityTranscriptProvider>,
	);
	assert.match(details, /View activity/);
	assert.match(details, /aria-haspopup="dialog"/);
	assert.match(details, /aria-expanded="false"/);
	assert.match(details, /aria-controls=/);
	assert.equal(
		activityLabels("en")["activity.empty"],
		"No activity in this scanned page. More records may be available on the next page.",
	);
});
test("compact snapshots use recorded tool and phase, including failed outcome and complete tooltip", () => {
	fixture.state.page = { items: [activity], nextCursor: null, coverage: "tasks", membershipFence: "fence" };
	const running = activityMarkup();
	assert.match(running, /data-state="record"/);
	assert.match(running, /title="Last read: Read file · Running"/);
	assert.doesNotMatch(running, /Execution completed|No activity/);
	fixture.state.page.items = [{ ...activity, phase: "terminal", outcome: "failed", toolResult: "error" }];
	const failed = activityMarkup();
	assert.match(failed, /Execution ended · Execution failed · Tool result: error/);
	assert.doesNotMatch(failed, /Execution completed/);
});
test("closed activity disclosure never hides read failures or presents disconnected evidence as current", () => {
	fixture.state.failed = true;
	const failed = activityMarkup();
	assert.match(failed, /role="alert"/);
	assert.ok(failed.includes(activityLabels("en")["activity.failed"]));
	fixture.state.page = { items: [activity], nextCursor: null, coverage: "tasks", membershipFence: "fence" };
	const offline = activityMarkup(false);
	assert.ok(offline.includes(activityLabels("en")["activity.offline"]));
	assert.match(offline, /Last read: Read file/);
	fixture.locale = "zh-CN";
	assert.ok(activityMarkup().includes(activityLabels("zh")["activity.failed"]));
});

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const grant = parseAgentContext({
	purpose: "live-files",
	...scope,
	requestId: "request",
	rootId: "root",
	pathPrefixes: [""],
	model: { provider: "provider", modelId: "model" },
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
	path: "src/exact file.ts",
	ifMatch: "a".repeat(64),
	text: "the complete proposed replacement",
	beforeText: "the retained previous content",
	beforeTextTruncated: true,
	argumentsDigest: "b".repeat(64),
	contentDigest: "c".repeat(64),
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
	path: approval.path,
	argumentsDigest: approval.argumentsDigest,
	contentDigest: approval.contentDigest,
	status: "unknown",
	revision: 1,
});
function approvalMarkup(reconcileDisabled = false, approveDisabled = false) {
	return renderToStaticMarkup(
		<ApprovalCard
			approval={approval}
			operation={operation}
			contexts={[grant]}
			now={2}
			locale="en"
			disabled={false}
			approveDisabled={approveDisabled}
			reconcileDisabled={reconcileDisabled}
			onDecide={() => {}}
			onReconcile={() => {}}
		/>,
	);
}
test("approval shows exact target, scope, provider, expiry and expected version before progressive details", () => {
	const html = approvalMarkup();
	const visibleFacts = html.slice(0, html.indexOf("<details"));
	for (const text of [
		"hipi_files_save",
		"Awaiting approval",
		"root / src/exact file.ts",
		"workspace / conversation",
		"provider / model",
		"Expires",
		"Expected file version",
		approval.ifMatch,
	])
		assert.ok(visibleFacts.includes(text), text);
	assert.doesNotMatch(visibleFacts, /bbbbbbbbbbbb|cccccccccccc/);
	assert.match(html, /<details class="approval-provenance"><summary>Arguments \/ content digest<\/summary>/);
	assert.ok(html.includes(approval.argumentsDigest));
	assert.ok(html.includes(approval.contentDigest));
	assert.match(html, /task \/ call \/ submission \/ receipt/);
});
test("proposed diff opens with unchanged complete text, while truncation and unknown effect precede decisions", () => {
	const html = approvalMarkup();
	assert.match(html, /<details class="approval-diff" open=""><summary>Review proposed diff<\/summary>/);
	assert.match(html, /data-before="the retained previous content"/);
	assert.match(html, /data-after="the complete proposed replacement"/);
	for (const text of ["NOT a complete diff", "Do not repeat the write", "Read-only outcome check"])
		assert.ok(html.indexOf(text) < html.indexOf("Approve this write"), text);
	assert.match(html, /approval-outcome" data-status="unknown"/);
	assert.doesNotMatch(html, /Write confirmed/);
	assert.match(html, /Approval does not resume a paused workspace/);
});
test("presentation keeps outcome-check disabling independent from approval capacity and rejection", () => {
	const html = approvalMarkup(true, true);
	const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(([value]) => value);
	assert.match(buttons.find((value) => value.includes("Read-only outcome check")) ?? "", /disabled=""/);
	assert.match(buttons.find((value) => value.includes("Approve this write")) ?? "", /disabled=""/);
	assert.doesNotMatch(buttons.find((value) => value.includes("Reject this write")) ?? "", /disabled=""/);
});
