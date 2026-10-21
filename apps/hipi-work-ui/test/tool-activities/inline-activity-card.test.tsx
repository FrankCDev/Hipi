// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type AppClient, type Method, type Params, parseResult, type ToolActivity } from "@hipi/work-runtime/contracts";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ActivitySession } from "../../src/features/tool-activities/activity-session.ts";
import { InlineActivityCard } from "../../src/features/tool-activities/inline-activity-card.tsx";

const activity: ToolActivity = {
	activityId: "activity-1",
	taskId: "2",
	callId: "call-1",
	toolName: "hipi_files_read",
	source: "task",
	inherited: false,
	phase: "terminal",
	outcome: "completed",
	toolResult: "success",
	abortRequested: false,
	receiptIds: ["receipt-private"],
	textAvailable: true,
	outputTruncated: true,
	effect: { operationId: "operation-private", status: "observed_match" },
	artifact: { rootId: "root", path: "src/example.ts", operationId: "operation-private", status: "observed_match" },
};
let host: HTMLDivElement;
let root: Root;
let session: ActivitySession;
const calls: { method: Method; params: Params<Method> }[] = [];
const opened: string[] = [];
let item: ToolActivity;
let failText = false;
const client: AppClient = {
	call: async <M extends Method>(method: M, params: Params<M>) => {
		calls.push({ method, params });
		if (method === "getToolActivities")
			return parseResult(method, { items: [item], nextCursor: null, coverage: "tasks", membershipFence: "f" });
		assert.equal(method, "getToolActivityText");
		if (failText) throw new Error("Unavailable output page");
		const cursor = (params as Params<"getToolActivityText">).cursor;
		return parseResult(method, {
			activityId: item.activityId,
			text: cursor ? "second chunk" : "<img src='unsafe'>\n**literal output**",
			nextCursor: cursor ? null : "next",
			retainedOutputOnly: true,
		});
	},
	observe: async () => ({ dispose: async () => {} }),
};
function View() {
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	return (
		<InlineActivityCard
			activity={item}
			locale="en"
			state={state}
			session={session}
			disabled={state.busy}
			onOpenArtifact={(file) => opened.push(file.path)}
		/>
	);
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	item = { ...activity };
	failText = false;
	calls.length = 0;
	opened.length = 0;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	session = new ActivitySession(client, { workspaceId: "w", conversationId: "c" });
	session.activate();
	await session.page();
});
afterEach(async () => {
	await act(async () => root.unmount());
	session.dispose();
	host.remove();
	vi.unstubAllGlobals();
});
function button(label: string, target: ParentNode = host) {
	const result = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label,
	);
	assert.ok(result, label);
	return result;
}
test("inline tool output is explicitly read, escaped and bounded through the same session", async () => {
	await act(async () => root.render(<View />));
	assert.equal(calls.length, 1);
	assert.doesNotMatch(host.textContent ?? "", /operation-private|receipt-private|Source: task record/);
	assert.match(host.textContent ?? "", /original write is not confirmed|content may differ/);
	await act(async () => button("Read retained output").click());
	assert.equal(calls[1]?.method, "getToolActivityText");
	assert.match(host.querySelector("pre")?.textContent ?? "", /<img src='unsafe'>/);
	assert.equal(host.querySelector("img"), null);
	assert.doesNotMatch(host.textContent ?? "", /Retained tool output only/);
	assert.match(host.textContent ?? "", /Output was truncated upstream/);
	assert.doesNotMatch(host.textContent ?? "", /First output chunk/);
	await act(async () => button("Next output chunk").click());
	assert.equal(host.querySelector("pre")?.textContent, "second chunk");
	assert.equal((calls[2]?.params as Params<"getToolActivityText">).cursor, "next");
	assert.equal(session.snapshot().textCursor, "next");
	await act(async () => button("First output chunk").click());
	assert.equal(session.snapshot().textCursor, undefined);
	assert.doesNotMatch(host.textContent ?? "", /First output chunk/);
	await act(async () => button("src/example.ts").click());
	assert.deepEqual(opened, ["src/example.ts"]);
});
test("technical detail dialog keeps identifiers off the primary body and closing does not clear retained text", async () => {
	await act(async () => root.render(<View />));
	await act(async () => button("Read retained output").click());
	const text = session.snapshot().text;
	const count = calls.length;
	await act(async () => button("Tool call details").click());
	const dialog = document.querySelector('[role="dialog"]');
	assert.ok(dialog);
	assert.match(dialog.textContent ?? "", /operation-private|receipt-private/);
	assert.match(dialog.textContent ?? "", /Retained tool output only/);
	assert.equal(calls.length, count, "details reuse existing evidence without a second reader");
	await act(async () => button("Close tool call details", document).click());
	assert.equal(document.querySelector('[role="dialog"]'), null);
	assert.equal(session.snapshot().text, text);
	assert.ok(host.querySelector("pre"));
});
test("unavailable retained output has no pretend read control and failed execution is not a fabricated tool result", async () => {
	item = {
		...activity,
		textAvailable: false,
		toolResult: "unavailable",
		outcome: "failed",
		artifact: undefined,
		effect: undefined,
	};
	await act(async () => root.render(<View />));
	assert.match(host.textContent ?? "", /Execution failed/);
	assert.match(host.textContent ?? "", /Tool result: unavailable/);
	assert.doesNotMatch(host.textContent ?? "", /Read retained output|Tool result: error/);
	assert.equal(calls.length, 1);
});

test("output cursor follows successfully displayed text through failure, collapse and activity changes", async () => {
	await session.text(item.activityId);
	assert.equal(session.snapshot().textCursor, undefined);
	failText = true;
	await session.text(item.activityId, "next");
	assert.equal(session.snapshot().textCursor, undefined);
	assert.match(session.snapshot().text?.text ?? "", /literal output/);
	failText = false;
	await session.text(item.activityId, "next");
	const later = session.snapshot().text;
	failText = true;
	await session.text(item.activityId);
	assert.equal(session.snapshot().text, later);
	assert.equal(session.snapshot().textCursor, "next");
	session.collapse();
	assert.equal(session.snapshot().text, undefined);
	assert.equal(session.snapshot().textCursor, undefined);
	failText = false;
	await session.text(item.activityId, "next");
	item = { ...activity, activityId: "activity-2" };
	await session.page();
	assert.equal(session.snapshot().textCursor, undefined);
	await session.text(item.activityId);
	assert.equal(session.snapshot().text?.activityId, "activity-2");
	assert.equal(session.snapshot().textCursor, undefined);
	session.dispose();
	assert.equal(session.snapshot().textCursor, undefined);
});
