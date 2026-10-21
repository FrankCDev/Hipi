// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type FilePresentation,
	type Method,
	type Params,
	parseResult,
	type ToolActivity,
} from "@hipi/work-runtime/contracts";
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
let presentation: FilePresentation | undefined;
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
			...(presentation && !cursor ? { presentation } : {}),
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
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	item = { ...activity };
	failText = false;
	presentation = undefined;
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
test("expanded inline tool output is directly read, escaped and bounded through the same session", async () => {
	await act(async () => root.render(<View />));
	assert.equal(calls.length, 2);
	assert.doesNotMatch(host.textContent ?? "", /operation-private|receipt-private|Source: task record/);
	assert.match(host.textContent ?? "", /original write is not confirmed|content may differ/);
	assert.equal(calls[1]?.method, "getToolActivityText");
	assert.match(host.querySelector("pre")?.textContent ?? "", /<img src='unsafe'>/);
	assert.equal(host.querySelector("img"), null);
	assert.doesNotMatch(host.textContent ?? "", /Retained tool output only/);
	assert.match(host.textContent ?? "", /Output was truncated upstream/);
	assert.doesNotMatch(host.textContent ?? "", /First output chunk/);
	const viewport = host.querySelector(".retained-output-viewport");
	assert.ok(viewport);
	await act(async () => viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 })));
	assert.match(host.querySelector("pre")?.textContent ?? "", /literal output.*second chunk/s);
	assert.equal((calls[2]?.params as Params<"getToolActivityText">).cursor, "next");
	assert.doesNotMatch(host.textContent ?? "", /First output chunk|Next output chunk/);
	await act(async () => button("src/example.ts").click());
	assert.deepEqual(opened, ["src/example.ts"]);
});
test("technical detail dialog keeps identifiers off the primary body and closing does not clear retained text", async () => {
	await act(async () => root.render(<View />));
	const text = session.snapshot().outputs?.get(item.activityId)?.page;
	const count = calls.length;
	await act(async () => button("Tool call details").click());
	const dialog = document.querySelector('[role="dialog"]');
	assert.ok(dialog);
	assert.match(dialog.textContent ?? "", /operation-private|receipt-private/);
	assert.match(dialog.textContent ?? "", /Retained tool output only/);
	assert.equal(calls.length, count, "details reuse existing evidence without a second reader");
	await act(async () => button("Close tool call details", document).click());
	assert.equal(document.querySelector('[role="dialog"]'), null);
	assert.equal(session.snapshot().outputs?.get(item.activityId)?.page, text);
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

test("protocol11 file presentation renders a compact file row while raw output remains in the same-reader dialog", async () => {
	item = { ...activity, effect: undefined, artifact: undefined, outputTruncated: false };
	presentation = {
		version: 1,
		target: { rootId: "root", path: "src/example.ts" },
		result: { kind: "read", revision: "a".repeat(64), text: "hello", offset: 0, nextOffset: null, textLength: 5 },
	};
	await act(async () => root.render(<View />));
	assert.ok(host.querySelector(".inline-file-activity-row .lucide-file"));
	assert.match(host.textContent ?? "", /Read file.*example.ts/);
	assert.equal(host.querySelector("pre"), null);
	assert.doesNotMatch(host.textContent ?? "", /Execution completed|plaintext|literal output/);
	const count = calls.length;
	await act(async () => button("Tool call details").click());
	assert.match(document.querySelector('[role="dialog"] pre')?.textContent ?? "", /literal output/);
	assert.equal(calls.length, count);
	const viewport = document.querySelector('[role="dialog"] .retained-output-viewport');
	assert.ok(viewport);
	failText = true;
	await act(async () => viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 })));
	assert.ok(host.querySelector(".inline-file-activity"));
	assert.ok(document.querySelector('[role="dialog"]'));
	assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /Records could not be read/);
	failText = false;
	await act(async () => button("Retry read", document.querySelector('[role="dialog"]') ?? document).click());
	assert.match(document.querySelector('[role="dialog"] pre')?.textContent ?? "", /literal output.*second chunk/s);
});
test("directory and confirmed save presentation do not invent diff statistics or expand raw JSON in the row", async () => {
	for (const kind of ["directory", "save"] as const) {
		item = {
			...activity,
			toolName: kind === "directory" ? "hipi_files_list" : "hipi_files_save",
			outputTruncated: false,
			effect: kind === "save" ? { operationId: "operation-private", status: "confirmed" } : undefined,
			artifact: undefined,
		};
		presentation = {
			version: 1,
			target: { rootId: "root", path: "src" },
			result:
				kind === "directory"
					? { kind, entries: [], hasMore: false }
					: { kind, operationId: "operation-private", revision: "a".repeat(64), bytes: 42 },
		};
		await act(async () => {
			root.render(<div />);
		});
		await session.page();
		await act(async () => root.render(<View />));
		assert.ok(host.querySelector(kind === "directory" ? ".lucide-folder" : ".lucide-pencil"));
		assert.equal(host.querySelector("pre"), null);
		assert.doesNotMatch(host.textContent ?? "", /[+-]\d|Edited|Created/);
	}
});
test("presentation cannot hide unknown writes or be reused for another tool or activity", async () => {
	presentation = {
		version: 1,
		target: { rootId: "root", path: "src/example.ts" },
		result: { kind: "save", operationId: "operation-private", revision: "a".repeat(64), bytes: 42 },
	};
	item = { ...activity, toolName: "hipi_files_save" };
	await act(async () => root.render(<View />));
	assert.equal(host.querySelector(".inline-file-activity"), null);
	assert.match(host.textContent ?? "", /original write is not confirmed/);
	assert.ok(host.querySelector("pre"));
});
