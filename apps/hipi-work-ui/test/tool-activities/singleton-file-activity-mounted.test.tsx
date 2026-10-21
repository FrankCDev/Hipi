// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	type Params,
	parseResult,
	type ToolActivity,
	type ToolActivityPage,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { ActivitySession } from "../../src/features/tool-activities/activity-session.ts";
import {
	ActivityTranscriptProvider,
	InlineMessageToolBlock,
	MessageActivitiesProvider,
} from "../../src/features/tool-activities/activity-transcript.tsx";
import type { LiveActivityRead, LiveTool } from "../../src/features/tool-activities/live-activity.ts";
import { MessageActivityOwner } from "../../src/features/tool-activities/message-activity-owner.tsx";
import { HistoricalTurnActivities } from "../../src/features/tool-activities/turn-activities.tsx";

const base: ToolActivity = {
	activityId: "task:2",
	taskId: "2",
	callId: "read",
	toolName: "hipi_files_read",
	source: "task",
	inherited: false,
	anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 1 },
	resultEntryId: "3",
	phase: "terminal",
	outcome: "completed",
	toolResult: "success",
	abortRequested: false,
	receiptIds: [],
	textAvailable: true,
	outputTruncated: false,
	fileSummary: { version: 1, kind: "read", target: { rootId: "root", path: "src/example.ts" }, partial: false },
};
const calls: { method: Method; params: Params<Method>; signal?: AbortSignal }[] = [];
const pending: { resolve: () => void; signal?: AbortSignal }[] = [];
let items: ToolActivity[];
let deferMetadata = false;
let failMetadata = false;
let nextCursor: string | null = null;
let deferText = false;
const pendingText: { resolve: () => void; signal?: AbortSignal }[] = [];
const opened: string[] = [];
const client: AppClient = {
	async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) {
		calls.push({ method, params, signal });
		if (method === "getToolActivities") {
			const page: ToolActivityPage = {
				items,
				nextCursor,
				coverage: "tasks",
				membershipFence: "f",
				...((params as Params<"getToolActivities">).selector?.kind === "tasks" ? { unavailableTaskIds: [] } : {}),
			};
			if (deferMetadata) await new Promise<void>((resolve) => pending.push({ resolve, signal }));
			if (failMetadata) throw new Error("Metadata unavailable");
			return parseResult(method, page);
		}
		assert.equal(method, "getToolActivityText");
		if (deferText) await new Promise<void>((resolve) => pendingText.push({ resolve, signal }));
		return parseResult(method, {
			activityId: (params as Params<"getToolActivityText">).activityId,
			text: "private raw output",
			nextCursor: null,
			retainedOutputOnly: true,
		});
	},
	observe: async () => ({ dispose: async () => {} }),
};
vi.mock("../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
vi.mock("../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
const observers = new Set<ViewportObserver>();
class ViewportObserver {
	readonly targets = new Set<Element>();
	constructor(private callback: IntersectionObserverCallback) {
		observers.add(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		observers.delete(this);
	}
	enter(visible: boolean, headersOnly = false) {
		this.callback(
			[...this.targets]
				.filter((target) => !headersOnly || target.hasAttribute("data-file-activity-unit"))
				.map((target) => ({ target, isIntersecting: visible }) as IntersectionObserverEntry),
			this as unknown as IntersectionObserver,
		);
	}
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("IntersectionObserver", ViewportObserver);
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	items = [structuredClone(base)];
	calls.length = 0;
	pending.length = 0;
	deferMetadata = false;
	failMetadata = false;
	nextCursor = null;
	deferText = false;
	pendingText.length = 0;
	opened.length = 0;
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
type Options = {
	conversationId?: string;
	connected?: boolean;
	expanded?: boolean;
	manualChoice?: boolean;
	live?: LiveActivityRead;
	liveTools?: LiveTool[];
	indexes?: number[];
	name?: string;
	callId?: string;
};
async function render({
	conversationId = "c",
	connected = true,
	expanded = false,
	manualChoice,
	live,
	liveTools,
	indexes = [1],
	name = "hipi_files_read",
	callId = "read",
}: Options = {}) {
	await act(async () =>
		root.render(
			<ThemeProvider>
				<MessageActivityOwner
					scope={{ workspaceId: "w", conversationId }}
					connected={connected}
					messageId="1_0"
					live={live}
				>
					{indexes
						.map((contentIndex, index) => ({ contentIndex, key: `slice-${index}` }))
						.map(({ contentIndex, key }) => (
							<HistoricalTurnActivities
								key={key}
								scope={{ workspaceId: "w", conversationId }}
								connected={connected}
								messageId="1_0"
								toolCalls={{ items: [{ contentIndex, callId, name }], total: 1 }}
								contentIndexes={[contentIndex]}
								expanded={expanded}
								manualChoice={manualChoice}
								onToggle={() => {}}
								onOpenArtifact={(artifact) => opened.push(artifact.path)}
								live={live}
								liveTools={liveTools}
								liveItems={live?.state.page?.items}
							/>
						))}
				</MessageActivityOwner>
			</ThemeProvider>,
		),
	);
}
async function visible(value = true, headersOnly = false) {
	await act(async () => {
		for (const observer of [...observers]) observer.enter(value, headersOnly);
	});
}
const reads = (method: Method) => calls.filter((call) => call.method === method);
function button(label: string, target: ParentNode = host) {
	const value = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent === label || item.getAttribute("aria-label") === label,
	);
	assert.ok(value, label);
	return value;
}
function compact() {
	return host.querySelector("[data-file-activity-unit] > .inline-file-activity");
}

test("visible proven singleton becomes a standalone compact row with metadata only; dialog shares the reader", async () => {
	await render();
	assert.equal(calls.length, 0);
	assert.ok(host.querySelector(".activity-disclosure-toggle"));
	await visible();
	assert.equal(reads("getToolActivities").length, 1);
	assert.equal(reads("getToolActivityText").length, 0);
	assert.ok(compact());
	assert.equal(host.querySelector(".activity-disclosure-toggle") === null, true);
	assert.match(host.textContent ?? "", /Read file.*src\/example.ts/);
	assert.equal(host.querySelector("pre") === null, true);
	await act(async () => button("Tool call details").click());
	assert.equal(reads("getToolActivities").length, 1);
	assert.equal(reads("getToolActivityText").length, 1);
	assert.match(document.querySelector('[role="dialog"] pre')?.textContent ?? "", /private raw output/);
	await visible(false);
	assert.ok(document.querySelector('[role="dialog"]'));
	assert.equal(reads("getToolActivityText").length, 1);
	await act(async () => button("Close tool call details", document).click());
	assert.equal(document.querySelector('[role="dialog"]') === null, true);
	assert.ok(compact());
});
test("interleaved visible file headers share one bounded message metadata lease and no output reads", async () => {
	items.push({
		...structuredClone(base),
		activityId: "task:4",
		taskId: "4",
		resultEntryId: "5",
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 3 },
	});
	await render({ indexes: [1, 3, 1] });
	await visible();
	assert.equal(reads("getToolActivities").length, 1);
	assert.equal(host.querySelectorAll(".inline-file-activity").length, 3);
	assert.equal(reads("getToolActivityText").length, 0);
});
test("unknown, missing and mismatched metadata never manufactures a successful file header", async () => {
	for (const options of [{ name: "other" }, { callId: "different" }, {}]) {
		await render(options);
		await visible();
		if (!options.name && !options.callId) {
			await render({ conversationId: "next", callId: "different" });
			await visible();
		}
		assert.equal(compact() === null, true);
	}
	assert.equal(reads("getToolActivityText").length, 0);
});
test("selection and keyboard focus hold the existing closed header until safe promotion", async () => {
	deferMetadata = true;
	await render();
	await visible();
	const toggle = host.querySelector<HTMLButtonElement>(".activity-disclosure-toggle");
	assert.ok(toggle);
	await act(async () => toggle.focus());
	await act(async () => pending[0]?.resolve());
	assert.equal(compact() === null, true);
	assert.equal(document.activeElement === toggle, true);
	const selected = document.createElement("p");
	selected.textContent = "Selected conversation text";
	host.append(selected);
	await act(async () => {
		toggle.blur();
		const range = document.createRange();
		range.selectNodeContents(selected);
		document.getSelection()?.removeAllRanges();
		document.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(document.getSelection()?.isCollapsed, false);
	assert.equal(compact() === null, true);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.ok(compact());
});
test("explicit persisted choices and an already open group remain disclosures after metadata resolves", async () => {
	for (const options of [{ manualChoice: false }, { manualChoice: true }, { expanded: true }]) {
		await render(options);
		await visible();
		assert.equal(compact() === null, true);
		assert.ok(host.querySelector(".activity-disclosure-toggle"));
	}
});
test("offscreen and scope replacement abort header metadata and ignore late proof", async () => {
	deferMetadata = true;
	await render();
	await visible();
	assert.equal(pending.length, 1);
	await visible(false);
	assert.equal(pending[0]?.signal?.aborted, true);
	await act(async () => pending[0]?.resolve());
	assert.equal(compact() === null, true);
	await visible();
	assert.equal(pending.length, 2);
	await render({ conversationId: "new" });
	assert.equal(pending[1]?.signal?.aborted, true);
	await act(async () => pending[1]?.resolve());
	assert.equal(compact() === null, true);
	await act(async () => pending.at(-1)?.resolve());
	assert.ok(compact());
});
test("exact live proof uses no historical request and retains its header through historical handoff", async () => {
	const session = new ActivitySession(
		client,
		{ workspaceId: "w", conversationId: "c" },
		{ kind: "tasks", taskIds: ["2"] },
		new Map([["2", "read"]]),
	);
	session.activate();
	await session.page();
	const live: LiveActivityRead = { session, state: session.snapshot(), active: true };
	const liveTools: LiveTool[] = [
		{ taskId: "2", callId: "read", name: "hipi_files_read", status: "done", anchor: base.anchor },
	];
	await render({ live, liveTools });
	await visible();
	assert.ok(compact());
	assert.equal(reads("getToolActivities").length, 1);
	assert.equal(reads("getToolActivityText").length, 0);
	const row = compact();
	deferMetadata = true;
	await render();
	assert.equal(compact() === row, true);
	assert.equal(reads("getToolActivities").length, 2);
	assert.equal(reads("getToolActivityText").length, 0);
	await act(async () => pending[0]?.resolve());
	assert.equal(compact() === row, true);
	assert.equal(reads("getToolActivityText").length, 0);
	session.dispose();
});

test("an open compact dialog keeps the metadata owner and pending output alive when only its header leaves view", async () => {
	deferText = true;
	await render();
	await visible();
	await act(async () => button("Tool call details").click());
	assert.equal(pendingText.length, 1);
	assert.equal(reads("getToolActivities").length, 1);
	await visible(false, true);
	assert.equal(pendingText[0]?.signal?.aborted, false);
	await act(async () => button("Close tool call details", document).click());
	assert.equal(pendingText[0]?.signal?.aborted, true);
	await act(async () => pendingText[0]?.resolve());
	assert.equal(host.querySelector("pre") === null, true);
	assert.equal(reads("getToolActivityText").length, 1);
});
test("offline proof is display-only and conflicting metadata revokes the compact header", async () => {
	items = [
		{
			...structuredClone(base),
			effect: { operationId: "op", status: "confirmed" },
			artifact: { rootId: "root", path: "src/example.ts", operationId: "op", status: "confirmed" },
		},
	];
	await render();
	await visible();
	await act(async () => button("src/example.ts").click());
	assert.deepEqual(opened, ["src/example.ts"]);
	await render({ connected: false });
	const target = button("src/example.ts");
	assert.equal(target.disabled, true);
	await act(async () => target.click());
	assert.equal(opened.length, 1);
	assert.ok(compact());
	const { fileSummary: _summary, ...withoutSummary } = structuredClone(base);
	items = [{ ...withoutSummary, toolResult: "unavailable" }];
	await render();
	assert.equal(compact() === null, true);
	assert.ok(host.querySelector(".activity-disclosure-toggle"));
	assert.equal(reads("getToolActivityText").length, 0);
	await render({ connected: false });
	assert.equal(compact() === null, true, "revoked proof must not reappear on pause");
});
test("missing metadata and a failed metadata read preserve the truthful closed fallback", async () => {
	const { fileSummary: _summary, ...withoutSummary } = structuredClone(base);
	items = [withoutSummary];
	await render();
	await visible();
	assert.equal(compact() === null, true);
	assert.equal(reads("getToolActivityText").length, 0);
	failMetadata = true;
	await render({ conversationId: "failed" });
	assert.equal(compact() === null, true);
	assert.equal(reads("getToolActivityText").length, 0);
});

test("the actual message provider promotes each interleaved singleton unit, not only one-tool messages", async () => {
	items.push({
		...structuredClone(base),
		activityId: "task:4",
		taskId: "4",
		resultEntryId: "5",
		callId: "read-2",
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 3 },
	});
	const toolCalls = {
		items: [
			{ callId: "read", name: "hipi_files_read", contentIndex: 1 },
			{ callId: "read-2", name: "hipi_files_read", contentIndex: 3 },
		],
		total: 2,
	};
	await act(async () =>
		root.render(
			<ThemeProvider>
				<ActivityTranscriptProvider scope={{ workspaceId: "w", conversationId: "c" }} connected running={false}>
					<MessageActivitiesProvider messageId="1_0" toolCalls={toolCalls}>
						<p>Before</p>
						<InlineMessageToolBlock contentIndexes={[1]} />
						<p>Between</p>
						<InlineMessageToolBlock contentIndexes={[3]} />
					</MessageActivitiesProvider>
				</ActivityTranscriptProvider>
			</ThemeProvider>,
		),
	);
	await visible();
	assert.equal(host.querySelectorAll("[data-file-activity-unit] > .inline-file-activity").length, 2);
	const metadata = reads("getToolActivities");
	assert.equal(
		metadata.filter((call) => (call.params as Params<"getToolActivities">).selector?.kind === "message").length,
		1,
	);
	assert.equal(
		metadata.filter((call) => !(call.params as Params<"getToolActivities">).selector).length,
		1,
		"the existing conversation-wide overview reader is independent of the shared message reader",
	);
	assert.equal(reads("getToolActivityText").length, 0);
});
test("a partial historical metadata page cannot revoke an unresolved live proof or cause an unbounded scan", async () => {
	const session = new ActivitySession(
		client,
		{ workspaceId: "w", conversationId: "c" },
		{ kind: "tasks", taskIds: ["2"] },
		new Map([["2", "read"]]),
	);
	session.activate();
	await session.page();
	const live: LiveActivityRead = { session, state: session.snapshot(), active: true };
	const liveTools: LiveTool[] = [
		{ taskId: "2", callId: "read", name: "hipi_files_read", status: "done", anchor: base.anchor },
	];
	await render({ live, liveTools });
	await visible();
	const row = compact();
	assert.ok(row);
	items = [
		{
			...structuredClone(base),
			activityId: "task:4",
			taskId: "4",
			resultEntryId: "5",
			anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: 3 },
		},
	];
	nextCursor = "later-page";
	await render();
	assert.equal(compact() === row, true);
	assert.equal(reads("getToolActivities").length, 2);
	assert.equal(reads("getToolActivityText").length, 0);
	await act(async () => button("Tool call details").click());
	assert.equal(
		reads("getToolActivityText").length,
		0,
		"display proof does not validate membership for retained output",
	);
	assert.equal(
		document.querySelector('[role="dialog"] article') === null,
		true,
		"cached records do not mount output leases",
	);
	items = [structuredClone(base)];
	nextCursor = null;
	failMetadata = true;
	await visible();
	await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
	assert.equal(reads("getToolActivities").length, 3, "the visible dialog continues the same metadata lane");
	assert.equal((reads("getToolActivities").at(-1)?.params as Params<"getToolActivities">).cursor, "later-page");
	assert.match(
		document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "",
		/Records could not be read/,
	);
	assert.equal(reads("getToolActivityText").length, 0);
	failMetadata = false;
	await act(async () => button("Retry read", document).click());
	assert.equal(reads("getToolActivities").length, 4, "only a real failed metadata request exposes retry");
	assert.equal(reads("getToolActivityText").length, 1, "output demand starts only after exact membership validates");
	assert.match(document.querySelector('[role="dialog"] pre')?.textContent ?? "", /private raw output/);
	assert.equal(compact() === row, true);
	session.dispose();
});

test("an unresolved capped metadata page reports partial coverage without output reads or healthy retry controls", async () => {
	const session = new ActivitySession(
		client,
		{ workspaceId: "w", conversationId: "c" },
		{ kind: "tasks", taskIds: ["2"] },
		new Map([["2", "read"]]),
	);
	session.activate();
	await session.page();
	const live: LiveActivityRead = { session, state: session.snapshot(), active: true };
	const liveTools: LiveTool[] = [
		{ taskId: "2", callId: "read", name: "hipi_files_read", status: "done", anchor: base.anchor },
	];
	await render({ live, liveTools });
	await visible();
	assert.ok(compact());
	items = Array.from({ length: 16 }, (_, index) => ({
		...structuredClone(base),
		activityId: `task:${10 + index}`,
		taskId: String(10 + index),
		resultEntryId: String(30 + index),
		anchor: { assistantEntryId: "1", modelIndex: 0, contentIndex: index + 2 },
	}));
	nextCursor = "beyond-cap";
	await render();
	await act(async () => button("Tool call details").click());
	await visible();
	await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
	assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /Some tool details are not shown/);
	assert.doesNotMatch(
		document.querySelector('[role="dialog"]')?.textContent ?? "",
		/Reading records|Retry read|Next|Refresh/,
	);
	assert.equal(reads("getToolActivities").length, 2);
	assert.equal(reads("getToolActivityText").length, 0);
	assert.equal(document.querySelector('[role="dialog"] article') === null, true);
	session.dispose();
});
