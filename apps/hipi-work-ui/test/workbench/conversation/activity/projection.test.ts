import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, RunResultObservation, Snapshot } from "@hipi/work-runtime/contracts";
import { projectRunActivities } from "../../../../src/features/workbench/conversation/activity/projection.ts";
import {
	mergeRunResults,
	RETAINED_RUN_LIMITS,
} from "../../../../src/features/workbench/conversation/activity/results.ts";
import { projectTranscript } from "../../../../src/features/workbench/conversation/transcript.ts";

const result: RunResultObservation = {
	id: "1",
	terminalEntryId: "9",
	admittedAtMs: 1000,
	settledAtMs: 5000,
	terminalCause: "response",
	settlement: { status: "done" },
	responseMessageId: "8_0",
};
const message = (id: string, text = "Process", runId: string | undefined = "1"): Message => ({
	id,
	role: "assistant",
	text,
	textLength: text.length,
	truncated: false,
	runId,
});
const snapshot = (messages = [message("2_0"), message("8_0", "Final")]): Snapshot => ({
	workspaceId: "w",
	conversationId: "c",
	messages,
	historyCursor: null,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: false,
	runResults: { items: [result], omitted: false },
});
function project(value = snapshot(), choices = new Map<string, boolean>(), protectedKeys = new Set<string>()) {
	return projectRunActivities(projectTranscript(value), value, choices, protectedKeys, true);
}

test("response settlement folds observed process, never final, and manual choices survive refreshed objects", () => {
	const rows = project();
	assert.deepEqual(
		rows.map((row) => row.key),
		["run:1", "message:8_0"],
	);
	assert.equal(rows[0]?.kind, "run-activity");
	const choices = new Map([["run:1", true]]);
	assert.deepEqual(
		project(snapshot(), choices).map((row) => row.key),
		["run:1", "message:2_0", "message:8_0"],
	);
	assert.deepEqual(
		project(snapshot(), new Map(), new Set(["message:2_0"])).map((row) => row.key),
		["run:1", "message:2_0", "message:8_0"],
	);
});

test("pure final, off-page final, empty process and non-response termination cannot become a process fold", () => {
	for (const value of [
		snapshot([message("8_0", "Final")]),
		snapshot([message("2_0")]),
		snapshot([message("2_0", ""), message("8_0", "Final")]),
		{
			...snapshot(),
			runResults: {
				items: [{ ...result, terminalCause: "tool-terminate" as const, responseMessageId: undefined }],
				omitted: false,
			},
		},
	]) {
		const rows = project(value);
		const header = rows.find((row) => row.kind === "run-activity");
		assert.equal(header, undefined);
		assert.equal(rows.filter((row) => row.message).length, value.messages.length);
	}
});

test("unknown membership boundary, conflicting terminals and omitted metadata never hide content", () => {
	const foreign = message("5_0", "Unknown", "2");
	for (const value of [
		snapshot([message("2_0"), foreign, message("8_0")]),
		{ ...snapshot(), runResults: { items: [result, { ...result, terminalEntryId: "10" }], omitted: false } },
		{ ...snapshot(), runResults: { items: [result], omitted: true } },
	]) {
		assert.equal(project(value).filter((row) => row.message).length, value.messages.length);
		assert.equal(
			project(value).some((row) => row.kind === "run-activity"),
			false,
		);
	}
});

test("active partial and its pending permission surface remain outside any fold", () => {
	const value: Snapshot = {
		...snapshot([message("2_0")]),
		runResults: undefined,
		running: true,
		partial: "Visible current answer",
		partialLength: 22,
		execution: {
			ownerTaskId: "4",
			run: { id: "1", admittedAtMs: 1000 },
			submissionIds: [],
			submissionCount: 0,
			tools: { items: [], total: 0, active: 0 },
			blockingCompactionCount: 0,
		},
	};
	const rows = project(value, new Map([["run:1", false]]));
	assert.deepEqual(
		rows.map((row) => row.kind),
		["run-activity", "assistant-message", "assistant-stream"],
	);
	const header = rows[0];
	assert.ok(header?.kind === "run-activity");
	assert.equal(header.activity.members.length, 0);
	assert.equal(header.activity.running, true);
});

test("metadata merging preserves conflicts, deduplicates exact repeats and explicitly bounds retained growth", () => {
	assert.deepEqual(mergeRunResults({ items: [result], omitted: false }, { items: [result], omitted: false })?.items, [
		result,
	]);
	assert.equal(
		mergeRunResults({ items: [result], omitted: false }, { items: [{ ...result, settledAtMs: 6000 }], omitted: false })
			?.omitted,
		true,
	);
	const merged = mergeRunResults({
		items: Array.from({ length: RETAINED_RUN_LIMITS.items + 1 }, (_, i) => ({
			...result,
			terminalEntryId: String(i + 10),
		})),
		omitted: false,
	});
	assert.equal(merged?.items.length, RETAINED_RUN_LIMITS.items);
	assert.equal(merged.omitted, true);
	assert.equal(mergeRunResults(undefined), undefined);
});
