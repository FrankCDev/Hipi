import assert from "node:assert/strict";
import test from "node:test";
import { FILE_SUMMARY_BYTES } from "../src/activities/file-presentation.ts";
import {
	ACTIVITY_LIMITS,
	fitsPayloadBudget,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type ToolActivity,
} from "../src/contracts.ts";

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
test("file headers are strict bounded metadata with execution and confirmed-save identity checks", () => {
	const summary = { version: 1, target: { rootId: "root", path: "note.txt" }, kind: "read", partial: false };
	const read = {
		...activity,
		toolName: "hipi_files_read",
		anchor: { assistantEntryId: "10", modelIndex: 0, contentIndex: 0 },
		resultEntryId: "30",
		effect: undefined,
		fileSummary: summary,
	};
	const parse = (item: unknown) => parseResult("getToolActivities", { ...page, items: [item] }).items[0];
	assert.deepEqual(parse(read).fileSummary, summary);
	for (const patch of [
		{ version: 2 },
		{ kind: "unknown" },
		{ partial: undefined },
		{ partial: "false" },
		{ text: "RETAINED_PRIVATE_BODY" },
		{ entries: [] },
		{ result: {} },
		{ arguments: {} },
		{ logo: "private-logo" },
		{ operationId: "not-a-read-field" },
		{ target: { ...summary.target, absolutePath: "/host/private" } },
		{ target: { rootId: "/host/root", path: "note.txt" } },
		{ target: { rootId: "root", path: "../private" } },
		{ target: { rootId: "root", path: "/host/private" } },
		{ target: { rootId: "root", path: "" } },
		{ target: { rootId: "root", path: "x".repeat(FILE_SUMMARY_BYTES) } },
	])
		assert.throws(() => parse({ ...read, fileSummary: { ...summary, ...patch } }), { code: "INVALID_REQUEST" });
	for (const patch of [
		{ source: "entry" },
		{ inherited: true },
		{ taskId: undefined },
		{ anchor: undefined },
		{ resultEntryId: undefined },
		{ parentTaskId: "parent" },
		{ phase: "running" },
		{ outcome: undefined },
		{ outcome: "failed" },
		{ outcome: "aborted" },
		{ toolResult: "error" },
		{ toolName: "hipi_files_list" },
		{ effect: { operationId: "operation", status: "unknown" } },
	])
		assert.throws(() => parse({ ...read, ...patch }), { code: "INVALID_REQUEST" });
	const save = {
		...read,
		toolName: "hipi_files_save",
		effect: { operationId: "operation", status: "confirmed" },
		artifact: { ...summary.target, operationId: "operation", status: "confirmed" },
		fileSummary: { ...summary, kind: "save", operationId: "operation" },
	};
	assert.deepEqual(parse(save).fileSummary, save.fileSummary);
	for (const patch of [
		{ effect: undefined, artifact: undefined },
		{ artifact: undefined },
		{ artifact: { ...save.artifact, path: "other.txt" } },
		{ artifact: { ...save.artifact, rootId: "other" } },
		{ fileSummary: { ...save.fileSummary, operationId: "other" } },
		{ fileSummary: { ...save.fileSummary, partial: true } },
		{ fileSummary: { ...save.fileSummary, operationId: undefined } },
	])
		assert.throws(() => parse({ ...save, ...patch }), { code: "INVALID_REQUEST" });
	for (const status of ["prepared", "executing", "conflict", "unknown", "observed_match"])
		assert.throws(
			() => parse({ ...save, effect: { ...save.effect, status }, artifact: { ...save.artifact, status } }),
			{ code: "INVALID_REQUEST" },
		);
});

test("worst valid file summary encoding and full metadata pages retain existing payload bounds", () => {
	const path = [...Array.from({ length: 7 }, () => "中".repeat(255)), "中".repeat(254), "中"].join("/");
	const fileSummary = {
		version: 1 as const,
		target: { rootId: "r".repeat(128), path },
		kind: "save" as const,
		partial: false as const,
		operationId: "o".repeat(128),
	};
	assert.equal(path.length, 2048);
	const framing = Buffer.byteLength(
		JSON.stringify({ ...fileSummary, target: { rootId: "", path: "" }, operationId: "" }),
	);
	assert.equal(Buffer.byteLength(JSON.stringify(fileSummary)), framing + 2 * 128 + 2040 * 3 + 8);
	const item: ToolActivity = {
		...activity,
		anchor: {
			assistantEntryId: "a".repeat(256),
			modelIndex: Number.MAX_SAFE_INTEGER,
			contentIndex: Number.MAX_SAFE_INTEGER,
		},
		resultEntryId: "r".repeat(256),
		effect: { operationId: fileSummary.operationId, status: "confirmed" },
		artifact: { ...fileSummary.target, operationId: fileSummary.operationId, status: "confirmed" },
		fileSummary,
	};
	assert.ok(Buffer.byteLength(JSON.stringify(fileSummary)) < FILE_SUMMARY_BYTES);
	const full = {
		...page,
		items: Array.from({ length: ACTIVITY_LIMITS.page }, (_, i) => ({ ...item, activityId: `task:${i}` })),
	};
	assert.deepEqual(parseResult("getToolActivities", full), full);
	assert.ok(fitsPayloadBudget(full));
	assert.throws(
		() => parseResult("getToolActivities", { ...full, items: [...full.items, { ...item, activityId: "extra" }] }),
		{ code: "INVALID_REQUEST" },
	);
});
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

test("selectors and exact unavailable partition reject ambiguous or expanded identities", () => {
	for (const selector of [
		{ kind: "tasks", taskIds: ["1", "2"] },
		{ kind: "message", messageId: "1_0", contentIndex: 0 },
	]) {
		const request = { version: PROTOCOL_VERSION, method: "getToolActivities", params: { ...scope, selector } };
		assert.deepEqual(parseRequest(request), request);
	}
	for (const selector of [
		{ kind: "tasks", taskIds: [] },
		{ kind: "tasks", taskIds: ["1", "1"] },
		{ kind: "tasks", taskIds: ["01"] },
		{ kind: "tasks", taskIds: ["9007199254740992"] },
		{ kind: "tasks", taskIds: Array.from({ length: 17 }, (_, i) => String(i + 1)) },
		{ kind: "message", messageId: "1_01" },
		{ kind: "message", messageId: "1_0", contentIndex: -1 },
		{ kind: "message", messageId: "1_0", callId: "guess" },
	])
		assert.throws(
			() => parseRequest({ version: PROTOCOL_VERSION, method: "getToolActivities", params: { ...scope, selector } }),
			{ code: "INVALID_REQUEST" },
		);
	assert.throws(
		() =>
			parseRequest({
				version: PROTOCOL_VERSION,
				method: "getToolActivities",
				params: { ...scope, selector: { kind: "tasks", taskIds: ["1"] }, cursor: "cursor" },
			}),
		{ code: "INVALID_REQUEST" },
	);
	const exact = { ...page, items: [{ ...activity, taskId: "1" }], unavailableTaskIds: ["2"] };
	assert.deepEqual(parseResult("getToolActivities", exact), exact);
	for (const patch of [
		{ unavailableTaskIds: ["1"] },
		{ unavailableTaskIds: ["2", "2"] },
		{ nextCursor: "cursor" },
		{ coverage: "entries" },
	])
		assert.throws(() => parseResult("getToolActivities", { ...exact, ...patch }), { code: "INVALID_REQUEST" });
});
