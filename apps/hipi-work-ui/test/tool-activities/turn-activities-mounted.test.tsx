// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AppClient,
	type ConversationExecution,
	type Method,
	type Params,
	parseResult,
	type ToolActivityPage,
} from "@hipi/work-runtime/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { HistoricalTurnActivities, LiveTurnActivities } from "../../src/features/tool-activities/turn-activities.tsx";

const calls: Params<"getToolActivities">[] = [];
let page: ToolActivityPage = { items: [], nextCursor: null, coverage: "tasks", membershipFence: "f" };
const client: AppClient = {
	call: async <M extends Method>(method: M, params: Params<M>) => {
		assert.equal(method, "getToolActivities");
		calls.push(params as Params<"getToolActivities">);
		return parseResult(method, page);
	},
	observe: async () => ({ dispose: async () => {} }),
};
vi.mock("../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
vi.mock("../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	calls.length = 0;
	page = { items: [], nextCursor: null, coverage: "tasks", membershipFence: "f" };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
function render(node: ReactNode) {
	root.render(<ThemeProvider>{node}</ThemeProvider>);
}
const scope = { workspaceId: "w", conversationId: "c" };
const execution: ConversationExecution = {
	ownerTaskId: "1",
	submissionIds: ["10"],
	submissionCount: 1,
	tools: { items: [{ taskId: "2", callId: "call", name: "hipi_files_read", status: "running" }], total: 1, active: 1 },
	blockingCompactionCount: 0,
};
test("live summary survives unavailable task evidence and completion becomes an immutable historical summary", async () => {
	page = { ...page, unavailableTaskIds: ["2"] };
	await act(async () => render(<LiveTurnActivities scope={scope} connected active execution={execution} />));
	assert.match(host.textContent ?? "", /Read file/);
	assert.match(host.textContent ?? "", /Execution state unavailable/);
	assert.deepEqual(calls[0]?.selector, { kind: "tasks", taskIds: ["2"] });
	const toolCalls = { items: [{ callId: "call", name: "hipi_files_read", contentIndex: 1 }], total: 1 };
	await act(async () =>
		render(
			<HistoricalTurnActivities
				scope={scope}
				connected
				messageId="5_0"
				toolCalls={toolCalls}
				expanded={false}
				onToggle={() => {}}
			/>,
		),
	);
	assert.match(host.textContent ?? "", /Read file/);
	assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "false");
	assert.equal(calls.length, 1, "collapsed historical summary requires no activity query");
});
test("empty historical scan keeps the summary and follows continuation only after explicit action", async () => {
	page = { ...page, nextCursor: "next" };
	await act(async () =>
		render(
			<HistoricalTurnActivities
				scope={scope}
				connected
				messageId="5_0"
				toolCalls={{ items: [{ callId: "call", name: "hipi_files_read", contentIndex: 1 }], total: 1 }}
				expanded
				onToggle={() => {}}
			/>,
		),
	);
	assert.equal(calls.length, 1);
	assert.match(host.textContent ?? "", /Read file/);
	assert.match(host.textContent ?? "", /No activity in this scanned page/);
	const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Next page");
	assert.ok(next);
	page = { ...page, nextCursor: null };
	await act(async () => next.click());
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.cursor, "next");
	assert.deepEqual(calls[1]?.selector, { kind: "message", messageId: "5_0" });
});
