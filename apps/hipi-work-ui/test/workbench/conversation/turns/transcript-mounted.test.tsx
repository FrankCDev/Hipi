// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, SearchHistoryWindow, Snapshot } from "@hipi/work-runtime/contracts";
import type * as VirtualModule from "@tanstack/react-virtual";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { ThemeProvider } from "../../../../src/app/theme/provider.tsx";
import { ActivityTranscriptProvider } from "../../../../src/features/tool-activities/activity-transcript.tsx";
import { ConversationMessages } from "../../../../src/features/workbench/conversation/messages.tsx";

type LayoutOptions = Parameters<typeof VirtualModule.useVirtualizer<HTMLElement, HTMLDivElement>>[0];
vi.mock("@tanstack/react-virtual", async () => {
	const actual = await vi.importActual<typeof VirtualModule>("@tanstack/react-virtual");
	return {
		...actual,
		useVirtualizer: (options: LayoutOptions) =>
			actual.useVirtualizer({
				...options,
				observeElementRect: (_owner, callback) => {
					callback({ width: 800, height: 600 });
					return () => {};
				},
				observeElementOffset: (_owner, callback) => {
					callback(0, false);
					return () => {};
				},
				scrollToFn: () => {},
			}),
	};
});
let client: AppClient;
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
async function render(snapshot: Snapshot, active = false, searchAnchor?: SearchHistoryWindow) {
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
								searchAnchor={searchAnchor}
							/>
						</ActivityTranscriptProvider>
					</ThemeProvider>
				</PreferencesProvider>
			</AppClientProvider>,
		),
	);
}
beforeEach(() => {
	// Disclosure choices persist per client; each test owns an independent session.
	client = {
		call: vi.fn(async () => {
			throw new Error("No reads while disconnected");
		}),
		observe: vi.fn(async () => {
			throw new Error("No observer");
		}),
	};
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

afterEach(async () => {
	await act(async () => renderer.unmount());
	document.getSelection()?.removeAllRanges();
	host.remove();
	vi.unstubAllGlobals();
});
function admitted(value: Snapshot): Snapshot {
	const input = { id: "0_0", role: "user" as const, text: "Input", textLength: 5, truncated: false };
	return {
		...value,
		messages: [input, ...value.messages],
		partialId: value.running ? "stream-one" : undefined,
		execution: value.execution
			? {
					...value.execution,
					run: { id: "1", admittedAtMs: 1000, inputRefs: { entryIds: ["0"], total: 1, omitted: false } },
				}
			: undefined,
		runResults: value.runResults
			? {
					...value.runResults,
					items: value.runResults.items.map((item) => ({
						...item,
						inputRefs: { entryIds: ["0"], total: 1, omitted: false },
					})),
				}
			: undefined,
	};
}
async function select(range: Range | null, backwards = false) {
	await act(async () => {
		const selection = document.getSelection();
		assert.ok(selection);
		selection.removeAllRanges();
		if (range) {
			if (backwards)
				selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
			else selection.addRange(range);
		}
		document.dispatchEvent(new Event("selectionchange"));
	});
}
test("actual TanStack renders one measured turn containing user, process and persistent partial", async () => {
	await render(admitted({ ...initial, partial: "Live body", partialLength: 9 }), true);
	assert.equal(host.querySelectorAll(".virtual-message-row").length, 1);
	assert.equal(host.querySelectorAll('[data-transcript-kind="turn"]').length, 1);
	assert.ok(host.querySelector('[data-message-id="0_0"]'));
	assert.ok(host.querySelector('[data-message-id="2_0"]'));
	const stream = host.querySelector('[data-message-key^="stream:"]');
	assert.ok(stream);
	assert.equal(stream.closest(".conversation-turn-body"), null);
});
test("same stream identity commits within same outer turn without losing the readable Markdown node", async () => {
	await render(admitted({ ...initial, partial: "Live body", partialLength: 9 }), true);
	const turn = host.querySelector(".virtual-message-row");
	const stream = host.querySelector('[data-message-key^="stream:"]');
	assert.ok(stream);
	const final = admitted({
		...completed,
		messages: [process, { ...process, id: "8_0", streamId: "stream-one", text: "Live body", textLength: 9 }],
	});
	await render(final);
	assert.equal(host.querySelector(".virtual-message-row"), turn);
	assert.equal(host.querySelector('[data-message-id="8_0"]'), stream);
	assert.match(stream.textContent ?? "", /Live body/);
});

test("proved settled process omits the action footer while final, user and unknown messages retain copy", async () => {
	const value = admitted(completed);
	await render({
		...value,
		messages: [...value.messages, { ...process, id: "12_0", runId: undefined, text: "Unknown reply", textLength: 13 }],
	});
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	assert.ok(header);
	if (header.getAttribute("aria-expanded") === "false") await act(async () => header.click());
	assert.ok(host.querySelector('[data-message-id="2_0"] .markdown-body'));
	assert.equal(host.querySelector('[data-message-id="2_0"] .message-actions'), null);
	for (const id of ["0_0", "8_0", "12_0"]) {
		assert.ok(host.querySelector(`[data-message-id="${id}"] .message-actions .message-copy`), id);
	}
	await act(async () => header.click());
});

test("a projected process outside a measured turn uses the same settled action eligibility", async () => {
	const value = admitted(completed);
	await render(value, false, {
		...scope,
		messages: value.messages,
		target: { ...scope, messageId: "8_0", text: "Final answer", offset: 0, nextOffset: null, textLength: 12 },
		matchStart: 0,
		matchEnd: 5,
		olderCursor: null,
		newerCursor: null,
	});
	assert.equal(host.querySelector('[data-transcript-kind="turn"]'), null);
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	assert.ok(header);
	if (header.getAttribute("aria-expanded") === "false") await act(async () => header.click());
	assert.ok(host.querySelector('[data-message-id="2_0"] .markdown-body'));
	assert.equal(host.querySelector('[data-message-id="2_0"] .message-actions'), null);
	assert.ok(host.querySelector('[data-message-id="0_0"] .message-copy'));
	assert.ok(host.querySelector('[data-message-id="8_0"] .message-copy'));
	await act(async () => header.click());
});

test.each(["missing", "off-page", "conflicting", "cancelled", "non-final-response"] as const)(
	"%s settlement never suppresses ordinary message actions",
	async (evidence) => {
		const value = admitted(completed);
		const result = value.runResults?.items[0];
		assert.ok(result);
		if (evidence === "missing") value.runResults = undefined;
		else if (evidence === "off-page")
			value.runResults = { items: [{ ...result, terminalEntryId: "100", responseMessageId: "99_0" }], omitted: true };
		else if (evidence === "conflicting")
			value.runResults = { items: [result, { ...result, terminalEntryId: "10" }], omitted: false };
		else if (evidence === "cancelled")
			value.runResults = {
				items: [
					{
						...result,
						terminalCause: "unanswered",
						settlement: { status: "unanswered", reason: "aborted" },
						responseMessageId: undefined,
					},
				],
				omitted: false,
			};
		else value.runResults = { items: [{ ...result, responseMessageId: "2_0" }], omitted: false };
		await render(value);
		assert.equal(host.querySelector(".run-activity-header"), null);
		for (const message of value.messages) {
			assert.ok(host.querySelector(`[data-message-id="${message.id}"] .message-actions .message-copy`), message.id);
		}
	},
);

test("a focused live copy action survives exact settlement until focus leaves the process", async () => {
	await render(admitted(initial), true);
	const copy = host.querySelector<HTMLButtonElement>('[data-message-id="2_0"] .message-copy');
	assert.ok(copy, "the current live body does not prove settled process membership");
	await act(async () => copy.focus());
	await render(admitted(completed));
	assert.equal(document.activeElement, copy);
	assert.equal(host.querySelector('[data-message-id="2_0"] .message-copy'), copy);
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	assert.ok(header);
	await act(async () => header.focus());
	if (header.getAttribute("aria-expanded") === "false") await act(async () => header.click());
	assert.ok(host.querySelector('[data-message-id="2_0"] .markdown-body'));
	assert.equal(host.querySelector('[data-message-id="2_0"] .message-actions'), null);
	assert.ok(host.querySelector('[data-message-id="8_0"] .message-copy'));
	await act(async () => header.click());
});

test("real selection freezes completion in the same admitted turn", async () => {
	await render(admitted(initial), true);
	const selected = host.querySelector('[data-message-id="2_0"] .markdown-body p');
	const actions = host.querySelector('[data-message-id="2_0"] .message-actions');
	assert.ok(selected);
	assert.ok(actions);
	await act(async () => {
		const range = document.createRange();
		range.selectNodeContents(selected);
		document.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	});
	await render(admitted(completed));
	assert.ok(
		host.querySelector('[data-message-id="2_0"] .markdown-body p') === selected,
		"selected process node must retain identity",
	);
	assert.equal(host.querySelector('[data-message-id="2_0"] .message-actions'), actions);
	assert.equal(host.querySelectorAll(".virtual-message-row").length, 1);
});

test.each(["8_0", "0_0"])("selecting visible message %s never opens collapsed process history", async (id) => {
	await render(admitted(completed));
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	const selected = host.querySelector(`[data-message-id="${id}"] .markdown-body p`);
	assert.ok(header);
	assert.ok(selected);
	assert.equal(header.getAttribute("aria-expanded"), "false");
	assert.equal(host.querySelector('[data-message-id="2_0"]'), null);
	const range = document.createRange();
	range.selectNodeContents(selected);
	await select(range);
	assert.equal(header.getAttribute("aria-expanded"), "false");
	assert.equal(host.querySelector('[data-message-id="2_0"]'), null);
	assert.equal(host.querySelector(`[data-message-id="${id}"] .markdown-body p`), selected);
	assert.equal(document.getSelection()?.toString(), selected.textContent);
	await act(async () => {
		for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
			selected.dispatchEvent(new MouseEvent(type, { bubbles: true }));
	});
	assert.equal(header.getAttribute("aria-expanded"), "false", "bubbled final-body events are not disclosure intent");
	const copy = new Event("copy", { bubbles: true, cancelable: true });
	selected.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, false, "ordinary selected prose retains native copy behavior");
	assert.equal(document.getSelection()?.toString(), selected.textContent);
});

test.each([false, true])(
	"a cross-message range never reveals unmounted process content (backwards=%s)",
	async (backwards) => {
		await render(admitted(completed));
		const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
		const input = host.querySelector('[data-message-id="0_0"] .markdown-body p')?.firstChild;
		const final = host.querySelector('[data-message-id="8_0"] .markdown-body p')?.firstChild;
		assert.ok(header && input && final);
		const range = document.createRange();
		range.setStart(input, 0);
		range.setEnd(final, final.textContent?.length ?? 0);
		await select(range, backwards);
		assert.equal(document.getSelection()?.anchorNode, backwards ? final : input);
		assert.equal(document.getSelection()?.focusNode, backwards ? input : final);
		assert.equal(header.getAttribute("aria-expanded"), "false");
		assert.equal(host.querySelector('[data-message-id="2_0"]'), null);
		assert.match(document.getSelection()?.toString() ?? "", /Input/);
		assert.match(document.getSelection()?.toString() ?? "", /Final answer/);
	},
);

test("selection, clearing and reselecting preserve explicit disclosure choices", async () => {
	await render(admitted(completed));
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	const final = host.querySelector('[data-message-id="8_0"] .markdown-body p');
	assert.ok(header && final);
	const range = document.createRange();
	range.selectNodeContents(final);
	await act(async () => {
		header.focus();
		header.click();
	});
	const body = host.querySelector(".conversation-turn-body");
	assert.ok(body);
	await select(range);
	await select(null);
	await select(range, true);
	assert.equal(header.getAttribute("aria-expanded"), "true");
	assert.equal(host.querySelector(".conversation-turn-body"), body);
	await select(null);
	await act(async () => header.click());
	assert.equal(header.getAttribute("aria-expanded"), "false");
	assert.equal(body.getAttribute("aria-hidden"), "true");
	await select(range);
	await select(null);
	await select(range);
	assert.equal(header.getAttribute("aria-expanded"), "false");
	assert.equal(body.getAttribute("aria-hidden"), "true");
	await select(null);
	await act(async () => header.click());
	assert.equal(header.getAttribute("aria-expanded"), "true", "intentional reopening still works");
	assert.equal(host.querySelector('[data-message-id="8_0"] .markdown-body p'), final);
});

test("ranges ending on a turn wrapper and keyboard-extended final selections do not protect hidden members", async () => {
	await render(admitted(completed));
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	const final = host.querySelector('[data-message-id="8_0"] .markdown-body p')?.firstChild;
	const turn = host.querySelector(".conversation-turn");
	assert.ok(header && final && turn);
	const range = document.createRange();
	range.setStart(final, 0);
	range.setEnd(turn, turn.childNodes.length);
	await select(range);
	assert.equal(header.getAttribute("aria-expanded"), "false");
	await select(null);
	await act(async () => {
		const selection = document.getSelection();
		assert.ok(selection);
		selection.collapse(final, final.textContent?.length ?? 0);
		final.parentElement?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }),
		);
		// JSDOM has no native keyboard editing; apply its resulting Selection API range.
		selection.extend(final, 0);
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(header.getAttribute("aria-expanded"), "false");
	assert.equal(document.getSelection()?.toString(), "Final answer");
});

test("selected process content stays mounted without opening another collapsed run", async () => {
	const value = admitted(completed);
	const result = value.runResults?.items[0];
	assert.ok(result);
	await render({
		...value,
		messages: [
			...value.messages,
			{ ...process, id: "12_0", runId: "10", text: "Other process", textLength: 13 },
			{ ...process, id: "18_0", runId: "10", text: "Other final", textLength: 11 },
		],
		runResults: {
			omitted: false,
			items: [result, { ...result, id: "10", terminalEntryId: "19", responseMessageId: "18_0" }],
		},
	});
	const header = host.querySelector<HTMLButtonElement>('[data-run-id="1"] .run-activity-toggle');
	const other = host.querySelector<HTMLButtonElement>('[data-run-id="10"] .run-activity-toggle');
	assert.ok(header && other);
	await act(async () => header.click());
	const processBody = host.querySelector('[data-message-id="2_0"] .markdown-body p');
	const final = host.querySelector('[data-message-id="18_0"] .markdown-body p');
	assert.ok(processBody && final);
	const range = document.createRange();
	range.setStartBefore(processBody);
	range.setEndAfter(final);
	await select(range);
	await act(async () => header.click());
	assert.equal(header.getAttribute("aria-expanded"), "true", "selected process cannot be unmounted by a toggle");
	assert.equal(host.querySelector('[data-message-id="2_0"] .markdown-body p'), processBody);
	assert.equal(other.getAttribute("aria-expanded"), "false");
	assert.equal(host.querySelector('[data-message-id="12_0"]'), null);
	await select(null);
	assert.equal(header.getAttribute("aria-expanded"), "true", "selection protection does not overwrite user intent");
});

test("deactivation retains selected process nodes until selection releases", async () => {
	const value = admitted(initial);
	await render(value, true);
	const processBody = host.querySelector('[data-message-id="2_0"] .markdown-body p');
	assert.ok(processBody);
	const range = document.createRange();
	range.selectNodeContents(processBody);
	await select(range);
	// Response activity can change independently of the selection-frozen snapshot.
	await render(value, false);
	assert.equal(host.querySelector('[data-message-id="2_0"] .markdown-body p'), processBody);
	assert.ok(processBody.closest(".conversation-turn-body"));
	assert.equal(processBody.closest("[inert]"), null);
	assert.equal(document.getSelection()?.toString(), "Process text");
	await select(null);
	assert.equal(host.querySelector(".conversation-turn-body"), null);
	assert.match(host.querySelector('[data-message-id="2_0"]')?.textContent ?? "", /Process text/);
});

test("stale ranges inside an exiting process and detached ranges do not reopen it", async () => {
	await render(admitted(completed));
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	assert.ok(header);
	await act(async () => header.click());
	const processBody = host.querySelector('[data-message-id="2_0"] .markdown-body p');
	assert.ok(processBody);
	const stale = document.createRange();
	stale.selectNodeContents(processBody);
	await act(async () => header.click());
	assert.ok(processBody.closest("[inert]"));
	await select(stale);
	assert.equal(header.getAttribute("aria-expanded"), "false");
	const detached = document.createElement("p");
	detached.textContent = "Detached previous content";
	const range = document.createRange();
	range.selectNodeContents(detached);
	await select(range);
	assert.equal(document.getSelection()?.rangeCount, 0);
	assert.equal(header.getAttribute("aria-expanded"), "false");
});

test("flat search history has the same final selection boundary", async () => {
	const value = admitted(completed);
	await render(value, false, {
		...scope,
		messages: value.messages,
		target: { ...scope, messageId: "8_0", text: "Final answer", offset: 0, nextOffset: null, textLength: 12 },
		matchStart: 0,
		matchEnd: 5,
		olderCursor: null,
		newerCursor: null,
	});
	const header = host.querySelector<HTMLButtonElement>(".run-activity-toggle");
	const final = host.querySelector('[data-message-id="8_0"] .markdown-body p');
	assert.ok(header && final);
	assert.equal(host.querySelector('[data-transcript-kind="turn"]'), null);
	const range = document.createRange();
	range.selectNodeContents(final);
	await select(range);
	assert.equal(header.getAttribute("aria-expanded"), "false");
	assert.equal(host.querySelector('[data-message-id="2_0"]'), null);
	assert.equal(document.getSelection()?.toString(), "Final answer");
});

test("long turn keeps its measured outer DOM when admission pages in and metadata becomes omitted", async () => {
	const full = admitted(completed);
	const many = Array.from({ length: 40 }, (_, index) => ({
		...process,
		id: `${index + 20}_0`,
		text: `Process ${index}`,
		textLength: `Process ${index}`.length,
	}));
	const partial: Snapshot = {
		...full,
		messages: many,
		runResults: full.runResults ? { ...full.runResults, omitted: true } : undefined,
	};
	await render(partial);
	const outer = host.querySelector(".virtual-message-row");
	assert.ok(outer);
	assert.equal(host.querySelectorAll(".virtual-message-row").length, 1);
	assert.equal(host.querySelectorAll("article.message-assistant").length, 40);
	assert.equal(host.querySelector(".run-activity-header"), null);
	const input = full.messages[0];
	assert.ok(input);
	await render({ ...partial, messages: [input, ...many] });
	assert.ok(host.querySelector(".virtual-message-row") === outer, "loading admission must not remount measured turn");
	assert.equal(host.querySelectorAll("article.message-assistant").length, 40);
	assert.ok(host.querySelector('[data-message-id="0_0"]'));
	await render({ ...partial, runResults: undefined });
	assert.ok(
		host.querySelector(".virtual-message-row") === outer,
		"terminal metadata eviction must not negate explicit run identity",
	);
	assert.equal(host.querySelector(".run-activity-header"), null);
});

test("omitted history preserves the authoritative live header and a focused process action", async () => {
	await render(admitted(initial), true);
	const button = host.querySelector<HTMLButtonElement>('[data-message-id="2_0"] .message-copy');
	assert.ok(button);
	await act(async () => button.focus());
	await render({ ...admitted(initial), runResults: { items: [], omitted: true } }, true);
	assert.ok(document.activeElement === button, "metadata omission must retain focused action identity");
	assert.ok(host.querySelector(".run-activity-header"));
	assert.equal(host.querySelectorAll(".virtual-message-row").length, 1);
});

test("before the first token the same-view run owns one waiting turn without fabricating a stream identity", async () => {
	const waiting = admitted({ ...initial, messages: [], partial: "", partialLength: 0 });
	assert.ok(waiting.execution);
	await render(
		{ ...waiting, partialId: undefined, execution: { ...waiting.execution, generation: { attempt: 1 } } },
		true,
	);
	assert.equal(host.querySelectorAll(".virtual-message-row").length, 1);
	assert.equal(host.querySelectorAll('[data-transcript-kind="turn"]').length, 1);
	assert.ok(host.querySelector('[data-message-id="0_0"]'));
	assert.equal(host.querySelectorAll('[data-response-phase="generating"]').length, 1);
	assert.ok(host.querySelector('[data-message-key="partial-output"]'));
	assert.equal(host.querySelector(".run-activity-header"), null);
	await render({ ...waiting, execution: undefined, partialId: undefined }, true);
	assert.equal(host.querySelector('[data-transcript-kind="turn"]'), null);
});
