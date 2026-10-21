// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, Snapshot } from "@hipi/work-runtime/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { ThemeProvider } from "../../../../src/app/theme/provider.tsx";
import { ActivityTranscriptProvider } from "../../../../src/features/tool-activities/activity-transcript.tsx";
import { ConversationMessages } from "../../../../src/features/workbench/conversation/messages.tsx";

type LayoutOptions = {
	count: number;
	getItemKey: (index: number) => string;
	getScrollElement: () => HTMLElement | null;
};
// Deterministic layout port only: React, row lifetimes, selection and providers are real.
vi.mock("@tanstack/react-virtual", async () => ({
	...(await vi.importActual("@tanstack/react-virtual")),
	useVirtualizer: (options: LayoutOptions) => {
		const [owner] = useState(() => ({
			options,
			setOptions(next: LayoutOptions) {
				this.options = next;
			},
			getVirtualIndexes() {
				return Array.from({ length: this.options.count }, (_, index) => index);
			},
			getVirtualItems() {
				return this.getVirtualIndexes().map((index) => ({
					index,
					key: this.options.getItemKey(index),
					start: index * 100,
					end: (index + 1) * 100,
					size: 100,
					lane: 0,
				}));
			},
			getTotalSize() {
				return this.options.count * 100;
			},
			getOffsetForIndex: (index: number) => [index * 100],
			isAtEnd: () => true,
			scrollToEnd() {},
			scrollToIndex() {},
			scrollToOffset() {},
			cancelScroll() {},
			measureElement() {},
			takeSnapshot() {
				return this.getVirtualItems();
			},
		}));
		owner.options = options;
		return owner;
	},
}));
const client: AppClient = {
	call: vi.fn(async () => {
		throw new Error("No reads while disconnected");
	}),
	observe: vi.fn(async () => {
		throw new Error("No observer");
	}),
};
const scope = { workspaceId: "w", conversationId: "c" };
const process = {
	id: "2_0",
	role: "assistant" as const,
	text: "Process text",
	textLength: 12,
	truncated: false,
	runId: "1",
};
const initial: Snapshot = {
	...scope,
	messages: [process],
	running: true,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: null,
	execution: {
		ownerTaskId: "3",
		run: { id: "1", admittedAtMs: 1000 },
		submissionIds: [],
		submissionCount: 0,
		tools: { items: [], total: 0, active: 0 },
		blockingCompactionCount: 0,
	},
};
const completed: Snapshot = {
	...initial,
	running: false,
	execution: undefined,
	messages: [process, { ...process, id: "8_0", text: "Final answer", textLength: 12 }],
	runResults: {
		items: [
			{
				id: "1",
				terminalEntryId: "9",
				admittedAtMs: 1000,
				settledAtMs: 5000,
				terminalCause: "response",
				responseMessageId: "8_0",
				settlement: { status: "done" },
			},
		],
		omitted: false,
	},
};
let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;
let frameId = 0;
const frames = new Set<number>();
const nearTop = () => {};
async function render(snapshot: Snapshot, active = false) {
	await act(async () =>
		renderer.render(
			<AppClientProvider client={client}>
				<PreferencesProvider>
					<ThemeProvider>
						<ActivityTranscriptProvider scope={scope} connected={false} running={snapshot.running}>
							<ConversationMessages
								snapshot={snapshot}
								responseActive={active}
								scope={scope}
								error={false}
								onNearTop={nearTop}
							/>
						</ActivityTranscriptProvider>
					</ThemeProvider>
				</PreferencesProvider>
			</AppClientProvider>,
		),
	);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
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
	vi.stubGlobal("requestAnimationFrame", () => {
		frames.add(++frameId);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	host = document.createElement("div");
	document.body.append(host);
	renderer = createRoot(host);
});

test("initial waiting and pure text/final have no extra elapsed header; real process activity does", async () => {
	assert.ok(initial.execution);
	await render({ ...initial, messages: [], execution: { ...initial.execution, generation: { attempt: 1 } } }, true);
	assert.equal(host.querySelector(".run-activity-header"), null);
	assert.equal(host.querySelectorAll('[data-response-phase="generating"]').length, 1);
	await render({ ...initial, messages: [], partial: "Plain reply", partialLength: 11 }, true);
	assert.equal(host.querySelector(".run-activity-header"), null);
	await render({ ...completed, messages: completed.messages.slice(1) });
	assert.equal(host.querySelector(".run-activity-header"), null);
	assert.ok(host.querySelector('[data-message-id="8_0"]'));
	await render(initial, true);
	assert.ok(host.querySelector(".run-activity-header"));
});
afterEach(async () => {
	await act(async () => renderer.unmount());
	document.getSelection()?.removeAllRanges();
	host.remove();
	assert.equal(frames.size, 0);
	vi.unstubAllGlobals();
});

test("completion never removes a selected process body; release applies default fold with final outside", async () => {
	await render(initial);
	const text = host.querySelector('[data-message-id="2_0"] .markdown-body p');
	assert.ok(text);
	await act(async () => {
		const range = document.createRange();
		range.selectNodeContents(text);
		document.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	await render(completed);
	assert.equal(host.querySelector('[data-message-id="2_0"] .markdown-body p'), text);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(host.querySelector('[data-message-id="2_0"]'), null);
	assert.ok(host.querySelector('[data-message-id="8_0"]'));
});

test("focused process action blocks automatic folding; manual disclosure keeps final outside and refresh preserves choice", async () => {
	await render(initial);
	const copy = host.querySelector<HTMLButtonElement>('[data-message-id="2_0"] .message-copy');
	assert.ok(copy);
	await act(async () => copy.focus());
	await render(completed);
	assert.equal(document.activeElement, copy);
	assert.ok(host.querySelector('[data-message-id="2_0"]'));
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	assert.ok(header);
	await act(async () => {
		header.focus();
		header.click();
	});
	assert.equal(host.querySelector('[data-message-id="2_0"]'), null);
	await act(async () => header.click());
	assert.ok(host.querySelector('[data-message-id="2_0"]'));
	await render({ ...completed, messages: [...completed.messages] });
	assert.ok(host.querySelector('[data-message-id="2_0"]'));
	assert.ok(host.querySelector('[data-message-id="8_0"]'));
});
