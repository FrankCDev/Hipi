// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	type Params,
	parseResult,
	type ToolActivity,
	type ToolActivityTextPage,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { HistoricalTurnActivities } from "../../src/features/tool-activities/turn-activities.tsx";

const items: ToolActivity[] = [1, 2].map((id) => ({
	activityId: `task:${id}`,
	taskId: String(id),
	callId: `call-${id}`,
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
const client: AppClient = {
	async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) {
		calls.push({ method, params, signal });
		if (method === "getToolActivities")
			return parseResult(method, { items, nextCursor: null, coverage: "tasks", membershipFence: "f" });
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
async function render(conversationId = "c", connected = true) {
	await act(async () =>
		root.render(
			<ThemeProvider>
				<HistoricalTurnActivities
					key={conversationId}
					scope={{ workspaceId: "w", conversationId }}
					connected={connected}
					messageId="1_0"
					toolCalls={{
						items: items.map((item, index) => ({ callId: item.callId, name: item.toolName, contentIndex: index + 1 })),
						total: 2,
					}}
					expanded
					onToggle={() => {}}
				/>
			</ThemeProvider>,
		),
	);
}
async function openResults() {
	await act(async () => {
		for (const toggle of host.querySelectorAll<HTMLButtonElement>('.inline-tool-result-toggle[aria-expanded="false"]'))
			toggle.click();
	});
}
test("group expansion does not read individual results; explicit results and dialog share one reader", async () => {
	await render();
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 0);
	await openResults();
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	assert.doesNotMatch(host.textContent ?? "", /Read retained output/);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 2);
	const detail = host.querySelector<HTMLButtonElement>('[aria-label="Tool call details"]');
	assert.ok(detail);
	await act(async () => detail.click());
	assert.ok(document.querySelector('[role="dialog"] pre'));
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 2);
	const close = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === "Close tool call details",
	);
	assert.ok(close);
	await act(async () => close.click());
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	const toggle = host.querySelector<HTMLButtonElement>(".activity-disclosure-toggle");
	assert.ok(toggle);
	const outputs = [...host.querySelectorAll("pre.inline-tool-text")];
	const body = host.querySelector(".activity-disclosure-body");
	assert.ok(body);
	await act(async () => toggle.click());
	assert.equal(body.hasAttribute("inert"), true);
	assert.equal(body.getAttribute("aria-hidden"), "true");
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2, "closing retains both output leases");
	await act(async () => toggle.click());
	for (const [index, output] of outputs.entries()) {
		assert.ok(host.querySelectorAll("pre.inline-tool-text")[index] === output);
	}
	assert.equal(body.hasAttribute("inert"), false);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 2, "reversal reuses its readers");
	await act(async () => toggle.click());
	await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
	assert.equal(host.querySelector(".activity-disclosure-body"), null);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0);
	await act(async () => toggle.click());
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0, "newly mounted individuals start closed");
	await openResults();
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 4);
});
test("disconnect retains both readable chunks; scope replacement aborts old pending output", async () => {
	await render();
	await openResults();
	const text = host.querySelector("pre.inline-tool-text");
	assert.ok(text);
	await render("c", false);
	assert.equal(host.querySelector("pre.inline-tool-text"), text);
	await render("c", true);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	deferred = true;
	await render("old");
	await openResults();
	assert.equal(pending.length, 1);
	await render("new");
	await openResults();
	assert.equal(pending[0]?.signal?.aborted, true);
	await act(async () => pending[0]?.resolve(pending[0].result));
	assert.doesNotMatch(host.textContent ?? "", /old:task/);
	await act(async () => pending[1]?.resolve(pending[1].result));
	await act(async () => pending[2]?.resolve(pending[2].result));
	assert.match(host.textContent ?? "", /new:task:1/);
	assert.match(host.textContent ?? "", /new:task:2/);
});
test("late auto-read output waits for conversation selection release", async () => {
	deferred = true;
	await render();
	await openResults();
	const name = host.querySelector(".inline-tool-result-name");
	assert.ok(name);
	const range = document.createRange();
	range.selectNodeContents(name);
	document.getSelection()?.addRange(range);
	await act(async () => document.dispatchEvent(new Event("selectionchange")));
	await act(async () => pending[0]?.resolve(pending[0].result));
	assert.equal(host.querySelector("pre.inline-tool-text"), null);
	assert.equal(name.isConnected, true);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.match(host.querySelector("pre.inline-tool-text")?.textContent ?? "", /c:task:1/);
});

test("individual close immediately releases its pending read while the sibling uses the same FIFO", async () => {
	deferred = true;
	await render();
	await openResults();
	assert.equal(pending.length, 1);
	const first = host.querySelector<HTMLButtonElement>(".inline-tool-result-toggle");
	assert.ok(first);
	await act(async () => first.click());
	assert.equal(pending[0]?.signal?.aborted, true, "individual closing does not retain the group's reader lifetime");
	assert.equal(pending.length, 2, "the existing FIFO advances to the sibling, not another output lane");
	await act(async () => pending[0]?.resolve(pending[0].result));
	assert.equal(host.querySelector("pre") === null, true, "late closed output is rejected");
	await act(async () => pending[1]?.resolve(pending[1].result));
	assert.match(host.querySelector("pre")?.textContent ?? "", /c:task:2/);
	await act(async () => first.click());
	assert.equal(pending.length, 3);
	await act(async () => pending[2]?.resolve(pending[2].result));
	assert.equal(host.querySelectorAll("pre").length, 2);
	assert.equal(calls.filter((call) => call.method === "getToolActivities").length, 1);
});
