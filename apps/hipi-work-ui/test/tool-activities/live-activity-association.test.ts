import assert from "node:assert/strict";
import type { Snapshot, ToolActivity, ToolActivityPage } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { anchoredLiveActivities, anchoredLiveTools } from "../../src/features/tool-activities/live-activity.ts";

const snapshot: Snapshot = {
	workspaceId: "w",
	conversationId: "c",
	messages: [
		{
			id: "1_0",
			role: "assistant",
			text: "",
			textLength: 0,
			truncated: false,
			toolCalls: { items: [{ callId: "same", name: "read", contentIndex: 1 }], total: 1 },
		},
		{
			id: "2_0",
			role: "assistant",
			text: "",
			textLength: 0,
			truncated: false,
			toolCalls: { items: [{ callId: "same", name: "read", contentIndex: 1 }], total: 1 },
		},
	],
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: true,
	historyCursor: null,
	execution: {
		ownerTaskId: "8",
		submissionIds: ["7"],
		submissionCount: 1,
		tools: { items: [{ taskId: "9", callId: "same", name: "read", status: "running" }], total: 1, active: 1 },
		blockingCompactionCount: 0,
	},
};
const item: ToolActivity = {
	activityId: "task:9",
	taskId: "9",
	callId: "same",
	toolName: "read",
	source: "task",
	inherited: false,
	anchor: { assistantEntryId: "2", modelIndex: 0, contentIndex: 1 },
	phase: "running",
	toolResult: "unavailable",
	abortRequested: false,
	receiptIds: [],
	textAvailable: false,
	outputTruncated: false,
};
const page: ToolActivityPage = {
	items: [item],
	coverage: "tasks",
	nextCursor: null,
	membershipFence: "f",
	unavailableTaskIds: [],
};
test("already-committed current tool binds only to its full anchor, not a prior round with same callId", () => {
	const groups = anchoredLiveActivities(snapshot, page);
	assert.equal(groups.size, 1);
	assert.equal(groups.get("2_0")?.[0]?.taskId, "9");
	assert.equal(groups.has("1_0"), false);
	assert.equal(
		anchoredLiveActivities(snapshot, {
			...page,
			items: [{ ...item, taskId: "old", anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 1 } }],
		}).size,
		0,
	);
});
test("off-page, unavailable, unanchored and completed runs keep no false historical attachment", () => {
	for (const current of [
		{ ...snapshot, messages: [snapshot.messages[0]].filter((message) => message !== undefined) },
		{ ...snapshot, running: false },
		{ ...snapshot, execution: undefined },
	])
		assert.equal(anchoredLiveActivities(current, page).size, 0);
	assert.equal(anchoredLiveActivities(snapshot, { ...page, items: [], unavailableTaskIds: ["9"] }).size, 0);
	assert.equal(anchoredLiveActivities(snapshot, { ...page, items: [{ ...item, anchor: undefined }] }).size, 0);
});

test("round proof anchors pending slots before task creation, without joining repeated call IDs", () => {
	assert.ok(snapshot.execution);
	const pending = {
		callId: "same",
		name: "read",
		status: "pending" as const,
		anchor: { assistantEntryId: "2", modelIndex: 0, contentIndex: 1 },
	};
	const current = {
		...snapshot,
		execution: { ...snapshot.execution, tools: { ...snapshot.execution.tools, items: [pending] } },
	};
	assert.equal(anchoredLiveTools(current, undefined).get("2_0")?.[0], pending);
	assert.equal(anchoredLiveTools(current, undefined).has("1_0"), false);
	assert.equal(anchoredLiveTools({ ...current, running: false }, undefined).size, 0);
	assert.equal(
		anchoredLiveTools({ ...current, messages: current.messages.filter((message) => message.id !== "2_0") }, undefined)
			.size,
		0,
	);
});
