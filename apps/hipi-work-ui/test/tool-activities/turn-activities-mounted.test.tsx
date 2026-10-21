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
import { act, type ReactNode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { ActivityHistoryWindow } from "../../src/features/tool-activities/activity-history-window.tsx";
import { ActivitySession, INLINE_ACTIVITY_SCAN_PAGES } from "../../src/features/tool-activities/activity-session.ts";
import { HistoricalTurnActivities, LiveTurnActivities } from "../../src/features/tool-activities/turn-activities.tsx";

const calls: Params<"getToolActivities">[] = [];
let page: ToolActivityPage = { items: [], nextCursor: null, coverage: "tasks", membershipFence: "f" };
let pages: ToolActivityPage[] | undefined;
const client: AppClient = {
	call: async <M extends Method>(method: M, params: Params<M>) => {
		assert.equal(method, "getToolActivities");
		calls.push(params as Params<"getToolActivities">);
		return parseResult(method, pages?.shift() ?? page);
	},
	observe: async () => ({ dispose: async () => {} }),
};
vi.mock("../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
vi.mock("../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
const intersections: (() => void)[] = [];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				intersections.push(() =>
					callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
				);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	intersections.length = 0;
	calls.length = 0;
	pages = undefined;
	page = { items: [], nextCursor: null, coverage: "tasks", membershipFence: "f" };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.restoreAllMocks();
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
	const toggle = host.querySelector<HTMLButtonElement>(".inline-activity-toggle");
	assert.ok(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(calls.length, 0, "unopened standalone details do not acquire a reader");
	assert.match(host.textContent ?? "", /Tool activity/);
	await act(async () => toggle.click());
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

test("mixed groups use the capability fallback unless a proven active item supplies the summary", async () => {
	const toolCalls = {
		items: [
			{ callId: "read", name: "hipi_files_read", contentIndex: 1 },
			{ callId: "list", name: "hipi_files_list", contentIndex: 2 },
		],
		total: 2,
	};
	const show = (active: boolean, total = 2) =>
		act(async () =>
			render(
				<HistoricalTurnActivities
					scope={scope}
					connected
					messageId="5_0"
					toolCalls={{ ...toolCalls, total }}
					expanded={false}
					onToggle={() => {}}
					presentation={
						active ? { kind: "active", key: "list", toolName: "hipi_files_list", status: "pending" } : undefined
					}
				/>,
			),
		);
	await show(true);
	const heading = host.querySelector(".activity-disclosure-summary");
	assert.equal(heading?.querySelector(".cadenced-text")?.firstChild?.textContent, "List files");
	assert.ok(host.querySelector(".lucide-folder"));
	assert.match(host.querySelector(".inline-activity-phase")?.textContent ?? "", /Pending/);
	assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "false");
	await show(false);
	assert.equal(heading?.textContent, "Tool activity");
	assert.equal(host.querySelector(".inline-activity-count")?.textContent, "2");
	assert.equal(host.querySelector(".inline-activity-phase"), null);
	assert.ok(host.querySelector(".lucide-puzzle"));
	await show(false, 3);
	assert.equal(heading?.textContent, "Tool activity");
	assert.equal(calls.length, 0);
});

const matching: ToolActivityPage = {
	items: [
		{
			activityId: "task:1",
			taskId: "1",
			callId: "call",
			toolName: "hipi_files_read",
			source: "task",
			inherited: false,
			anchor: { assistantEntryId: "5", modelIndex: 0, contentIndex: 1 },
			phase: "terminal",
			toolResult: "success",
			abortRequested: false,
			receiptIds: [],
			textAvailable: false,
			outputTruncated: false,
		},
	],
	nextCursor: null,
	coverage: "tasks",
	membershipFence: "f",
};
async function renderHistory() {
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
}
test("empty storage windows are scanned internally without pagination diagnostics in normal inline UI", async () => {
	pages = [{ ...page, nextCursor: "next" }, matching];
	await renderHistory();
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.cursor, "next");
	assert.equal(host.querySelectorAll(".inline-tool-result").length, 1);
	assert.doesNotMatch(host.textContent ?? "", /No activity in this scanned page|Refresh this page|Next page/);
	assert.ok(host.querySelector(".lucide-file"));
});
test("inline scan budget continues at a visible boundary without a detail or transport button", async () => {
	pages = Array.from({ length: INLINE_ACTIVITY_SCAN_PAGES }, (_, i) => ({ ...page, nextCursor: String(i + 1) }));
	pages.push(matching);
	await renderHistory();
	assert.equal(calls.length, INLINE_ACTIVITY_SCAN_PAGES);
	assert.equal(host.querySelector('[aria-label="Tool call details"]'), null);
	await act(async () => {
		for (const intersect of intersections) intersect();
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	assert.equal(calls.length, INLINE_ACTIVITY_SCAN_PAGES + 1);
	assert.equal(calls.at(-1)?.cursor, String(INLINE_ACTIVITY_SCAN_PAGES));
	assert.equal(host.querySelectorAll(".inline-tool-result").length, 1);
	assert.doesNotMatch(host.textContent ?? "", /Next page|Continue reading activity|Refresh this page/);
});
test("self-loop and multi-cursor-loop fail closed instead of silently treating an empty scan as complete", async () => {
	for (const cursors of [
		["a", "a"],
		["a", "b", "a"],
	]) {
		const session = new ActivitySession(client, scope, { kind: "message", messageId: "5_0" });
		session.activate();
		pages = cursors.map((nextCursor) => ({ ...page, nextCursor }));
		const before = calls.length;
		await session.inlinePage();
		assert.equal(session.snapshot().failed, true);
		assert.equal(calls.length - before, cursors.length);
		assert.equal(session.snapshot().page, undefined);
		session.dispose();
	}
});
test("exact task selectors cannot request continuation and malformed task partition fails without chasing", async () => {
	const session = new ActivitySession(client, scope, { kind: "tasks", taskIds: ["1"] });
	session.activate();
	await session.inlinePage("forbidden");
	assert.equal(calls.length, 0);
	page = { ...matching, nextCursor: "forbidden", unavailableTaskIds: [] };
	await session.inlinePage();
	assert.equal(calls.length, 1);
	assert.equal(session.snapshot().failed, true);
	session.dispose();
});

test("cancelling an inline scan during a later window fences its late response and does not publish partial success", async () => {
	let release: ((page: ToolActivityPage) => void) | undefined;
	let signal: AbortSignal | undefined;
	const scoped: AppClient = {
		...client,
		call: async <M extends Method>(method: M, params: Params<M>, wait?: AbortSignal) => {
			const cursor = (params as Params<"getToolActivities">).cursor;
			if (!cursor) return parseResult(method, { ...page, nextCursor: "later" });
			signal = wait;
			return parseResult(
				method,
				await new Promise<ToolActivityPage>((resolve) => {
					release = resolve;
				}),
			);
		},
	};
	const session = new ActivitySession(scoped, scope, { kind: "message", messageId: "5_0" });
	session.activate();
	const read = session.inlinePage();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(release);
	session.dispose();
	assert.equal(signal?.aborted, true);
	release(matching);
	await read;
	assert.equal(session.snapshot().page, undefined);
	assert.equal(session.snapshot().failed, false);
});
test("a failed later inline scan preserves readable evidence but marks it failed, with retry at the failed window", async () => {
	let failed = false;
	const positions: (string | undefined)[] = [];
	const scoped: AppClient = {
		...client,
		call: async <M extends Method>(method: M, params: Params<M>) => {
			const cursor = (params as Params<"getToolActivities">).cursor;
			positions.push(cursor);
			if (cursor === "failure" && !failed) {
				failed = true;
				throw new Error("offline");
			}
			return parseResult(method, cursor === "next" ? { ...page, nextCursor: "failure" } : matching);
		},
	};
	const session = new ActivitySession(scoped, scope, { kind: "message", messageId: "5_0" });
	session.activate();
	await session.inlinePage();
	const original = session.snapshot().page;
	await session.inlinePage("next");
	assert.equal(session.snapshot().failed, true);
	assert.equal(session.snapshot().page, original);
	await session.retry();
	assert.equal(positions.at(-1), "failure");
	assert.equal(session.snapshot().failed, false);
	session.dispose();
});

test("continuous history retains three metadata pages and replays evicted cursor checkpoints", async () => {
	const positions: number[] = [];
	const scoped: AppClient = {
		...client,
		call: async <M extends Method>(method: M, params: Params<M>) => {
			const index = Number((params as Params<"getToolActivities">).cursor ?? 0);
			positions.push(index);
			return parseResult(method, {
				...matching,
				items: matching.items.map((item) => ({ ...item, activityId: `task:${index}`, taskId: String(index) })),
				nextCursor: String(index + 1),
			});
		},
	};
	const session = new ActivitySession(scoped, scope);
	session.activate();
	for (let index = 0; index < 132; index++) {
		await session.windowPage(index);
		assert.ok((session.snapshot().window?.length ?? 0) <= 3);
	}
	assert.deepEqual(
		session.snapshot().window?.map((entry) => entry.index),
		[129, 130, 131],
	);
	await session.windowPage(1);
	assert.deepEqual(positions.slice(-2), [0, 1]);
	assert.equal(session.snapshot().window?.[0]?.index, 1);
	assert.equal(session.snapshot().failed, false);
	session.dispose();
});
test("message continuation retains earlier exact occurrences instead of replacing sibling slices", async () => {
	pages = [
		{ ...matching, nextCursor: "second" },
		{
			...matching,
			items: matching.items.map((item) => ({
				...item,
				activityId: "task:2",
				taskId: "2",
				anchor: { assistantEntryId: "5", modelIndex: 0, contentIndex: 2 },
			})),
		},
	];
	const session = new ActivitySession(client, scope, { kind: "message", messageId: "5_0" });
	session.activate();
	await session.inlinePage();
	await session.inlinePage("second");
	assert.deepEqual(
		session.snapshot().page?.items.map((item) => item.anchor?.contentIndex),
		[1, 2],
	);
	session.dispose();
});

test("mounted history loads boundaries through scroll, keeps a three-page window and restores evicted earlier records", async () => {
	const scoped: AppClient = {
		...client,
		call: async <M extends Method>(method: M, params: Params<M>) => {
			const index = Number((params as Params<"getToolActivities">).cursor ?? 0);
			return parseResult(method, {
				...matching,
				items: matching.items.map((item) => ({ ...item, activityId: `task:${index}`, toolName: `tool_${index}` })),
				nextCursor: index < 6 ? String(index + 1) : null,
			});
		},
	};
	const session = new ActivitySession(scoped, scope);
	session.activate();
	function History() {
		const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
		return <ActivityHistoryWindow session={session} state={state} enabled locale="en" />;
	}
	await act(async () => render(<History />));
	await act(async () => {
		intersections.at(-1)?.();
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	assert.match(host.textContent ?? "", /tool_0/);
	const viewport = host.querySelector<HTMLElement>("[data-activity-history-window]");
	assert.ok(viewport);
	Object.defineProperties(viewport, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
	for (let index = 1; index <= 4; index++) {
		await act(async () => {
			viewport.scrollTop = 100 + index;
			viewport.dispatchEvent(new Event("scroll"));
			await new Promise((resolve) => setTimeout(resolve, 70));
		});
	}
	assert.deepEqual(
		session.snapshot().window?.map((entry) => entry.index),
		[2, 3, 4],
	);
	assert.doesNotMatch(host.textContent ?? "", /tool_0|Next page|First page|Refresh this page/);
	await act(async () => {
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	assert.deepEqual(
		session.snapshot().window?.map((entry) => entry.index),
		[1, 2, 3],
	);
	assert.match(host.textContent ?? "", /tool_1/);
	await act(async () => root.render(<ThemeProvider>{null}</ThemeProvider>));
	session.dispose();
});

test("history membership replacement fails visibly and retry rebuilds its window from a fresh first boundary", async () => {
	let fence = "old";
	const scoped: AppClient = {
		...client,
		call: async <M extends Method>(method: M, params: Params<M>) =>
			parseResult(method, {
				...matching,
				membershipFence: fence,
				nextCursor: (params as Params<"getToolActivities">).cursor ? null : "next",
			}),
	};
	const session = new ActivitySession(scoped, scope);
	session.activate();
	await session.windowPage(0);
	fence = "new";
	await session.windowPage(1);
	assert.equal(session.snapshot().failed, true);
	assert.equal(session.snapshot().window?.[0]?.page.membershipFence, "old");
	await session.retry();
	assert.equal(session.snapshot().failed, false);
	assert.equal(session.snapshot().window?.length, 1);
	assert.equal(session.snapshot().window?.[0]?.page.membershipFence, "new");
	session.dispose();
});
test("empty message cursor loops crossing a scan batch cannot keep an idle visible view scanning forever", async () => {
	pages = Array.from({ length: INLINE_ACTIVITY_SCAN_PAGES }, (_, i) => ({ ...page, nextCursor: String(i + 1) }));
	pages.push({ ...page, nextCursor: "1" });
	const session = new ActivitySession(client, scope, { kind: "message", messageId: "5_0" });
	session.activate();
	await session.inlinePage();
	const original = session.snapshot().page;
	await session.inlinePage(String(INLINE_ACTIVITY_SCAN_PAGES));
	assert.equal(session.snapshot().failed, true);
	assert.equal(session.snapshot().page, original);
	session.dispose();
});

test("omitted message summaries scroll beyond sixteen real occurrences without transport controls", async () => {
	const original = matching.items[0];
	assert.ok(original);
	const many = Array.from({ length: 17 }, (_, index) => ({
		...original,
		activityId: `task:${index}`,
		taskId: String(index),
		callId: "same-call",
		anchor: { assistantEntryId: "5", modelIndex: 0, contentIndex: index },
	}));
	pages = [
		{ ...matching, items: many.slice(0, 16), nextCursor: "remaining" },
		{ ...matching, items: many.slice(16) },
	];
	await act(async () =>
		render(
			<HistoricalTurnActivities
				scope={scope}
				connected
				messageId="5_0"
				toolCalls={{
					items: many
						.slice(0, 16)
						.map((item) => ({ callId: item.callId, name: item.toolName, contentIndex: item.anchor.contentIndex })),
					total: 17,
				}}
				expanded
				onToggle={() => {}}
			/>,
		),
	);
	assert.equal(calls.length, 1);
	const viewport = host.querySelector<HTMLElement>("[data-activity-history-window]");
	assert.ok(viewport);
	await act(async () => {
		viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1]?.selector, { kind: "message", messageId: "5_0" });
	assert.equal(host.querySelectorAll("[data-history-record]").length, 17);
	assert.doesNotMatch(host.textContent ?? "", /Next page|First page|Continue reading activity|Refresh this page/);
});

test("history rejects cross-window cursor cycles instead of presenting repeated records as progress", async () => {
	const scoped: AppClient = {
		...client,
		call: async <M extends Method>(method: M, params: Params<M>) => {
			const cursor = (params as Params<"getToolActivities">).cursor;
			return parseResult(method, { ...matching, nextCursor: cursor === "a" ? "b" : "a" });
		},
	};
	const session = new ActivitySession(scoped, scope);
	session.activate();
	await session.windowPage(0);
	await session.windowPage(1);
	await session.windowPage(2);
	assert.equal(session.snapshot().failed, true);
	assert.deepEqual(
		session.snapshot().window?.map((entry) => entry.index),
		[0, 1],
	);
	session.dispose();
});

test("a completed history response waits behind selection and cancellation discards that held page", async () => {
	const scoped: AppClient = {
		...client,
		call: async <M extends Method>(method: M, params: Params<M>) =>
			parseResult(method, { ...matching, nextCursor: (params as Params<"getToolActivities">).cursor ? null : "next" }),
	};
	const session = new ActivitySession(scoped, scope);
	session.activate();
	await session.windowPage(0);
	const original = session.snapshot().window;
	session.selectMetadata(true);
	const pending = session.windowPage(1);
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(session.snapshot().window, original);
	session.selectMetadata(false);
	await pending;
	assert.equal(session.snapshot().window?.length, 2);
	session.selectMetadata(true);
	const cancelled = session.windowPage(0);
	await Promise.resolve();
	await Promise.resolve();
	session.dispose();
	await cancelled;
	assert.equal(session.snapshot().window, undefined);
});

test("historical disclosure retains one reader through closing reversal and releases it only after completed collapse", async () => {
	page = matching;
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	const dispose = vi.spyOn(ActivitySession.prototype, "dispose");
	const show = async (expanded: boolean) =>
		act(async () =>
			render(
				<HistoricalTurnActivities
					scope={scope}
					connected
					messageId="5_0"
					toolCalls={{ items: [{ callId: "call", name: "hipi_files_read", contentIndex: 1 }], total: 1 }}
					expanded={expanded}
					onToggle={() => {}}
				/>,
			),
		);
	const wait = async (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
	await show(false);
	assert.equal(calls.length, 0, "closed content must not acquire a metadata reader");
	await show(true);
	await wait(80);
	const body = host.querySelector<HTMLElement>(".activity-disclosure-body");
	const record = host.querySelector(".inline-tool-result");
	assert.ok(body && record);
	assert.equal(calls.length, 1);
	await show(false);
	assert.equal(body.hasAttribute("inert"), true);
	assert.equal(host.querySelector(".inline-tool-result"), record);
	await wait(35);
	await show(true);
	await wait(400);
	assert.equal(host.querySelector(".activity-disclosure-body"), body);
	assert.equal(host.querySelector(".inline-tool-result"), record);
	assert.equal(dispose.mock.calls.length, 0);
	assert.equal(calls.length, 1, "reversal must reuse the active reader instead of fetching a duplicate");
	await show(false);
	assert.equal(host.querySelector(".inline-tool-result"), record);
	await wait(400);
	assert.equal(host.querySelector(".activity-disclosure-body"), null);
	assert.equal(dispose.mock.calls.length, 1);
	await show(true);
	assert.equal(calls.length, 2, "a completed collapse releases the reader before a later fresh expansion");
});

test("live disclosure keeps its existing task reader while closing and releases it on completed collapse", async () => {
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	const dispose = vi.spyOn(ActivitySession.prototype, "dispose");
	await act(async () => render(<LiveTurnActivities scope={scope} connected active execution={execution} />));
	const header = host.querySelector<HTMLButtonElement>(".inline-activity-toggle");
	assert.ok(header);
	assert.equal(calls.length, 0);
	await act(async () => header.click());
	assert.equal(calls.length, 1);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
	const details = host.querySelector(".inline-activity-details");
	assert.ok(header && details);
	await act(async () => header.click());
	assert.equal(host.querySelector(".inline-activity-details"), details);
	assert.equal(dispose.mock.calls.length, 0);
	await act(async () => header.click());
	assert.equal(host.querySelector(".inline-activity-details"), details);
	assert.equal(calls.length, 1);
	await act(async () => header.click());
	await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
	assert.equal(host.querySelector(".inline-activity-details"), null);
	assert.equal(dispose.mock.calls.length, 1);
});
