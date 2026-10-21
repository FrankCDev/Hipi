// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, Snapshot } from "@hipi/work-runtime/contracts";
import type * as VirtualModule from "@tanstack/react-virtual";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { ThemeProvider } from "../../../src/app/theme/provider.tsx";
import { ActivityTranscriptProvider } from "../../../src/features/tool-activities/activity-transcript.tsx";
import { ConversationMessages } from "../../../src/features/workbench/conversation/messages.tsx";

// Real production messages, tool disclosure and TanStack. Only browser geometry
// and delivery of ResizeObserver entries are injected; this is not pixel proof.
type LayoutOptions = Parameters<typeof VirtualModule.useVirtualizer<HTMLElement, HTMLDivElement>>[0];
vi.mock("@tanstack/react-virtual", async () => {
	const actual = await vi.importActual<typeof VirtualModule>("@tanstack/react-virtual");
	return {
		...actual,
		useVirtualizer: (options: LayoutOptions) =>
			actual.useVirtualizer({
				...options,
				observeElementRect: (_instance, callback) => {
					callback({ width: 800, height: 500 });
					return () => {};
				},
				observeElementOffset: (_instance, callback) => {
					callback(0, false);
					return () => {};
				},
				scrollToFn: () => {},
			}),
	};
});
const client: AppClient = {
	call: vi.fn(async () => {
		throw new Error("No backend reads in disconnected geometry fixture");
	}),
	observe: vi.fn(async () => {
		throw new Error("No backend observation in geometry fixture");
	}),
};
const scope = { workspaceId: "geometry", conversationId: "disclosure" };
const snapshot: Snapshot = {
	...scope,
	messages: [
		{
			id: "tools",
			role: "assistant",
			text: "",
			textLength: 0,
			truncated: false,
			toolCalls: { total: 1, items: [{ contentIndex: 0, name: "hipi_files_read", callId: "read" }] },
		},
		{ id: "following", role: "assistant", text: "Following answer", textLength: 16, truncated: false },
	],
	running: false,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const heights = new Map<number, number>();
const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
const viewport = vi.fn();
const nearTop = () => {};
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.set(this, { callback, targets: new Set() });
			}
			observe(target: Element) {
				observers.get(this)?.targets.add(target);
			}
			unobserve(target: Element) {
				observers.get(this)?.targets.delete(target);
			}
			disconnect() {
				observers.delete(this);
			}
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
	heights.set(0, 100);
	heights.set(1, 80);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.matches(".virtual-message-row") ? (heights.get(Number(this.dataset.index)) ?? 80) : 500;
	});
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return new DOMRect(0, 0, 800, this.offsetHeight);
	});
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	document.getSelection()?.removeAllRanges();
	host.remove();
	assert.equal(observers.size, 0);
	frames.clear();
	heights.clear();
	viewport.mockClear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render(value = snapshot) {
	await act(async () =>
		root.render(
			<AppClientProvider client={client}>
				<PreferencesProvider>
					<ThemeProvider>
						<ActivityTranscriptProvider scope={scope} connected={false} running={false}>
							<ConversationMessages
								snapshot={value}
								scope={scope}
								error={false}
								onNearTop={nearTop}
								onHistoryViewport={viewport}
							/>
						</ActivityTranscriptProvider>
					</ThemeProvider>
				</PreferencesProvider>
			</AppClientProvider>,
		),
	);
}
function element(selector: string) {
	const node = host.querySelector<HTMLElement>(selector);
	assert.ok(node, selector);
	return node;
}
function deliverResize(target: HTMLElement, height: number) {
	heights.set(Number(target.dataset.index), height);
	const entry: ResizeObserverEntry = {
		target,
		borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
		contentBoxSize: [{ blockSize: height, inlineSize: 800 }],
		devicePixelContentBoxSize: [{ blockSize: height, inlineSize: 800 }],
		contentRect: new DOMRect(0, 0, 800, height),
	};
	for (const [observer, { callback, targets }] of observers) {
		if (targets.has(target)) callback([entry], observer);
	}
}
async function flushFrame() {
	await act(async () => {
		const batch = [...frames.values()];
		frames.clear();
		for (const callback of batch) callback(performance.now());
	});
}
test("tool expansion moves the following virtual row and total extent inside the same resize delivery", async () => {
	await render();
	const first = element('.virtual-message-row[data-index="0"]');
	const following = element('.virtual-message-row[data-index="1"]');
	const text = element('[data-message-id="following"] .markdown-body p');
	const header = element(".activity-disclosure-toggle");
	await act(async () => {
		header.focus();
		header.click();
	});
	assert.equal(header.getAttribute("aria-expanded"), "true");
	assert.equal(element(".message-scroll").dataset.following, "false");
	for (const height of [130, 180, 260, 190, 100]) {
		await act(async () => {
			deliverResize(first, height);
			// Check before act flushes React, not only after a rerender finishes.
			assert.equal(following.style.transform, `translate3d(0, ${height}px, 0)`);
			assert.equal(element(".virtual-message-stack").style.height, `${height + 80 + 32}px`);
		});
		assert.equal(element('[data-message-id="following"] .markdown-body p'), text);
		assert.equal(document.activeElement, header);
		assert.equal(host.querySelectorAll('[data-message-id="following"]').length, 1);
	}
	await render();
	assert.equal(following.style.transform, "translate3d(0, 100px, 0)", "React must not overwrite owned geometry");
});
test("size-only delivery still schedules the existing history viewport reporter and preserves selection", async () => {
	await render();
	await flushFrame();
	const text = element('[data-message-id="following"] .markdown-body p');
	await act(async () => {
		const range = document.createRange();
		range.selectNodeContents(text);
		document.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	await flushFrame();
	const before = viewport.mock.calls.length;
	await act(async () => {
		deliverResize(element('.virtual-message-row[data-index="0"]'), 140);
		assert.equal(element('.virtual-message-row[data-index="1"]').style.transform, "translate3d(0, 140px, 0)");
	});
	await flushFrame();
	assert.ok(viewport.mock.calls.length > before, "size-only updates must report current readable geometry");
	assert.equal(document.getSelection()?.toString(), "Following answer");
	assert.equal(element('[data-message-id="following"] .markdown-body p'), text);
});
test("an admitted turn keeps its final in normal flow while its next virtual row tracks nested tool resize", async () => {
	const tools = snapshot.messages[0];
	assert.ok(tools);
	await render({
		...snapshot,
		messages: [
			{ id: "0_0", role: "user", text: "Input", textLength: 5, truncated: false },
			{ ...tools, id: "3_0", runId: "2" },
			{ id: "8_0", role: "assistant", runId: "2", text: "Final answer", textLength: 12, truncated: false },
			{ id: "10_0", role: "user", text: "Next turn", textLength: 9, truncated: false },
		],
		runResults: {
			omitted: false,
			items: [
				{
					id: "2",
					terminalEntryId: "9",
					admittedAtMs: 1000,
					settledAtMs: 3000,
					terminalCause: "response",
					settlement: { status: "done" },
					responseMessageId: "8_0",
					inputRefs: { entryIds: ["0"], total: 1, omitted: false },
				},
			],
		},
	});
	const turn = element('[data-transcript-kind="turn"]');
	const final = element('[data-message-id="8_0"] .markdown-body p');
	const next = element('.virtual-message-row[data-index="1"]');
	await act(async () => element(".run-activity-header button").click());
	await act(async () => element(".inline-activity-toggle").click());
	assert.equal(final.closest(".virtual-message-row"), turn);
	assert.equal(final.closest(".conversation-turn-body"), null);
	for (const height of [160, 240, 130]) {
		await act(async () => {
			deliverResize(turn, height);
			assert.equal(next.style.transform, `translate3d(0, ${height}px, 0)`);
		});
		assert.equal(element('[data-message-id="8_0"] .markdown-body p'), final);
		assert.equal(host.querySelectorAll('[data-message-id="8_0"]').length, 1);
	}
});
