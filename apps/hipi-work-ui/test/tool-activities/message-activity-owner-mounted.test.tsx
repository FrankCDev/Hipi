// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	type Params,
	parseResult,
	type Snapshot,
	type ToolActivity,
	type ToolActivityPage,
	type ToolActivityTextPage,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import {
	ActivityTranscriptProvider,
	InlineMessageToolBlock,
	MessageActivitiesProvider,
	useActivityTranscriptProjection,
} from "../../src/features/tool-activities/activity-transcript.tsx";
import { MessageActivityOwner } from "../../src/features/tool-activities/message-activity-owner.tsx";
import { HistoricalTurnActivities } from "../../src/features/tool-activities/turn-activities.tsx";

const items: ToolActivity[] = [1, 2].map((id) => ({
	activityId: `task:${id}`,
	taskId: String(id),
	callId: "same-call",
	toolName: "hipi_files_read",
	source: "task",
	inherited: false,
	anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: id },
	phase: "terminal",
	toolResult: "success",
	abortRequested: false,
	receiptIds: [],
	textAvailable: true,
	outputTruncated: false,
}));
const calls: { method: Method; params: Params<Method>; signal?: AbortSignal }[] = [];
const pending: {
	resolve: (value: ToolActivityTextPage) => void;
	result: ToolActivityTextPage;
	signal?: AbortSignal;
}[] = [];
let deferred = false;
let deferMetadata = false;
let metadataPages: ToolActivityPage[] | undefined;
const metadataPending: { resolve: () => void; signal?: AbortSignal }[] = [];
const client: AppClient = {
	async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) {
		calls.push({ method, params, signal });
		if (method === "getToolActivities") {
			if (deferMetadata) await new Promise<void>((resolve) => metadataPending.push({ resolve, signal }));
			const queued = metadataPages?.shift();
			if (queued) return parseResult(method, queued);
			return parseResult(method, {
				items,
				nextCursor: null,
				coverage: "tasks",
				membershipFence: "f",
				...((params as Params<"getToolActivities">).selector?.kind === "tasks" ? { unavailableTaskIds: [] } : {}),
			});
		}
		const input = params as Params<"getToolActivityText">;
		const result: ToolActivityTextPage = {
			activityId: input.activityId,
			text: `${input.conversationId}:${input.activityId}`,
			nextCursor: null,
			retainedOutputOnly: true,
		};
		return parseResult(
			method,
			deferred
				? await new Promise<ToolActivityTextPage>((resolve) => pending.push({ resolve, result, signal }))
				: result,
		);
	},
	observe: async () => ({ dispose: async () => {} }),
};
vi.mock("../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
vi.mock("../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	calls.length = 0;
	pending.length = 0;
	deferred = false;
	deferMetadata = false;
	metadataPages = undefined;
	metadataPending.length = 0;
	host = document.createElement("div");
	host.className = "conversation-panel";
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	document.getSelection()?.removeAllRanges();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function render(conversationId = "c", indexes = [1, 2], connected = true) {
	await act(async () =>
		root.render(
			<ThemeProvider>
				<MessageActivityOwner scope={{ workspaceId: "w", conversationId }} connected={connected} messageId="1_0">
					{indexes
						.map((contentIndex, index) => ({ contentIndex, key: `slice-${index}` }))
						.map(({ contentIndex, key }) => (
							<HistoricalTurnActivities
								key={key}
								scope={{ workspaceId: "w", conversationId }}
								connected={connected}
								messageId="1_0"
								toolCalls={{ items: [{ callId: "same-call", name: "hipi_files_read", contentIndex }], total: 1 }}
								contentIndexes={[contentIndex]}
								expanded
								onToggle={() => {}}
							/>
						))}
				</MessageActivityOwner>
			</ThemeProvider>,
		),
	);
}
const reads = (method: Method) => calls.filter((call) => call.method === method);
async function resolveActiveOutputs() {
	const resolved = new Set<unknown>();
	while (true) {
		const read = pending.find((read) => !read.signal?.aborted && !resolved.has(read));
		if (!read) break;
		resolved.add(read);
		await act(async () => read.resolve(read.result));
	}
}
test("interleaved slices share one page and output reader, even with duplicate mounts and dialog leases", async () => {
	await render("c", [1, 2, 1]);
	assert.equal(reads("getToolActivities").length, 1);
	assert.deepEqual(reads("getToolActivities")[0]?.params, {
		workspaceId: "w",
		conversationId: "c",
		selector: { kind: "message", messageId: "1_0" },
	});
	assert.equal(reads("getToolActivityText").length, 2);
	const groups = host.querySelectorAll(".inline-activity");
	assert.match(groups[0]?.textContent ?? "", /c:task:1/);
	assert.doesNotMatch(groups[0]?.textContent ?? "", /c:task:2/);
	assert.match(groups[1]?.textContent ?? "", /c:task:2/);
	const detail = groups[2]?.querySelector<HTMLButtonElement>('[aria-label="Tool call details"]');
	assert.ok(detail);
	await act(async () => detail.click());
	assert.ok(document.querySelector('[role="dialog"] pre'));
	assert.equal(reads("getToolActivityText").length, 2);
	const close = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === "Close tool call details",
	);
	assert.ok(close);
	await act(async () => close.click());
	const first = groups[0]?.querySelector<HTMLButtonElement>(".activity-disclosure-toggle");
	assert.ok(first);
	await act(async () => first.click());
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	assert.equal(reads("getToolActivities").length, 1, "closing one slice does not cancel/requery siblings");
	await render("c", [1, 2]);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 1);
	assert.equal(reads("getToolActivityText").length, 2);
	await act(async () => first.click());
	assert.equal(reads("getToolActivityText").length, 3, "only released activity is read again");
	assert.equal(reads("getToolActivities").length, 1);
});
test("scope replacement without remount aborts pending output and rejects the late response", async () => {
	deferred = true;
	await render("old");
	assert.equal(pending.length, 1);
	await render("new");
	assert.equal(pending[0]?.signal?.aborted, true);
	await act(async () => pending[0]?.resolve(pending[0].result));
	assert.doesNotMatch(host.textContent ?? "", /old:task/);
	await resolveActiveOutputs();
	assert.match(host.textContent ?? "", /new:task:1/);
	assert.match(host.textContent ?? "", /new:task:2/);
	assert.equal(reads("getToolActivities").length, 2);
});
test("all slices collapsing aborts pending output; reopening restarts the single page lane", async () => {
	deferred = true;
	await render();
	const toggles = [...host.querySelectorAll<HTMLButtonElement>(".activity-disclosure-toggle")];
	await act(async () => {
		for (const toggle of toggles) toggle.click();
	});
	assert.equal(pending[0]?.signal?.aborted, true);
	await act(async () => pending[0]?.resolve(pending[0].result));
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0);
	await act(async () => {
		for (const toggle of toggles) toggle.click();
	});
	assert.equal(reads("getToolActivities").length, 2);
	await resolveActiveOutputs();
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
});
test("disconnect retains readable outputs and selection freezes all sibling outputs together", async () => {
	await render();
	const text = host.querySelector("pre.inline-tool-text");
	await render("c", [1, 2], false);
	assert.equal(host.querySelector("pre.inline-tool-text"), text);
	await render("c", [1, 2], true);
	assert.equal(reads("getToolActivityText").length, 2);
	deferred = true;
	await render("later");
	const name = host.querySelector(".inline-tool-result-name");
	assert.ok(name);
	const range = document.createRange();
	range.selectNodeContents(name);
	document.getSelection()?.addRange(range);
	await act(async () => pending[0]?.resolve(pending[0].result));
	await act(async () => pending[1]?.resolve(pending[1].result));
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	await resolveActiveOutputs();
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
});

async function renderPublic(conversationId = "public", showTools = true) {
	await act(async () =>
		root.render(
			<ThemeProvider>
				<ActivityTranscriptProvider scope={{ workspaceId: "w", conversationId }} connected running={false}>
					<MessageActivitiesProvider
						messageId="1_0"
						toolCalls={
							showTools
								? {
										items: items.map((item) => ({
											callId: item.callId,
											name: item.toolName,
											contentIndex: item.anchor?.contentIndex ?? 0,
										})),
										total: 2,
									}
								: undefined
						}
					>
						<p data-prose>Prefix remains mounted</p>
						{showTools && (
							<>
								<InlineMessageToolBlock contentIndexes={[1]} />
								<p>Middle</p>
								<InlineMessageToolBlock contentIndexes={[2]} />
							</>
						)}
					</MessageActivitiesProvider>
				</ActivityTranscriptProvider>
			</ThemeProvider>,
		),
	);
}
test("public slices share the message reader and keep independent cached manual disclosure across navigation", async () => {
	await renderPublic("public", false);
	const prose = host.querySelector("[data-prose]");
	await renderPublic();
	assert.equal(host.querySelector("[data-prose]"), prose);
	const toggles = [...host.querySelectorAll<HTMLButtonElement>(".activity-disclosure-toggle")];
	assert.equal(toggles.length, 2);
	assert.equal(toggles[0]?.getAttribute("aria-expanded"), "false");
	await act(async () => {
		toggles[0]?.click();
		toggles[1]?.click();
	});
	assert.equal(calls.filter((call) => call.method === "getToolActivities" && "selector" in call.params).length, 1);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	await act(async () => toggles[0]?.click());
	await renderPublic("elsewhere");
	await renderPublic();
	const restored = [...host.querySelectorAll<HTMLButtonElement>(".activity-disclosure-toggle")];
	assert.equal(restored[0]?.getAttribute("aria-expanded"), "false");
	assert.equal(restored[1]?.getAttribute("aria-expanded"), "true");
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 1);
});

test("late metadata from a replaced scope never creates leases or output reads", async () => {
	deferMetadata = true;
	await render("old");
	assert.equal(metadataPending.length, 1);
	await render("new");
	assert.equal(metadataPending[0]?.signal?.aborted, true);
	await act(async () => metadataPending[0]?.resolve());
	assert.equal(reads("getToolActivityText").length, 0);
	await act(async () => metadataPending[1]?.resolve());
	assert.equal(reads("getToolActivityText").length, 2);
	assert.doesNotMatch(host.textContent ?? "", /old:task/);
	assert.match(host.textContent ?? "", /new:task:1/);
	await act(async () => root.render(<ThemeProvider>{null}</ThemeProvider>));
	assert.equal(host.querySelectorAll("pre").length, 0);
});

function LiveSlices({ snapshot }: { snapshot: Snapshot }) {
	useActivityTranscriptProjection(snapshot, true);
	return (
		<>
			{snapshot.messages.map((message) => (
				<MessageActivitiesProvider key={message.id} messageId={message.id} toolCalls={message.toolCalls}>
					<InlineMessageToolBlock contentIndexes={[1]} />
					<p>Between tools</p>
					<InlineMessageToolBlock contentIndexes={[2]} />
				</MessageActivitiesProvider>
			))}
		</>
	);
}
test("live interleaved slices reuse the exact task owner, not same-call IDs in another model round", async () => {
	const toolCalls = {
		items: items.map((item) => ({
			callId: item.callId,
			name: item.toolName,
			contentIndex: item.anchor?.contentIndex ?? 0,
		})),
		total: 2,
	};
	const snapshot: Snapshot = {
		workspaceId: "w",
		conversationId: "live",
		messages: ["1_0", "1_1"].map((id) => ({
			id,
			role: "assistant",
			text: "",
			textLength: 0,
			truncated: false,
			toolCalls,
		})),
		partial: "",
		partialLength: 0,
		partialTruncated: false,
		running: true,
		historyCursor: null,
		execution: {
			ownerTaskId: "8",
			submissionIds: ["7"],
			submissionCount: 1,
			blockingCompactionCount: 0,
			tools: {
				items: items.map((item) => ({ taskId: item.taskId, callId: item.callId, name: item.toolName, status: "done" })),
				total: 2,
				active: 0,
			},
		},
	};
	await act(async () =>
		root.render(
			<ThemeProvider>
				<ActivityTranscriptProvider scope={{ workspaceId: "w", conversationId: "live" }} connected running>
					<LiveSlices snapshot={snapshot} />
				</ActivityTranscriptProvider>
			</ThemeProvider>,
		),
	);
	assert.equal(
		calls.filter(
			(call) =>
				call.method === "getToolActivities" && "selector" in call.params && call.params.selector?.kind === "tasks",
		).length,
		1,
	);
	assert.equal(
		calls.filter(
			(call) =>
				call.method === "getToolActivities" && "selector" in call.params && call.params.selector?.kind === "message",
		).length,
		0,
	);
	assert.equal(reads("getToolActivityText").length, 2);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	const other = [...host.querySelectorAll('[data-activity-message-id="1_1"] button.activity-disclosure-toggle')];
	assert.equal(other.length, 2);
	for (const button of other) assert.equal(button.getAttribute("aria-expanded"), "false");
	const first = host.querySelector<HTMLButtonElement>(
		'[data-activity-message-id="1_0"] button.activity-disclosure-toggle',
	);
	assert.ok(first);
	await act(async () => first.click());
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 1);
	assert.equal(reads("getToolActivityText").length, 2);
});

test("one message owner switches an omitted scrolling fallback back to complete canonical slices", async () => {
	const first = items[0];
	assert.ok(first);
	const many = Array.from({ length: 17 }, (_, index) => ({
		...first,
		activityId: `task:${index}`,
		taskId: String(index),
		textAvailable: false,
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: index },
	}));
	metadataPages = [
		{ items: many.slice(0, 16), nextCursor: "rest", coverage: "tasks", membershipFence: "f" },
		{ items: many.slice(16), nextCursor: null, coverage: "tasks", membershipFence: "f" },
	];
	function Frame({ omitted }: { omitted: boolean }) {
		return (
			<ThemeProvider>
				<MessageActivityOwner scope={{ workspaceId: "w", conversationId: "c" }} connected messageId="1_0">
					<HistoricalTurnActivities
						scope={{ workspaceId: "w", conversationId: "c" }}
						connected
						messageId="1_0"
						toolCalls={{
							items: (omitted ? many.slice(0, 16) : items).map((item) => ({
								callId: item.callId,
								name: item.toolName,
								contentIndex: item.anchor?.contentIndex ?? 0,
							})),
							total: omitted ? 17 : 2,
						}}
						contentIndexes={omitted ? undefined : [1, 2]}
						expanded
						onToggle={() => {}}
					/>
				</MessageActivityOwner>
			</ThemeProvider>
		);
	}
	await act(async () => root.render(<Frame omitted />));
	assert.equal(reads("getToolActivities").length, 1);
	const viewport = host.querySelector("[data-activity-history-window]");
	assert.ok(viewport);
	await act(async () => {
		viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	assert.equal(reads("getToolActivities").length, 2);
	assert.equal(host.querySelectorAll("[data-history-record]").length, 17);
	await act(async () => root.render(<Frame omitted={false} />));
	assert.equal(reads("getToolActivities").length, 3);
	assert.equal(host.querySelector("[data-activity-history-window]"), null);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	for (const call of reads("getToolActivities"))
		assert.deepEqual((call.params as Params<"getToolActivities">).selector, { kind: "message", messageId: "1_0" });
});
