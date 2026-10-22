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
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { ActivitySession } from "../../src/features/tool-activities/activity-session.ts";
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
	await openResults();
}
async function openResults() {
	await act(async () => {
		for (const toggle of host.querySelectorAll<HTMLButtonElement>('.inline-tool-result-toggle[aria-expanded="false"]'))
			toggle.click();
	});
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
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 3, "closing retains the sole painted subtree");
	assert.equal(groups[0]?.querySelector(".activity-disclosure-body")?.hasAttribute("inert"), true);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	assert.equal(reads("getToolActivities").length, 1, "closing one slice does not cancel/requery siblings");
	await render("c", [1, 2]);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 1);
	assert.equal(reads("getToolActivityText").length, 2);
	await act(async () => first.click());
	assert.equal(reads("getToolActivityText").length, 2, "remounted individual remains closed until requested");
	await openResults();
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
test("completed slice collapse aborts pending output; reversal retains it and reopening restarts one page lane", async () => {
	deferred = true;
	await render();
	const toggles = [...host.querySelectorAll<HTMLButtonElement>(".activity-disclosure-toggle")];
	const bodies = [...host.querySelectorAll(".activity-disclosure-body")];
	await act(async () => {
		for (const toggle of toggles) toggle.click();
	});
	assert.equal(pending[0]?.signal?.aborted, false, "closing has not released the shared reader");
	for (const body of bodies) assert.equal(body.hasAttribute("inert"), true);
	await act(async () => {
		for (const toggle of toggles) toggle.click();
	});
	for (const [index, body] of bodies.entries()) {
		assert.ok(host.querySelectorAll(".activity-disclosure-body")[index] === body);
		assert.equal(body.hasAttribute("inert"), false);
	}
	assert.equal(pending[0]?.signal?.aborted, false);
	assert.equal(reads("getToolActivities").length, 1);
	assert.equal(reads("getToolActivityText").length, 1, "reversal does not create another pending output read");
	await act(async () => {
		for (const toggle of toggles) toggle.click();
	});
	await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
	assert.equal(pending[0]?.signal?.aborted, true);
	await act(async () => pending[0]?.resolve(pending[0].result));
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0);
	await act(async () => {
		for (const toggle of toggles) toggle.click();
	});
	assert.equal(reads("getToolActivities").length, 2);
	await openResults();
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
	await openResults();
	assert.equal(calls.filter((call) => call.method === "getToolActivities" && "selector" in call.params).length, 1);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	await act(async () => toggles[0]?.click());
	await renderPublic("elsewhere");
	await renderPublic();
	const restored = [...host.querySelectorAll<HTMLButtonElement>(".activity-disclosure-toggle")];
	assert.equal(restored[0]?.getAttribute("aria-expanded"), "false");
	assert.equal(restored[1]?.getAttribute("aria-expanded"), "true");
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0, "individual choice is mount-local");
	await openResults();
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
	assert.equal(reads("getToolActivityText").length, 0, "late metadata alone does not demand output");
	await openResults();
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
	const current = [
		...host.querySelectorAll<HTMLButtonElement>('[data-activity-message-id="1_0"] button.activity-disclosure-toggle'),
	];
	assert.equal(current.length, 2);
	assert.equal(reads("getToolActivityText").length, 0, "default-closed groups do not acquire output leases");
	for (const button of current) assert.equal(button.getAttribute("aria-expanded"), "false");
	await act(async () => {
		for (const button of current) button.click();
	});
	assert.equal(reads("getToolActivityText").length, 0);
	await openResults();
	assert.equal(reads("getToolActivityText").length, 2);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	const other = [...host.querySelectorAll('[data-activity-message-id="1_1"] button.activity-disclosure-toggle')];
	assert.equal(other.length, 2);
	for (const button of other) assert.equal(button.getAttribute("aria-expanded"), "false");
	// Explicit expansion opens the matching slices after mount. Flush their opening RAF,
	// then Motion, so this exercises closing rather than pre-frame cancellation.
	await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
	const first = host.querySelector<HTMLButtonElement>(
		'[data-activity-message-id="1_0"] button.activity-disclosure-toggle',
	);
	assert.ok(first);
	await act(async () => first.click());
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	assert.equal(first.parentElement?.querySelector(".activity-disclosure-body")?.hasAttribute("inert"), true);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 1);
	assert.equal(reads("getToolActivityText").length, 2);
});

test("hydrating an interspersed live slot preserves sibling output leases and an open details dialog", async () => {
	const first = items[0];
	const second = items[1];
	assert.ok(first && second);
	const third: ToolActivity = {
		...second,
		activityId: "task:3",
		taskId: "3",
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 3 },
	};
	const records = [first, second, third];
	const scope = { workspaceId: "w", conversationId: "c" };
	const session = new ActivitySession(client, scope, { kind: "tasks", taskIds: ["1", "2", "3"] });
	metadataPages = [
		{ items: [third, first], nextCursor: null, coverage: "tasks", membershipFence: "f", unavailableTaskIds: ["2"] },
		{
			items: [second, third, first],
			nextCursor: null,
			coverage: "tasks",
			membershipFence: "f",
			unavailableTaskIds: [],
		},
	];
	function Frame() {
		const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
		const live = { session, state, active: true };
		return (
			<ThemeProvider>
				<MessageActivityOwner scope={scope} connected messageId="1_0" live={live}>
					<HistoricalTurnActivities
						scope={scope}
						connected
						messageId="1_0"
						expanded
						onToggle={() => {}}
						toolCalls={{
							items: records.map((record) => ({
								callId: record.callId,
								name: record.toolName,
								contentIndex: record.anchor?.contentIndex ?? 0,
							})),
							total: 3,
						}}
						live={live}
						liveItems={state.page?.items ?? []}
						liveTools={records.map((record) => ({
							taskId: record.taskId,
							callId: record.callId,
							name: record.toolName,
							anchor: record.anchor,
							status: "running",
						}))}
					/>
				</MessageActivityOwner>
			</ThemeProvider>
		);
	}
	session.activate();
	try {
		await session.page();
		await act(async () => root.render(<Frame />));
		await openResults();
		const cards = [...host.querySelectorAll(".inline-tool-result")];
		const outputs = [...host.querySelectorAll("pre.inline-tool-text")];
		assert.equal(outputs.length, 2);
		const rows = [...host.querySelectorAll(".inline-activity-records > section, .inline-activity-records > ul")];
		assert.ok(rows[0] === cards[0] && rows[1]?.matches(".activity-live-slots") && rows[2] === cards[1]);
		const details = cards[0]?.querySelector<HTMLButtonElement>('[aria-label="Tool call details"]');
		assert.ok(details);
		await act(async () => details.click());
		const dialog = document.querySelector('[role="dialog"]');
		const dialogOutput = dialog?.querySelector("pre");
		assert.ok(dialog && dialogOutput);
		assert.equal(reads("getToolActivityText").length, 2);
		await act(async () => session.page());
		assert.ok(document.querySelector('[role="dialog"]') === dialog);
		assert.ok(dialog.querySelector("pre") === dialogOutput);
		const hydrated = [...host.querySelectorAll(".inline-tool-result")];
		assert.ok(hydrated[0] === cards[0] && hydrated[2] === cards[1]);
		assert.ok(host.querySelectorAll("pre.inline-tool-text")[0] === outputs[0]);
		assert.ok(host.querySelectorAll("pre.inline-tool-text")[1] === outputs[1]);
		assert.equal(hydrated[0]?.querySelector("button")?.getAttribute("aria-expanded"), "true");
		assert.equal(hydrated[1]?.querySelector("button")?.getAttribute("aria-expanded"), "false");
		assert.equal(hydrated[2]?.querySelector("button")?.getAttribute("aria-expanded"), "true");
		assert.equal(
			reads("getToolActivityText").length,
			2,
			"sibling hydration neither rereads outputs nor reads the newly closed result",
		);
		assert.equal(
			reads("getToolActivities").length,
			2,
			"only the two explicit exact reads ran, with no historical reader",
		);
	} finally {
		await act(async () => root.render(<ThemeProvider>{null}</ThemeProvider>));
		session.dispose();
	}
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
	await openResults();
	assert.equal(reads("getToolActivities").length, 3);
	assert.equal(host.querySelector("[data-activity-history-window]"), null);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	for (const call of reads("getToolActivities"))
		assert.deepEqual((call.params as Params<"getToolActivities">).selector, { kind: "message", messageId: "1_0" });
});
