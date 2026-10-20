import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReceiptView, Snapshot } from "@hipi/work-runtime/contracts";
import {
	ConversationFailureTracker,
	conversationFailureCopy,
	conversationFailureTrackerFor,
	currentConversationFailure,
} from "../../../src/features/workbench/conversation/failure.ts";
import { projectTranscript } from "../../../src/features/workbench/conversation/transcript.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const snapshot: Snapshot = {
	...scope,
	messages: [{ id: "entry_0", role: "user", text: "hello", textLength: 5, truncated: false }],
	running: false,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: null,
};
const receipt: ReceiptView = {
	...scope,
	requestId: "request",
	receiptId: "receipt",
	submissionId: "not-a-message-id",
	state: "dispatched",
	execution: "unanswered",
	reason: "model_error",
	modelFailure: { category: "model_auth_failed", dispatch: "attempted" },
};

test("only the current scoped terminal request is eligible; stream and new submissions hide old failure", () => {
	assert.ok(currentConversationFailure(scope, "request", receipt, snapshot, false));
	for (const [id, value, view, submitting] of [
		["other", receipt, snapshot, false],
		["request", { ...receipt, conversationId: "other" }, snapshot, false],
		["request", receipt, { ...snapshot, workspaceId: "other" }, false],
		["request", { ...receipt, execution: "done" }, snapshot, false],
		["request", { ...receipt, reason: "raw provider secret" }, snapshot, false],
		["request", receipt, { ...snapshot, running: true }, false],
		["request", receipt, { ...snapshot, partial: "answer" }, false],
		["request", receipt, snapshot, true],
	] as const)
		assert.equal(currentConversationFailure(scope, id, value, view, submitting), undefined);
});

test("a failure is a stable receipt row, never an invented assistant or user-message identity", () => {
	const failure = currentConversationFailure(scope, "request", receipt, snapshot, false);
	assert.ok(failure);
	const before = projectTranscript(snapshot);
	const rows = projectTranscript(snapshot, before, failure);
	assert.equal(rows[0], before[0]);
	assert.equal(rows[1]?.kind, "request-failure");
	assert.equal(rows[1]?.message, undefined);
	assert.ok(rows[1]?.key.startsWith("request-failure:"));
	assert.notEqual(rows[1]?.key, receipt.submissionId);
	const refreshed = projectTranscript(snapshot, rows, { ...failure });
	assert.equal(refreshed[1], rows[1]);
	const changed = projectTranscript(snapshot, rows, {
		...failure,
		modelFailure: { category: "model_rate_limited", dispatch: "attempted" },
	});
	assert.equal(changed[1]?.key, rows[1]?.key);
	assert.notEqual(changed[1], rows[1]);
	assert.equal(
		projectTranscript({ ...snapshot, running: true }, rows, failure).some((row) => row.kind === "request-failure"),
		false,
	);
	assert.equal(projectTranscript(snapshot, rows).length, 1);
});

test("safe localized categories do not invent dispatch, credentials, billing, or provider diagnostics", () => {
	const failure = { key: "request-failure", modelFailure: receipt.modelFailure };
	assert.match(conversationFailureCopy(failure, "en").message, /authentication/);
	assert.match(conversationFailureCopy(failure, "zh-CN").message, /身份验证/);
	assert.match(conversationFailureCopy(failure, "en").detail, /attempted/);
	assert.match(conversationFailureCopy({ ...failure, modelFailure: undefined }, "en").detail, /not confirmed/);
	assert.match(
		conversationFailureCopy(
			{
				...failure,
				modelFailure: { category: "credential_required", dispatch: "not_sent" },
			},
			"en",
		).detail,
		/not sent/,
	);
	assert.match(
		conversationFailureCopy(
			{
				...failure,
				modelFailure: { category: "model_unavailable", dispatch: "unknown" },
			},
			"en",
		).message,
		/model or service endpoint/,
	);
	const injected = {
		key: "safe",
		modelFailure: { category: "SECRET_SENTINEL", dispatch: "SECRET_SENTINEL" },
	} as unknown as Parameters<typeof conversationFailureCopy>[0];
	const text = JSON.stringify(conversationFailureCopy(injected, "en"));
	assert.doesNotMatch(text, /SECRET_SENTINEL/);
	assert.match(text, /not confirmed/);
});

test("a later turn retires the request fence across rereads and navigation, while prepend preserves it", () => {
	const client = {};
	const tracker = conversationFailureTrackerFor(client);
	assert.equal(conversationFailureTrackerFor(client), tracker);
	assert.notEqual(conversationFailureTrackerFor({}), tracker);
	assert.ok(tracker.observe(scope, "request", receipt, snapshot, false));
	const older = { id: "older", role: "user" as const, text: "older", textLength: 5, truncated: false };
	assert.ok(
		tracker.observe(scope, "request", receipt, { ...snapshot, messages: [older, ...snapshot.messages] }, false),
	);
	assert.equal(tracker.observe(scope, "request", receipt, { ...snapshot, running: true }, false), undefined);
	assert.equal(conversationFailureTrackerFor(client).observe(scope, "request", receipt, snapshot, false), undefined);
	const nextReceipt = { ...receipt, requestId: "next", receiptId: "next-receipt" };
	assert.equal(tracker.observe(scope, "next", receipt, snapshot, false), undefined);
	assert.ok(tracker.observe(scope, "next", nextReceipt, snapshot, false));
	const later = { ...snapshot, messages: [{ ...older, id: "later" }] };
	assert.equal(tracker.observe(scope, "next", nextReceipt, later, false), undefined);
	assert.equal(tracker.observe(scope, "next", nextReceipt, snapshot, false), undefined);
});

test("new-submit suppression retires the previous failure even if the next admission is delayed", () => {
	const tracker = new ConversationFailureTracker();
	assert.ok(tracker.observe(scope, "request", receipt, snapshot, false));
	assert.equal(tracker.observe(scope, "request", receipt, snapshot, true), undefined);
	assert.equal(tracker.observe(scope, "request", receipt, snapshot, false), undefined);
});
