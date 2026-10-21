// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type AppClient, parseResult, type Snapshot } from "@hipi/work-runtime/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import {
	ActivityTranscriptProvider,
	InlineMessageActivities,
	MessageActivitiesProvider,
	useActivityTranscriptProjection,
} from "../../../src/features/tool-activities/activity-transcript.tsx";
import { StreamingMessage } from "../../../src/features/workbench/conversation/messages.tsx";
import { ResponseStatus } from "../../../src/features/workbench/conversation/response-status.tsx";

let root: Root;
let host: HTMLDivElement;
const observers = new Set<ViewportObserver>();
class ViewportObserver {
	readonly targets = new Set<Element>();
	private readonly callback: IntersectionObserverCallback;
	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
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
	enter(isIntersecting: boolean) {
		const entries = [...this.targets].map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry);
		this.callback(entries, this as unknown as IntersectionObserver);
	}
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("IntersectionObserver", ViewportObserver);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	delete document.documentElement.dataset.reducedMotion;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const render = async (content: ReactNode) => {
	await act(async () => root.render(<PreferencesProvider>{content}</PreferencesProvider>));
};
const viewport = async (visible: boolean) => {
	await act(async () => {
		// A real delivery targets the observers registered at notification time;
		// Motion may replace one synchronously while handling that notification.
		for (const observer of [...observers]) observer.enter(visible);
	});
};
const page = async (hidden: boolean) => {
	await act(async () => {
		Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
		document.dispatchEvent(new Event("visibilitychange"));
	});
};

test("Thinking is waiting copy, gated by viewport and page without a private reasoning phase", async () => {
	await render(<ResponseStatus />);
	const status = host.querySelector<HTMLElement>(".cadenced-text");
	assert.ok(status);
	assert.equal(status.dataset.animate, "false");
	assert.equal(status.querySelector('[aria-hidden="true"]')?.textContent, status.firstChild?.textContent);
	assert.doesNotMatch(status.innerHTML, /<output|aria-live|role="status"|准备环境/);
	assert.match(status.firstChild?.textContent ?? "", /Thinking|思考中/);
	assert.equal(host.querySelector<HTMLElement>(".response-status")?.dataset.responsePhase, "generating");
	assert.ok(host.querySelector('.response-status-spacer[aria-hidden="true"]'));
	await viewport(true);
	assert.equal(status.dataset.animate, "true");
	await page(true);
	assert.equal(status.dataset.animate, "false");
	await page(false);
	assert.equal(status.dataset.animate, "true");
	await viewport(false);
	assert.equal(status.dataset.animate, "false");
	await render(null);
	assert.equal(observers.size, 0);
});

const snapshot: Snapshot = {
	workspaceId: "w",
	conversationId: "c",
	running: true,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	partialId: "stream-a",
	messages: [],
	historyCursor: null,
};
test("first token replaces waiting status, while paused partial text remains non-final and non-copyable", async () => {
	await render(<StreamingMessage snapshot={snapshot} />);
	assert.ok(host.querySelector(".response-status"));
	const waitingArticle = host
		.querySelector(".response-status")
		?.closest(".message-content")
		?.closest(".message-assistant");
	assert.ok(waitingArticle, "empty-response activity shares the message reading-width column");
	await render(<StreamingMessage snapshot={{ ...snapshot, partial: "Hello", partialLength: 5 }} />);
	assert.ok(host.querySelector("article") === waitingArticle, "first token retains the assistant shell");
	assert.equal(host.querySelector(".response-status"), null);
	assert.equal(host.querySelector("article")?.getAttribute("aria-busy"), "true");
	assert.match(host.textContent ?? "", /Hello/);
	assert.equal(host.querySelector(".message-actions"), null);
	await render(<StreamingMessage snapshot={{ ...snapshot, running: false, partial: "Hello", partialLength: 5 }} />);
	assert.match(host.textContent ?? "", /Hello/);
	assert.equal(host.querySelector("article")?.getAttribute("aria-busy"), "false");
	assert.equal(host.querySelector(".message-actions"), null);
	await render(<StreamingMessage snapshot={{ ...snapshot, running: false }} />);
	assert.equal(host.textContent, "");
});

test("authoritative tool/wait status can coexist with text, but cancellation/disconnection gates only decoration", async () => {
	const execution = {
		ownerTaskId: "11",
		submissionIds: ["10"],
		submissionCount: 1,
		tools: { items: [{ taskId: "12", callId: "call", name: "read", status: "running" as const }], total: 1, active: 1 },
		blockingCompactionCount: 0,
	};
	const value: Snapshot = { ...snapshot, partial: "Retained text", partialLength: 13, execution };
	await render(<StreamingMessage snapshot={value} responseActive />);
	const article = host.querySelector("article");
	assert.ok(article);
	assert.equal(host.querySelector<HTMLElement>(".response-status")?.dataset.responsePhase, "tools");
	assert.match(host.textContent ?? "", /Retained text/);
	await render(<StreamingMessage snapshot={value} responseActive={false} />);
	assert.ok(host.querySelector("article") === article, "cancellation retains the assistant shell");
	assert.equal(host.querySelector(".response-status"), null);
	assert.equal(article.getAttribute("aria-busy"), "false");
	assert.match(host.textContent ?? "", /Retained text/);
	assert.equal(host.querySelector(".message-actions"), null);
	await render(
		<StreamingMessage
			snapshot={{
				...value,
				execution: { ...execution, tools: { items: [], total: 0, active: 0 }, generation: { attempt: 2, retryAt: 1 } },
			}}
			responseActive
		/>,
	);
	assert.ok(host.querySelector("article") === article, "retry retains the assistant shell");
	assert.equal(host.querySelector<HTMLElement>(".response-status")?.dataset.responsePhase, "retry");
});

test("actual waits replace Thinking and completion removes the placeholder instead of inventing elapsed time", async () => {
	const execution = {
		ownerTaskId: "11",
		submissionIds: ["10"],
		submissionCount: 1,
		tools: { items: [], total: 0, active: 0 },
		blockingCompactionCount: 0,
	};
	for (const [changes, expected] of [
		[{ generation: { attempt: 1 } }, "generating"],
		[{ generation: { attempt: 2, retryAt: 10 } }, "retry"],
		[{ generation: { attempt: 2, deferredPollAt: 20 } }, "deferred"],
		[{ blockingCompactionCount: 1 }, "compacting"],
		[{ generation: { attempt: 3 } }, "generating"],
	] as const) {
		await render(<StreamingMessage snapshot={{ ...snapshot, execution: { ...execution, ...changes } }} />);
		assert.equal(host.querySelector<HTMLElement>(".response-status")?.dataset.responsePhase, expected);
		assert.equal(host.querySelectorAll(".response-status").length, 1);
		assert.doesNotMatch(host.textContent ?? "", /Worked for|已用时|耗时|\d+\s*(seconds|秒)/);
	}
	await render(<StreamingMessage snapshot={{ ...snapshot, running: false, execution }} />);
	assert.equal(host.querySelector(".response-status"), null);
});

test("unproven tool slots retain generic progress; canonical mounted headers replace it until the next generation", async () => {
	const client: AppClient = {
		call: async (method, params) =>
			parseResult(method, {
				items: [],
				nextCursor: null,
				coverage: "tasks",
				membershipFence: "f",
				...("selector" in params && params.selector?.kind === "tasks"
					? { unavailableTaskIds: params.selector.taskIds }
					: {}),
			}),
		observe: async () => ({ dispose: async () => {} }),
	};
	const toolSnapshot: Snapshot = {
		...snapshot,
		execution: {
			ownerTaskId: "11",
			submissionIds: ["10"],
			submissionCount: 1,
			tools: { items: [{ taskId: "12", callId: "call", name: "read", status: "running" }], total: 1, active: 1 },
			blockingCompactionCount: 0,
		},
	};
	function View({ value }: { value: Snapshot }) {
		useActivityTranscriptProjection(value, true);
		return (
			<>
				{value.messages.map((message) => (
					<MessageActivitiesProvider key={message.id} messageId={message.id} toolCalls={message.toolCalls}>
						<InlineMessageActivities messageId={message.id} toolCalls={message.toolCalls} />
					</MessageActivitiesProvider>
				))}
				<StreamingMessage snapshot={value} />
			</>
		);
	}
	async function show(value: Snapshot) {
		await render(
			<AppClientProvider client={client}>
				<ActivityTranscriptProvider scope={value} connected running={value.running}>
					<View value={value} />
				</ActivityTranscriptProvider>
			</AppClientProvider>,
		);
	}
	await render(<StreamingMessage snapshot={toolSnapshot} />);
	assert.equal(
		host.querySelector<HTMLElement>(".response-status")?.dataset.responsePhase,
		"tools",
		"a phase without any mounted tool owner must retain its waiting state",
	);
	await show(toolSnapshot);
	assert.ok(
		host.querySelector(".inline-activity"),
		"unavailable exact detail still has a truthful mounted slot summary",
	);
	assert.equal(
		host.querySelector(".response-status") !== null,
		true,
		"an unproven live slot cannot claim the latest canonical tool group",
	);
	assert.equal(host.querySelector<HTMLElement>(".response-status")?.dataset.responsePhase, "tools");
	assert.ok(toolSnapshot.execution);
	await show({
		...toolSnapshot,
		messages: [
			{
				id: "2_0",
				role: "assistant",
				text: "",
				textLength: 0,
				truncated: false,
				toolCalls: { items: [{ callId: "call", name: "read", contentIndex: 1 }], total: 1 },
				publicBlocks: { items: [{ kind: "tool", contentIndex: 1 }], total: 1, omitted: false },
			},
		],
		execution: {
			...toolSnapshot.execution,
			tools: {
				...toolSnapshot.execution.tools,
				items: toolSnapshot.execution.tools.items.map((tool) => ({
					...tool,
					anchor: { assistantEntryId: "2", modelIndex: 0, contentIndex: 1 },
				})),
			},
		},
	});
	assert.equal(
		host.querySelector('[data-activity-message-id="2_0"] > button')?.getAttribute("aria-expanded"),
		"false",
		"the canonical group owns a mounted folded header without requiring detail expansion",
	);
	assert.equal(
		host.querySelector(".response-status") !== null,
		false,
		"a mounted active header for the latest canonical tool group replaces generic progress",
	);
	await show({
		...snapshot,
		execution: {
			...toolSnapshot.execution,
			ownerTaskId: "20",
			tools: { items: [], total: 0, active: 0 },
			generation: { attempt: 1 },
		},
	});
	assert.equal(
		host.querySelector<HTMLElement>(".response-status")?.dataset.responsePhase,
		"generating",
		"old mounted tool leases cannot suppress a new generation",
	);
});
