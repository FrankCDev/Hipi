import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_LIMITS, PROTOCOL_VERSION, parseRequest, parseResult, type ToolActivity } from "../src/contracts.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const activity: ToolActivity = {
	activityId: "opaque-activity",
	taskId: "task",
	callId: "call",
	toolName: "hipi_files_save",
	source: "task",
	inherited: false,
	phase: "terminal",
	outcome: "completed",
	toolResult: "success",
	abortRequested: false,
	receiptIds: ["receipt"],
	approval: { approvalId: "approval", status: "consumed", grantId: "grant", expired: false },
	effect: { operationId: "operation", status: "unknown" },
	textAvailable: true,
	outputTruncated: false,
};
const page = { items: [activity], nextCursor: null, coverage: "tasks", membershipFence: "fence" };
test("artifact references bind to the observed operation and never expose host paths", () => {
	const artifact = {
		rootId: "root",
		path: "src/file.ts",
		operationId: "operation",
		status: "unknown",
		expectedRevision: "a".repeat(64),
	};
	const valid = { ...page, items: [{ ...activity, artifact }] };
	assert.deepEqual(parseResult("getToolActivities", valid), valid);
	for (const patch of [
		{ rootId: "/host/root" },
		{ path: "../private" },
		{ operationId: "other" },
		{ status: "confirmed" },
		{ expectedRevision: "latest" },
		{ absolutePath: "/host/private" },
	])
		assert.throws(
			() =>
				parseResult("getToolActivities", {
					...page,
					items: [{ ...activity, artifact: { ...artifact, ...patch } }],
				}),
			{ code: "INVALID_REQUEST" },
		);
	assert.throws(
		() => parseResult("getToolActivities", { ...page, items: [{ ...activity, effect: undefined, artifact }] }),
		{ code: "INVALID_REQUEST" },
	);
});
test("activity summaries preserve separate execution/result/effect facts and reject raw storage data", () => {
	assert.deepEqual(parseResult("getToolActivities", page), page);
	for (const patch of [
		{ state: "completed" },
		{ taskRecord: {} },
		{ arguments: "secret" },
		{ phase: "succeeded" },
		{ outcome: "success" },
		{ toolResult: "completed" },
		{ source: "model" },
		{ inherited: undefined },
		{ receiptIds: ["receipt", "receipt"] },
		{ approval: { ...activity.approval, text: "private replacement" } },
		{ effect: { operationId: "operation", status: "succeeded" } },
		{ anchor: { assistantEntryId: "entry", modelIndex: -1, contentIndex: 0 } },
	]) {
		assert.throws(() => parseResult("getToolActivities", { ...page, items: [{ ...activity, ...patch }] }), {
			code: "INVALID_REQUEST",
		});
	}
	for (const patch of [
		{ items: [activity, activity] },
		{ items: Array(1) },
		{ items: Array.from({ length: ACTIVITY_LIMITS.page + 1 }, (_, i) => ({ ...activity, activityId: `id-${i}` })) },
		{ coverage: "all" },
		{ membershipFence: undefined },
		{ diagnostics: {} },
	])
		assert.throws(() => parseResult("getToolActivities", { ...page, ...patch }), { code: "INVALID_REQUEST" });
});
test("activity text is separately bounded without silently stripping legitimate control characters", () => {
	const output = { activityId: "activity", text: "\u0000\u001b[0m😀", nextCursor: null, retainedOutputOnly: true };
	assert.deepEqual(parseResult("getToolActivityText", output), output);
	for (const patch of [
		{ text: "\ud800" },
		{ text: "x".repeat(ACTIVITY_LIMITS.textBytes + 1) },
		{ text: "😀".repeat(ACTIVITY_LIMITS.textBytes / 4 + 1) },
		{ diagnostics: "secret" },
		{ retainedOutputOnly: undefined },
		{ nextCursor: "" },
	])
		assert.throws(() => parseResult("getToolActivityText", { ...output, ...patch }), { code: "INVALID_REQUEST" });
});
test("activity read requests cannot resume, reconcile, select host paths or expand page size", () => {
	for (const method of ["getToolActivities", "getToolActivityText"]) {
		const params = {
			...scope,
			...(method === "getToolActivityText" ? { activityId: "activity" } : {}),
			cursor: "cursor",
		};
		assert.deepEqual(parseRequest({ version: PROTOCOL_VERSION, method, params }).params, params);
		for (const patch of [
			{ resume: true },
			{ reconcile: true },
			{ limit: 999 },
			{ path: "/private" },
			{ conversationId: undefined },
		])
			assert.throws(() => parseRequest({ version: PROTOCOL_VERSION, method, params: { ...params, ...patch } }), {
				code: "INVALID_REQUEST",
			});
	}
});
