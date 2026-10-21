import assert from "node:assert/strict";
import type { ConversationExecution, Snapshot } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { responsePhase } from "../../../src/features/workbench/conversation/response-phase.ts";

const execution: ConversationExecution = {
	ownerTaskId: "11",
	submissionIds: ["10"],
	submissionCount: 1,
	generation: { attempt: 1 },
	tools: { items: [], total: 0, active: 0 },
	blockingCompactionCount: 0,
};
const snapshot: Snapshot = {
	workspaceId: "w",
	conversationId: "c",
	messages: [],
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: true,
	historyCursor: null,
	execution,
};
const withExecution = (changes: Partial<ConversationExecution>): Snapshot => ({
	...snapshot,
	execution: { ...execution, ...changes },
});

test("generic generation is only an active no-text fallback, never an inferred reasoning phase", () => {
	assert.equal(responsePhase(snapshot), "generating");
	assert.equal(responsePhase({ ...snapshot, execution: undefined }), "working");
	assert.equal(responsePhase({ ...snapshot, partial: "Text", partialLength: 4 }), undefined);
	assert.equal(responsePhase(withExecution({ generation: { attempt: 3 } })), "generating");
});
test("missing generation, pending tools and retained current text never claim Thinking", () => {
	assert.equal(responsePhase(withExecution({ generation: undefined })), "working");
	assert.equal(responsePhase({ ...withExecution({ generation: undefined }), partial: "Visible output" }), undefined);
	assert.equal(
		responsePhase(
			withExecution({
				tools: { items: [{ callId: "pending", name: "read", status: "pending" }], total: 1, active: 1 },
			}),
		),
		"tools",
	);
});
test("current execution metadata renders actual waits even when partial text remains", () => {
	assert.equal(responsePhase(withExecution({ generation: { attempt: 2, retryAt: 0 } })), "retry");
	assert.equal(responsePhase(withExecution({ generation: { attempt: 1, deferredPollAt: 1 } })), "deferred");
	const tools = {
		items: [{ taskId: "12", callId: "tool-a", name: "read", status: "running" as const }],
		total: 1,
		active: 1,
	};
	assert.equal(
		responsePhase({ ...withExecution({ generation: undefined, tools }), partial: "Retained text", partialLength: 13 }),
		"tools",
	);
	assert.equal(responsePhase(withExecution({ tools, blockingCompactionCount: 1 })), "compacting");
});
test("bounded tool previews do not hide active slots outside the visible items", () => {
	assert.equal(responsePhase(withExecution({ tools: { items: [], total: 20, active: 2 } })), "tools");
	assert.equal(
		responsePhase(
			withExecution({ tools: { items: [{ callId: "done", name: "read", status: "done" }], total: 1, active: 0 } }),
		),
		"generating",
	);
});
test("pause, disconnect or pending cancellation never makes retained execution metadata look live", () => {
	for (const state of [
		snapshot,
		withExecution({ blockingCompactionCount: 1 }),
		withExecution({ generation: { attempt: 1, retryAt: 5 } }),
	]) {
		assert.equal(responsePhase(state, false), undefined);
		assert.equal(responsePhase({ ...state, running: false }), undefined);
	}
});
test("handover does not retain old task activity or turn a stopped snapshot into completion", () => {
	const old = withExecution({
		tools: { items: [{ taskId: "12", callId: "call", name: "read", status: "running" }], total: 1, active: 1 },
	});
	assert.equal(responsePhase(old), "tools");
	assert.equal(
		responsePhase(withExecution({ ownerTaskId: "13", tools: { items: [], total: 0, active: 0 } })),
		"generating",
	);
	assert.equal(responsePhase({ ...old, running: false }), undefined);
});
