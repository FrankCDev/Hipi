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
test("expanding a real group shows both retained outputs without a second toggle and dialog shares its reader", async () => {
	await render();
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
	await act(async () => toggle.click());
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 0);
	await act(async () => toggle.click());
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	assert.equal(calls.filter((call) => call.method === "getToolActivityText").length, 4);
});
test("disconnect retains both readable chunks; scope replacement aborts old pending output", async () => {
	await render();
	const text = host.querySelector("pre.inline-tool-text");
	assert.ok(text);
	await render("c", false);
	assert.equal(host.querySelector("pre.inline-tool-text"), text);
	await render("c", true);
	assert.equal(host.querySelectorAll("pre.inline-tool-text").length, 2);
	deferred = true;
	await render("old");
	assert.equal(pending.length, 1);
	await render("new");
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
