import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, RunResultObservation, Snapshot } from "@hipi/work-runtime/contracts";
import { projectRunActivities } from "../../../../src/features/workbench/conversation/activity/projection.ts";
import {
	hasRunResultConflict,
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

test("unknown membership boundary and conflicting terminals never hide content", () => {
	const foreign = message("5_0", "Unknown", "2");
	for (const value of [
		snapshot([message("2_0"), foreign, message("8_0")]),
		{ ...snapshot(), runResults: { items: [result, { ...result, terminalEntryId: "10" }], omitted: false } },
	]) {
		assert.equal(project(value).filter((row) => row.message).length, value.messages.length);
		assert.equal(
			project(value).some((row) => row.kind === "run-activity"),
			false,
		);
	}
});

test("partial history keeps verified elapsed groups while unknown runs remain visible", () => {
	const value = {
		...snapshot([message("2_0"), message("8_0", "Final"), message("12_0", "Unknown run", "11")]),
		runResults: { items: [result], omitted: true },
	};
	assert.deepEqual(
		project(value).map((row) => row.key),
		["run:1", "message:8_0", "message:12_0"],
	);
});

test("same-terminal conflicts invalidate both runs, survive ordinary copies and do not poison another run", () => {
	const other = { ...result, id: "11", terminalEntryId: "19", responseMessageId: "18_0" };
	const merged = mergeRunResults(
		{ items: [result, other], omitted: false },
		{ items: [{ ...result, id: "20" }], omitted: true },
	);
	assert.ok(merged);
	const copied = mergeRunResults({ ...merged }, { items: [result], omitted: false });
	assert.equal(hasRunResultConflict(copied, "1"), true);
	assert.equal(hasRunResultConflict(copied, "20"), true);
	assert.equal(hasRunResultConflict(copied, "11"), false);
	const value = {
		...snapshot([message("2_0"), message("8_0"), message("12_0", "Process", "11"), message("18_0", "Final", "11")]),
		runResults: copied,
	};
	assert.deepEqual(
		project(value).map((row) => row.key),
		["message:2_0", "message:8_0", "run:11", "message:18_0"],
	);
});

test("a full observation budget retains duplicate-terminal conflicts; actual evidence loss fails closed", () => {
	const full = mergeRunResults({
		items: Array.from({ length: RETAINED_RUN_LIMITS.items }, (_, index) => ({
			...result,
			id: String(index + 1),
			terminalEntryId: String(index + 10),
		})),
		omitted: false,
	});
	const conflicted = mergeRunResults(full, {
		items: [{ ...result, terminalEntryId: "10", settledAtMs: 6000 }],
		omitted: false,
	});
	assert.equal(hasRunResultConflict(conflicted, "1"), true);
	assert.equal(hasRunResultConflict(conflicted, "2"), false);
	const lost = mergeRunResults(full, {
		items: [
			{ ...result, id: "9000", terminalEntryId: "9001" },
			{ ...result, id: "9002", terminalEntryId: "9001" },
		],
		omitted: false,
	});
	assert.equal(lost?.retainedEvidence?.overflow, true);
	assert.equal(hasRunResultConflict(lost, "2"), true);
	const overflow = mergeRunResults({
		items: [result],
		omitted: true,
		retainedEvidence: {
			invalidRunIds: Array.from({ length: RETAINED_RUN_LIMITS.conflicts + 1 }, (_, index) => String(index + 1)),
			overflow: false,
		},
	});
	assert.ok(overflow);
	assert.equal(overflow.retainedEvidence?.invalidRunIds.length, RETAINED_RUN_LIMITS.conflicts);
	assert.equal(hasRunResultConflict(overflow, "9000"), true);
	assert.ok(new TextEncoder().encode(JSON.stringify(overflow)).byteLength < RETAINED_RUN_LIMITS.bytes);
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
