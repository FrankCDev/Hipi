// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { Snapshot } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { ThemeProvider } from "../../../../src/app/theme/provider.tsx";
import { projectTranscript } from "../../../../src/features/workbench/conversation/transcript.ts";
import type { TurnRow } from "../../../../src/features/workbench/conversation/turns/contracts.ts";
import { ConversationTurnRow } from "../../../../src/features/workbench/conversation/turns/row.tsx";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
const snapshot = (): Snapshot => ({
	workspaceId: "w",
	conversationId: "c",
	running: false,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	historyCursor: null,
	messages: [
		{ id: "1_0", role: "user", text: "User", textLength: 4, truncated: false },
		{ id: "3_0", role: "assistant", runId: "2", text: "Process", textLength: 7, truncated: false },
		{ id: "8_0", role: "assistant", runId: "2", text: "Final", textLength: 5, truncated: false },
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
			},
		],
	},
});
async function show(value: Snapshot, expanded?: boolean, protectedKeys: ReadonlySet<string> = new Set()) {
	const row: TurnRow = {
		kind: "turn",
		key: "turn:2",
		runId: "2",
		inputCoverage: "unknown",
		children: projectTranscript(value),
	};
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<ThemeProvider>
					<ConversationTurnRow
						row={row}
						snapshot={value}
						choices={expanded === undefined ? new Map() : new Map([["run:2", expanded]])}
						protectedKeys={protectedKeys}
						active
						onToggle={() => {}}
						render={(child) => (
							<div data-child={child.key}>{child.message?.text ?? "Persistent partial and approval"}</div>
						)}
					/>
				</ThemeProvider>
			</PreferencesProvider>,
		),
	);
}
test("completed process defaults closed and single Motion body exits without removing final", async () => {
	const value = snapshot();
	await show(value);
	assert.equal(host.querySelectorAll(".conversation-turn-body").length, 0);
	assert.match(host.textContent ?? "", /Final/);
	assert.doesNotMatch(host.textContent ?? "", /Process/);
	await show(value, true);
	assert.equal(host.querySelectorAll(".conversation-turn-body").length, 1);
	const final = host.querySelector('[data-child="message:8_0"]');
	assert.ok(final);
	await show(value, false);
	assert.equal(host.querySelectorAll(".conversation-turn-body").length, 1);
	assert.equal(host.querySelector(".conversation-turn-body")?.getAttribute("aria-hidden"), "true");
	assert.equal(host.querySelector('[data-child="message:8_0"]'), final);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 350));
	});
	assert.equal(host.querySelectorAll(".conversation-turn-body").length, 0);
	assert.equal(host.querySelector('[data-child="message:8_0"]'), final);
});
test("pure final and initial waiting have no invented process header", async () => {
	const value = snapshot();
	value.messages = value.messages.filter((message) => message.id !== "3_0");
	await show(value);
	assert.equal(host.querySelector(".run-activity-header"), null);
	await show({
		...value,
		messages: value.messages.slice(0, 1),
		running: true,
		partialId: "p",
		runResults: undefined,
		execution: {
			ownerTaskId: "4",
			submissionIds: [],
			submissionCount: 0,
			tools: { items: [], total: 0, active: 0 },
			blockingCompactionCount: 0,
			run: { id: "2", admittedAtMs: 1000 },
		},
	});
	assert.equal(host.querySelector(".run-activity-header"), null);
	assert.match(host.textContent ?? "", /Persistent partial and approval/);
});
test("protected process stays open and current partial remains outside process body", async () => {
	const value = snapshot();
	await show(value, false, new Set(["message:3_0"]));
	assert.match(host.querySelector(".conversation-turn-body")?.textContent ?? "", /Process/);
	await show({
		...value,
		runResults: undefined,
		running: true,
		partialId: "p",
		partial: "Tail",
		partialLength: 4,
		execution: {
			ownerTaskId: "4",
			submissionIds: [],
			submissionCount: 0,
			tools: { items: [], total: 0, active: 0 },
			blockingCompactionCount: 0,
			run: { id: "2", admittedAtMs: 1000 },
		},
	});
	const partial = host.querySelector('[data-child^="stream:"]');
	assert.ok(partial);
	assert.equal(partial.closest(".conversation-turn-body"), null);
	assert.equal(host.querySelectorAll(".conversation-turn-body").length, 1);
});
test("steering preserves original chronological position rather than moving into fold", async () => {
	const value = snapshot();
	value.messages.splice(2, 0, { id: "5_0", role: "user", text: "Steer", textLength: 5, truncated: false });
	await show(value, false);
	assert.equal(host.querySelector(".run-activity-header"), null);
	assert.deepEqual(
		Array.from(host.querySelectorAll("[data-child]")).map((node) => node.textContent),
		["User", "Process", "Steer", "Final"],
	);
});
