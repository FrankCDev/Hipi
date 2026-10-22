// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
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
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { ActivitySession } from "../../src/features/tool-activities/activity-session.ts";
import { compactFilePresentation } from "../../src/features/tool-activities/compact-file-activity.tsx";
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
let text = "";
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
			text: cursor ? "second chunk" : text,
			nextCursor: cursor ? null : "next",
			retainedOutputOnly: true,
		});
	},
	observe: async () => ({ dispose: async () => {} }),
};
function View() {
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	return (
		<ThemeProvider>
			<InlineActivityCard
				activity={item}
				locale="en"
				state={state}
				session={session}
				disabled={state.busy}
				onOpenArtifact={(file) => opened.push(file.path)}
			/>
		</ThemeProvider>
	);
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
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
	text = "<img src='unsafe'>\n**literal output**";
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
	document.getSelection()?.removeAllRanges();
	vi.unstubAllGlobals();
});
function button(label: string, target: ParentNode = host) {
	const result = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label,
	);
	assert.ok(result, label);
	return result;
}
async function openResult() {
	const toggle = host.querySelector<HTMLButtonElement>(".inline-tool-result-toggle");
	assert.ok(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	await act(async () => toggle.click());
	return toggle;
}
async function cacheOutput() {
	const owner = Symbol("existing-reader");
	await act(async () => {
		session.outputs.lease(owner, [item.activityId]);
	});
	assert.ok(session.snapshot().outputs?.get(item.activityId)?.page);
	return () => session.outputs.release(owner);
}
test("closed individual does not read; explicit output is escaped and bounded through the same session", async () => {
	await act(async () => root.render(<View />));
	assert.equal(calls.length, 1);
	assert.equal(host.querySelector("pre") === null, true);
	assert.equal(host.querySelector('[aria-label="Tool call details"]') === null, true);
	await openResult();
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
test("the generic title uses normal leading without changing notices, output or its sticky plaintext header", async () => {
	const style = document.createElement("style");
	style.textContent = ["inline-activity-card.css", "retained-output-view.css"]
		.map((name) => readFileSync(new NodeURL(`../../src/features/tool-activities/${name}`, import.meta.url), "utf8"))
		.join("\n");
	document.head.append(style);
	try {
		await act(async () => root.render(<View />));
		const card = host.querySelector(".inline-tool-generic");
		const heading = host.querySelector(".inline-tool-generic > .inline-tool-result-heading");
		const notice = host.querySelector(".inline-tool-notice");
		assert.ok(card && heading && notice);
		assert.equal(getComputedStyle(card).lineHeight, "1.625");
		// jsdom exposes the matched token rather than resolving custom-property math.
		assert.equal(getComputedStyle(heading).lineHeight, "var(--text-base--line-height)");
		assert.equal(getComputedStyle(notice).lineHeight, "1.625");
		await openResult();
		const output = host.querySelector(".retained-output-view");
		const plaintextHeader = host.querySelector(".inline-tool-text-header");
		assert.ok(output && plaintextHeader);
		assert.equal(getComputedStyle(output).lineHeight, "1.625");
		assert.equal(getComputedStyle(plaintextHeader).position, "sticky");
		assert.equal(getComputedStyle(plaintextHeader).fontSize, "var(--font-ui-small-size)");
		assert.equal(getComputedStyle(plaintextHeader).lineHeight, "var(--font-ui-small-line-height)");
		assert.equal(host.querySelector(".inline-tool-result-heading"), heading);
	} finally {
		style.remove();
	}
});

test("technical detail dialog keeps identifiers off the primary body and closing does not clear retained text", async () => {
	await act(async () => root.render(<View />));
	await openResult();
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
	await openResult();
	assert.equal(calls.length, 1, "known metadata does not pretend to be readable output");
	assert.match(host.textContent ?? "", /Execution failed/);
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

test("already-cached verified file presentation renders compact without a classification read", async () => {
	item = { ...activity, effect: undefined, artifact: undefined, outputTruncated: false };
	presentation = {
		version: 1,
		target: { rootId: "root", path: "src/example.ts" },
		result: { kind: "read", revision: "a".repeat(64), text: "hello", offset: 0, nextOffset: null, textLength: 5 },
	};
	const release = await cacheOutput();
	const cachedReads = calls.length;
	await act(async () => root.render(<View />));
	assert.equal(calls.length, cachedReads);
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
	await act(async () => release());
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
		const release = await cacheOutput();
		await act(async () => root.render(<View />));
		assert.ok(host.querySelector(kind === "directory" ? ".lucide-folder" : ".lucide-pencil"));
		assert.equal(host.querySelector("pre"), null);
		assert.doesNotMatch(host.textContent ?? "", /[+-]\d|Edited|Created/);
		await act(async () => release());
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
	await openResult();
	assert.ok(host.querySelector("pre"));
});

test("metadata-proven file row does not hydrate retained output until its dialog is opened", async () => {
	item = {
		...activity,
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 1 },
		resultEntryId: "3",
		effect: undefined,
		artifact: undefined,
		fileSummary: { version: 1, target: { rootId: "root", path: "src/example.ts" }, kind: "read", partial: false },
	};
	await session.page();
	await act(async () => root.render(<View />));
	assert.ok(host.querySelector(".inline-file-activity"));
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 0);
	assert.equal(host.querySelector("pre") === null, true);
	await act(async () => button("Tool call details").click());
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 1);
	assert.match(document.querySelector('[role="dialog"] pre')?.textContent ?? "", /literal output/);
	await act(async () => button("Close tool call details", document).click());
	assert.equal(session.snapshot().outputs?.has(item.activityId), false, "closing releases the only output lease");
});

test("metadata arriving during a generic raw dialog preserves its mounted subtree, focus and sole output reader", async () => {
	item = {
		...activity,
		effect: undefined,
		artifact: undefined,
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 1 },
		resultEntryId: "3",
	};
	await session.page();
	await act(async () => root.render(<View />));
	const inline = host.querySelector(".inline-tool-result");
	await openResult();
	await act(async () => button("Tool call details").click());
	const dialog = document.querySelector('[role="dialog"]');
	const output = dialog?.querySelector("pre");
	assert.ok(inline);
	assert.ok(dialog);
	assert.ok(output);
	const focus = document.activeElement;
	const reads = calls.filter((call) => call.method === "getToolActivityText").length;
	item = {
		...item,
		fileSummary: { version: 1, target: { rootId: "root", path: "src/example.ts" }, kind: "read", partial: false },
	};
	await act(async () => session.page());
	assert.equal(document.querySelector('[role="dialog"]') === dialog, true);
	assert.equal(document.querySelector('[role="dialog"] pre') === output, true);
	assert.equal(document.activeElement === focus, true);
	assert.equal(host.querySelector(".inline-tool-result") === inline, true);
	assert.equal(host.querySelector(".inline-file-activity") === null, true);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, reads);
	await act(async () => button("Close tool call details", document).click());
	assert.equal(host.querySelector(".inline-tool-result") === inline, true);
	assert.equal(host.querySelector(".inline-file-activity") === null, true);
});

test("revoked current metadata cannot retain a compact row's actionable file presentation", async () => {
	item = {
		...activity,
		effect: undefined,
		artifact: undefined,
		textAvailable: false,
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 1 },
		resultEntryId: "3",
		fileSummary: { version: 1, target: { rootId: "root", path: "src/example.ts" }, kind: "read", partial: false },
	};
	await session.page();
	await act(async () => root.render(<View />));
	assert.ok(host.querySelector(".inline-file-activity"));
	const { fileSummary: _summary, ...withoutSummary } = item;
	item = { ...withoutSummary, toolResult: "unavailable" };
	await act(async () => session.page());
	assert.equal(host.querySelector(".inline-file-activity") === null, true);
	assert.equal(host.querySelector(".inline-file-target") === null, true);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 0);
});

test("output-page proof rejects mismatched identities and unconfirmed writes without fetching", () => {
	const proof = {
		activityId: activity.activityId,
		text: "",
		nextCursor: null,
		retainedOutputOnly: true as const,
		presentation: {
			version: 1 as const,
			target: { rootId: "root", path: "src/example.ts" },
			result: { kind: "save" as const, operationId: "operation-private", revision: "a".repeat(64), bytes: 42 },
		},
	};
	const saved: ToolActivity = {
		...activity,
		toolName: "hipi_files_save",
		artifact: undefined,
		effect: { operationId: "operation-private", status: "confirmed" },
	};
	assert.equal(compactFilePresentation(saved, proof)?.kind, "save");
	assert.equal(compactFilePresentation({ ...saved, effect: activity.effect }, proof), undefined);
	assert.equal(compactFilePresentation(saved, { ...proof, activityId: "other" }), undefined);
	assert.equal(compactFilePresentation({ ...saved, toolName: "other" }, proof), undefined);
	assert.equal(compactFilePresentation({ ...saved, toolResult: "error" }, proof), undefined);
	assert.equal(calls.length, 1);
});

test("conflicting current file metadata invalidates an initially cached compact presentation", async () => {
	item = {
		...activity,
		effect: undefined,
		artifact: undefined,
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 1 },
		resultEntryId: "3",
	};
	presentation = {
		version: 1,
		target: { rootId: "root", path: "src/example.ts" },
		result: {
			kind: "read",
			revision: "a".repeat(64),
			text: "hello",
			offset: 0,
			nextOffset: null,
			textLength: 5,
		},
	};
	const release = await cacheOutput();
	await act(async () => root.render(<View />));
	assert.equal(host.querySelector(".inline-file-target")?.textContent, "src/example.ts");
	item = {
		...item,
		fileSummary: { version: 1, target: { rootId: "root", path: "other.ts" }, kind: "read", partial: false },
	};
	await act(async () => session.page());
	assert.equal(host.querySelector(".inline-file-activity") === null, true);
	assert.equal(host.querySelector(".inline-file-target") === null, true);
	assert.equal(host.querySelector(".inline-tool-result-toggle")?.getAttribute("aria-expanded"), "false");
	await act(async () => release());
});

test("explicitly loaded legacy presentation never replaces the generic mount or its selected text", async () => {
	item = { ...activity, effect: undefined, artifact: undefined, outputTruncated: false };
	presentation = {
		version: 1,
		target: { rootId: "root", path: "src/example.ts" },
		result: { kind: "read", revision: "a".repeat(64), text: "hello", offset: 0, nextOffset: null, textLength: 5 },
	};
	await act(async () => root.render(<View />));
	const header = host.querySelector(".inline-tool-result-name");
	assert.ok(header);
	assert.equal(calls.length, 1);
	await openResult();
	assert.equal(host.querySelector(".inline-tool-result-name") === header, true);
	assert.equal(host.querySelector(".inline-file-activity") === null, true);
	const output = host.querySelector("pre");
	assert.ok(output);
	const range = document.createRange();
	range.selectNodeContents(output);
	document.getSelection()?.removeAllRanges();
	document.getSelection()?.addRange(range);
	assert.equal(document.getSelection()?.toString(), text);
	await act(async () => document.dispatchEvent(new Event("selectionchange")));
	await act(async () => root.render(<View />));
	assert.equal(host.querySelector("pre") === output, true);
	assert.equal(document.getSelection()?.toString(), text);
	document.getSelection()?.removeAllRanges();
	await act(async () => document.dispatchEvent(new Event("selectionchange")));
});

test("a valid empty result remains a real plaintext page, not unavailable or invented no-content", async () => {
	text = "";
	item = { ...activity, effect: undefined, artifact: undefined, outputTruncated: false };
	await act(async () => root.render(<View />));
	await openResult();
	assert.equal(host.querySelector("pre")?.textContent, "");
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 1);
	assert.doesNotMatch(host.textContent ?? "", /unavailable|returned no content|Execution completed/);
});

test("pending cancellation exposes safety and inspection but only an actual result enables disclosure", async () => {
	item = {
		...activity,
		phase: "running",
		outcome: undefined,
		toolResult: "unavailable",
		textAvailable: false,
		abortRequested: true,
		effect: undefined,
		artifact: undefined,
	};
	await session.page();
	await act(async () => root.render(<View />));
	assert.equal(host.querySelector(".inline-tool-result-toggle") === null, true);
	assert.match(host.textContent ?? "", /Running|Cancellation requested/);
	await act(async () => button("Tool call details").click());
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 0);
	await act(async () => button("Close tool call details", document).click());
	item = { ...item, toolResult: "error", textAvailable: true };
	await act(async () => session.page());
	assert.match(host.textContent ?? "", /Tool result: error/);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 0);
	await openResult();
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 1);
});

test("manual individual collapse releases only its output lease and restores focus after a surviving dialog", async () => {
	await act(async () => root.render(<View />));
	const toggle = await openResult();
	const viewport = host.querySelector<HTMLElement>(".retained-output-viewport");
	assert.ok(viewport);
	viewport.focus();
	await act(async () => toggle.click());
	assert.equal(document.activeElement === toggle, true);
	assert.equal(host.querySelector("pre") === null, true);
	assert.equal(session.snapshot().outputs?.has(item.activityId), false);
	await openResult();
	await act(async () => button("Tool call details").click());
	const dialog = document.querySelector('[role="dialog"]');
	const output = dialog?.querySelector("pre");
	const count = calls.length;
	await act(async () => toggle.click());
	assert.equal(document.querySelector('[role="dialog"]') === dialog, true);
	assert.equal(dialog?.querySelector("pre") === output, true);
	assert.equal(session.snapshot().outputs?.has(item.activityId), true);
	assert.equal(calls.length, count);
	await act(async () => button("Close tool call details", document).click());
	assert.equal(document.activeElement === toggle, true);
	assert.equal(session.snapshot().outputs?.has(item.activityId), false);
});
