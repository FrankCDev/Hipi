import assert from "node:assert/strict";
import type { ToolActivity, ToolActivityPage, ToolActivitySelector } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { validateActivitySelection } from "../../src/features/tool-activities/activity-selection.ts";

const activity: ToolActivity = {
	activityId: "task:2",
	taskId: "2",
	callId: "call",
	toolName: "read",
	source: "task",
	inherited: false,
	phase: "terminal",
	toolResult: "success",
	abortRequested: false,
	receiptIds: [],
	textAvailable: false,
	outputTruncated: false,
	anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 1 },
};
const page: ToolActivityPage = { items: [activity], nextCursor: null, coverage: "tasks", membershipFence: "f" };
const selector: ToolActivitySelector = { kind: "tasks", taskIds: ["2", "3"] };
test("exact metadata accepts only a complete disjoint requested-ID partition", () => {
	assert.doesNotThrow(() =>
		validateActivitySelection({ ...page, unavailableTaskIds: ["3"] }, selector, new Map([["2", "call"]])),
	);
	for (const value of [
		{ ...page },
		{ ...page, unavailableTaskIds: [] },
		{ ...page, unavailableTaskIds: ["2", "3"] },
		{ ...page, unavailableTaskIds: ["3", "3"] },
		{ ...page, unavailableTaskIds: ["other"] },
		{ ...page, items: [activity, activity], unavailableTaskIds: ["3"] },
		{ ...page, nextCursor: "cursor", unavailableTaskIds: ["3"] },
	])
		assert.throws(() => validateActivitySelection(value, selector));
	assert.throws(() =>
		validateActivitySelection({ ...page, unavailableTaskIds: ["3"] }, selector, new Map([["2", "different-call"]])),
	);
});
test("historical pages require exact durable anchors, never an unrelated latest tool", () => {
	const selected: ToolActivitySelector = { kind: "message", messageId: "1_0", contentIndex: 1 };
	assert.doesNotThrow(() => validateActivitySelection(page, selected));
	assert.doesNotThrow(() => validateActivitySelection({ ...page, items: [], nextCursor: "more" }, selected));
	for (const value of [
		{ ...page, items: [{ ...activity, anchor: undefined }] },
		{ ...page, items: [{ ...activity, anchor: { assistantEntryId: "2", modelIndex: 0, contentIndex: 1 } }] },
		{ ...page, unavailableTaskIds: [] },
	])
		assert.throws(() => validateActivitySelection(value, selected));
	assert.throws(() => validateActivitySelection(page, { ...selected, contentIndex: 2 }));
});
