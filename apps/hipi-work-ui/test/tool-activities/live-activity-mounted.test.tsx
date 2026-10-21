// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	type Params,
	parseResult,
	type Snapshot,
	type ToolActivity,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import {
	ActivityTranscriptProvider,
	InlineLiveActivities,
	InlineMessageActivities,
	useActivityTranscriptProjection,
	usePresentedToolActivity,
} from "../../src/features/tool-activities/activity-transcript.tsx";

const scope = { workspaceId: "w", conversationId: "c" };
const item: ToolActivity = {
	activityId: "task:9",
	taskId: "9",
	callId: "same",
	toolName: "hipi_files_read",
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
const calls: Params<"getToolActivities">[] = [];
let unavailable = false;
let deferExact = false;
let releaseExact: (() => void) | undefined;
const panel = { current: null as HTMLElement | null };
let client: AppClient = {
	call: async <M extends Method>(method: M, params: Params<M>) => {
		assert.equal(method, "getToolActivities");
		const input = params as Params<"getToolActivities">;
		calls.push(input);
		if (input.selector?.kind === "tasks" && deferExact)
			await new Promise<void>((resolve) => {
				releaseExact = resolve;
			});
		return parseResult(method, {
			items: unavailable ? [] : [item],
			nextCursor: null,
			coverage: "tasks",
			membershipFence: "f",
			...(input.selector?.kind === "tasks" ? { unavailableTaskIds: unavailable ? ["9"] : [] } : {}),
		});
	},
	observe: async () => ({ dispose: async () => {} }),
};
vi.mock("../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
vi.mock("../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
const snapshot: Snapshot = {
	...scope,
	messages: [
		{
			id: "1_0",
			role: "assistant",
			text: "",
			textLength: 0,
			truncated: false,
			toolCalls: { items: [{ callId: "same", name: "hipi_files_read", contentIndex: 1 }], total: 1 },
			publicBlocks: { items: [{ kind: "tool", contentIndex: 1 }], total: 1, omitted: false },
		},
		{
			id: "2_0",
			role: "assistant",
			text: "",
			textLength: 0,
			truncated: false,
			toolCalls: { items: [{ callId: "same", name: "hipi_files_read", contentIndex: 1 }], total: 1 },
			publicBlocks: { items: [{ kind: "tool", contentIndex: 1 }], total: 1, omitted: false },
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
		tools: {
			items: [{ taskId: "9", callId: "same", name: "hipi_files_read", status: "running" }],
			total: 1,
			active: 1,
		},
		blockingCompactionCount: 0,
	},
};
let mountTools = true;
function PresentationStatus() {
	const visible = usePresentedToolActivity();
	return <output data-tool-presented={String(visible)} />;
}
function Transcript({ value, connected }: { value: Snapshot; connected: boolean }) {
	useActivityTranscriptProjection(value, value.running && connected);
	return (
		<>
			<PresentationStatus />
			{mountTools && (
				<>
					{value.messages.map((message) => (
						<InlineMessageActivities key={message.id} messageId={message.id} toolCalls={message.toolCalls} />
					))}
					<InlineLiveActivities snapshot={value} active={value.running && connected} />
				</>
			)}
		</>
	);
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	client = { ...client };
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	calls.length = 0;
	mountTools = true;
	unavailable = false;
	deferExact = false;
	releaseExact = undefined;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	panel.current = host;
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
async function render(value: Snapshot, connected = true) {
	await act(async () =>
		root.render(
			<ThemeProvider>
				<ActivityTranscriptProvider scope={scope} connected={connected} running={value.running} rootRef={panel}>
					<Transcript value={value} connected={connected} />
				</ActivityTranscriptProvider>
			</ThemeProvider>,
		),
	);
}
test("one exact live owner attaches only the current anchored row, then hands over to retained summary", async () => {
	await render(snapshot);
	assert.equal(calls.filter((call) => call.selector?.kind === "tasks").length, 1);
	assert.equal(
		calls.filter((call) => call.selector?.kind === "message").length,
		0,
		"anchored expanded row reuses exact owner",
	);
	assert.equal(host.querySelector(".activity-live-slots"), null, "no duplicate tail after anchored association");
	assert.equal(host.querySelector('[data-activity-message-id="1_0"] button')?.getAttribute("aria-expanded"), "false");
	const toggle = host.querySelector<HTMLButtonElement>('[data-activity-message-id="2_0"] button');
	assert.ok(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "false", "live metadata must not open the group");
	assert.equal(host.querySelectorAll(".inline-tool-result").length, 0);
	await act(async () => toggle.click());
	assert.equal(host.querySelectorAll(".inline-tool-result").length, 1);
	// Explicit expansion opens this row after mount. Flush its opening RAF, then
	// Motion, so completion exercises closing rather than unopened cancellation.
	await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
	await render({ ...snapshot, running: false, execution: undefined });
	assert.equal(host.querySelectorAll("[data-activity-message-id]").length, 2);
	assert.equal(toggle.getAttribute("aria-expanded"), "true", "completion retains the explicit choice");
	await act(async () => toggle.click());
	assert.equal(host.querySelector('[data-activity-message-id="2_0"] button')?.getAttribute("aria-expanded"), "false");
	const closing = host.querySelector('[data-activity-message-id="2_0"] .activity-disclosure-body');
	assert.ok(closing);
	assert.equal(closing.hasAttribute("inert"), true);
	assert.equal(closing.getAttribute("aria-hidden"), "true");
	assert.equal(host.querySelectorAll(".inline-tool-result").length, 1, "closing retains its single detail subtree");
	await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
	assert.equal(host.querySelector('[data-activity-message-id="2_0"] .activity-disclosure-body'), null);
	assert.equal(host.querySelectorAll(".inline-tool-result").length, 0);
});
test("off-page and unavailable exact records stay in the tail rather than matching an old same-callId row", async () => {
	await render({ ...snapshot, messages: snapshot.messages.filter((message) => message.id !== "2_0") });
	const tail = host.querySelector<HTMLButtonElement>(".inline-activity:not([data-activity-message-id]) > button");
	assert.ok(tail);
	assert.equal(tail.getAttribute("aria-expanded"), "false");
	await act(async () => tail.click());
	assert.ok(host.querySelector(".activity-live-slots"));
	assert.equal(host.querySelector('[data-activity-message-id="1_0"] button')?.getAttribute("aria-expanded"), "false");
	await render({ ...snapshot, running: false, execution: undefined });
	unavailable = true;
	assert.ok(snapshot.execution);
	await render({ ...snapshot, execution: { ...snapshot.execution, ownerTaskId: "new" } });
	const unavailableTail = host.querySelector<HTMLButtonElement>(
		".inline-activity:not([data-activity-message-id]) > button",
	);
	assert.ok(unavailableTail);
	await act(async () => unavailableTail.click());
	assert.ok(host.querySelector(".activity-live-slots"));
	assert.match(host.textContent ?? "", /Execution state unavailable/);
});
test("explicit disclosure intent survives completion and transfers to one selector-scoped history reader", async () => {
	await render(snapshot);
	const toggle = host.querySelector<HTMLButtonElement>('[data-activity-message-id="2_0"] > button');
	assert.ok(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	await act(async () => toggle.click());
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	await render({ ...snapshot, running: false, execution: undefined });
	assert.equal(host.querySelector('[data-activity-message-id="2_0"] > button')?.getAttribute("aria-expanded"), "true");
	assert.equal(calls.filter((call) => call.selector?.kind === "message").length, 1);
	assert.equal(host.querySelectorAll(".inline-tool-result").length, 1);
	assert.equal(host.querySelector(".activity-live-slots"), null);
});

test("late exact metadata waits for selection release before moving a live tool into its historical row", async () => {
	deferExact = true;
	await render(snapshot);
	const tail = host.querySelector<HTMLButtonElement>(".inline-activity:not([data-activity-message-id]) > button");
	assert.ok(tail);
	await act(async () => tail.click());
	const selected = host.querySelector(".activity-live-slots span");
	assert.ok(selected);
	const range = document.createRange();
	range.selectNodeContents(selected);
	document.getSelection()?.addRange(range);
	await act(async () => document.dispatchEvent(new Event("selectionchange")));
	assert.ok(releaseExact);
	await act(async () => releaseExact?.());
	assert.equal(selected.isConnected, true);
	assert.ok(host.querySelector(".activity-live-slots"));
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(host.querySelector(".activity-live-slots"), null);
	assert.equal(host.querySelector('[data-activity-message-id="2_0"] button')?.getAttribute("aria-expanded"), "false");
});
test("transient disconnect stops live decoration but retains the exact same readable tool evidence", async () => {
	await render(snapshot);
	const toggle = host.querySelector<HTMLButtonElement>('[data-activity-message-id="2_0"] button');
	assert.ok(toggle);
	await act(async () => toggle.click());
	const article = host.querySelector(".inline-tool-result");
	assert.ok(article);
	await render(snapshot, false);
	assert.equal(host.querySelector(".inline-tool-result"), article);
	assert.match(host.textContent ?? "", /Last read/);
	assert.match(host.textContent ?? "", /Disconnected/);
	assert.equal(host.querySelector(".activity-live-slots"), null);
});

test("round anchor places a not-yet-instantiated tool once, without a speculative historical reader", async () => {
	assert.ok(snapshot.execution);
	const value: Snapshot = {
		...snapshot,
		execution: {
			...snapshot.execution,
			tools: {
				...snapshot.execution.tools,
				items: [{ callId: "same", name: "hipi_files_read", status: "pending", anchor: item.anchor }],
			},
		},
	};
	await render(value);
	const current = host.querySelector('[data-activity-message-id="2_0"]');
	assert.ok(current);
	const toggle = current.querySelector<HTMLButtonElement>("button");
	assert.ok(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	await act(async () => toggle.click());
	assert.ok(current.querySelector(".activity-live-slots"));
	assert.equal(host.querySelectorAll(".activity-live-slots").length, 1);
	assert.equal(calls.filter((call) => !!call.selector).length, 0);
	assert.equal(host.querySelector('[data-activity-message-id="1_0"] button')?.getAttribute("aria-expanded"), "false");
	assert.match(current.textContent ?? "", /Pending/);
});
test("authoritative round anchor retains unavailable exact detail in the committed row, not a duplicate tail", async () => {
	unavailable = true;
	assert.ok(snapshot.execution);
	await render({
		...snapshot,
		execution: {
			...snapshot.execution,
			tools: {
				...snapshot.execution.tools,
				items: [{ taskId: "9", callId: "same", name: "hipi_files_read", status: "running", anchor: item.anchor }],
			},
		},
	});
	const current = host.querySelector('[data-activity-message-id="2_0"]');
	assert.ok(current);
	const toggle = current.querySelector<HTMLButtonElement>("button");
	assert.ok(toggle);
	await act(async () => toggle.click());
	assert.ok(current.querySelector(".activity-live-slots"));
	assert.equal(host.querySelectorAll(".activity-live-slots").length, 1);
	assert.equal(calls.filter((call) => call.selector?.kind === "message").length, 0);
	assert.match(current.textContent ?? "", /Execution state unavailable/);
});

test("mounted tool presentation leases survive folded summaries but not unmount, completion, disconnect or new generations", async () => {
	const presented = () => host.querySelector("[data-tool-presented]")?.getAttribute("data-tool-presented");
	await render(snapshot);
	assert.equal(presented(), "true");
	const toggle = host.querySelector<HTMLButtonElement>('[data-activity-message-id="2_0"] button');
	assert.ok(toggle);
	await act(async () => toggle.click());
	assert.equal(presented(), "true");
	mountTools = false;
	await render(snapshot);
	assert.equal(presented(), "false");
	mountTools = true;
	await render(snapshot);
	assert.equal(presented(), "true");
	await render(snapshot, false);
	assert.equal(presented(), "false");
	assert.ok(snapshot.execution);
	await render({
		...snapshot,
		execution: {
			...snapshot.execution,
			tools: {
				...snapshot.execution.tools,
				items: snapshot.execution.tools.items.map((tool) => ({ ...tool, status: "done" })),
				active: 0,
			},
		},
	});
	assert.equal(presented(), "false", "old running metadata must not suppress a newer all-done snapshot");
	await render({
		...snapshot,
		execution: { ...snapshot.execution, ownerTaskId: "next", tools: { items: [], total: 0, active: 0 } },
	});
	assert.equal(presented(), "false");
	await render({ ...snapshot, running: false, execution: undefined });
	assert.equal(presented(), "false");
});

test("following text or incomplete ordering removes the current tool claim even while its task is running", async () => {
	const presented = () => host.querySelector("[data-tool-presented]")?.getAttribute("data-tool-presented");
	await render(snapshot);
	assert.equal(presented(), "true");
	await render({ ...snapshot, partial: "Following text", partialLength: 14 });
	assert.equal(presented(), "false");
	assert.equal(host.querySelector('[data-activity-message-id="2_0"] .inline-activity-phase'), null);
	await render(snapshot);
	assert.equal(presented(), "true");
	await render({
		...snapshot,
		messages: [...snapshot.messages, { id: "3_0", role: "assistant", text: "Final", textLength: 5, truncated: false }],
	});
	assert.equal(presented(), "false");
	await render({
		...snapshot,
		messages: snapshot.messages.map((message) => ({ ...message, publicBlocks: undefined })),
	});
	assert.equal(presented(), "false");
});

test("an explicit expansion choice survives active remount and completion without reopening a closed group", async () => {
	await render(snapshot);
	const toggle = host.querySelector<HTMLButtonElement>('[data-activity-message-id="2_0"] button');
	assert.ok(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	await act(async () => toggle.click());
	mountTools = false;
	await render(snapshot);
	mountTools = true;
	await render(snapshot);
	const restored = host.querySelector<HTMLButtonElement>('[data-activity-message-id="2_0"] button');
	assert.ok(restored);
	assert.equal(restored.getAttribute("aria-expanded"), "true");
	await act(async () => restored.click());
	await render({ ...snapshot, running: false, execution: undefined });
	assert.equal(restored.getAttribute("aria-expanded"), "false");
	await render(snapshot);
	assert.equal(restored.getAttribute("aria-expanded"), "false");
});
