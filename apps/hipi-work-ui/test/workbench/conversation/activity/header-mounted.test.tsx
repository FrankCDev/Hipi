// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import type { AppClient, Scope } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import {
	ActivityTranscriptProvider,
	useActivityTranscript,
} from "../../../../src/features/tool-activities/activity-transcript.tsx";
import type { RunActivity } from "../../../../src/features/workbench/conversation/activity/contracts.ts";
import {
	formatRunElapsed,
	RunActivityHeader,
} from "../../../../src/features/workbench/conversation/activity/header.tsx";

let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(5000);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	renderer = createRoot(host);
});
afterEach(async () => {
	await act(async () => renderer.unmount());
	host.remove();
	assert.equal(vi.getTimerCount(), 0);
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const base: RunActivity = { id: "1", key: "run:1", members: [], expanded: true, running: true, admittedAtMs: 1000 };
async function render(activity: RunActivity) {
	await act(async () =>
		renderer.render(
			<PreferencesProvider>
				<RunActivityHeader activity={activity} onToggle={() => {}} />
			</PreferencesProvider>,
		),
	);
}

test("running elapsed updates once per second; settlement fixes inclusive wall time and removes timer", async () => {
	await render(base);
	assert.match(host.textContent ?? "", /4/);
	await act(async () => vi.advanceTimersByTime(1000));
	assert.match(host.textContent ?? "", /5/);
	await render({
		...base,
		running: false,
		members: ["message:2_0"],
		result: {
			id: "1",
			terminalEntryId: "9",
			admittedAtMs: 1000,
			settledAtMs: 4500,
			terminalCause: "response",
			settlement: { status: "done" },
			responseMessageId: "8_0",
		},
	});
	assert.match(host.textContent ?? "", /3/);
	assert.doesNotMatch(host.textContent ?? "", /including waits|含等待/);
	assert.match(host.querySelector("button")?.getAttribute("aria-label") ?? "", /includes waits|包含等待/);
	assert.equal(vi.getTimerCount(), 0);
	await act(async () => vi.advanceTimersByTime(5000));
	assert.match(host.textContent ?? "", /3/);
});

test("presented live process uses the standalone divider gap; settled disclosure retains its compact divider", async () => {
	const style = document.createElement("style");
	style.textContent = readFileSync(
		new NodeURL("../../../../src/features/workbench/conversation/activity/header.css", import.meta.url),
		"utf8",
	);
	document.head.append(style);
	try {
		await render(base);
		const live = host.querySelector<HTMLElement>(".run-activity-header");
		assert.ok(live);
		assert.equal(live.dataset.runCollapsible, "false");
		assert.equal(live.querySelector("button") === null, true);
		assert.equal(
			getComputedStyle(live).getPropertyValue("--run-divider-gap").replace(/\s/g, ""),
			"calc(var(--spacing)*2)",
		);
		await render({ ...base, running: false, members: ["message:2_0"] });
		const settled = host.querySelector<HTMLElement>(".run-activity-header");
		assert.ok(settled);
		assert.equal(settled.dataset.runCollapsible, "true");
		const button = settled.querySelector("button");
		assert.ok(button);
		await act(async () => button.focus());
		assert.equal(button.matches(":focus-visible"), true);
		assert.equal(getComputedStyle(button).outlineOffset, "0px");
		assert.equal(getComputedStyle(button).outline, "2px solid var(--ring)");
		assert.equal(getComputedStyle(settled).getPropertyValue("--run-divider-gap"), "var(--ui-conversation-grouped-gap)");
		const divider = Array.from(style.sheet?.cssRules ?? []).find(
			(rule) => rule instanceof CSSStyleRule && rule.selectorText === ".run-activity-header::after",
		);
		assert.ok(divider instanceof CSSStyleRule);
		assert.equal(divider.style.getPropertyValue("margin-block-start"), "var(--run-divider-gap)");
		assert.equal(divider.style.getPropertyValue("border-block-start"), "1px solid var(--line)");
		// JSDOM schedules selectionchange when focus moves; drain that DOM task.
		await act(async () => vi.advanceTimersByTime(0));
	} finally {
		style.remove();
	}
});

test("source duration thresholds use narrow compound units and subsecond running says Working", async () => {
	assert.equal(formatRunElapsed(59999, "en"), "59s");
	assert.equal(formatRunElapsed(60000, "en"), "1m");
	assert.equal(formatRunElapsed(61000, "en"), "1m 1s");
	assert.equal(formatRunElapsed(120000, "en"), "2m");
	assert.equal(formatRunElapsed(3600000, "en"), "1h");
	assert.equal(formatRunElapsed(3661000, "en"), "1h 1m 1s");
	assert.equal(formatRunElapsed(86401000, "en"), "1d 1s");
	await render({ ...base, admittedAtMs: 4500 });
	assert.match(host.textContent ?? "", /Working|正在处理/);
	assert.doesNotMatch(host.textContent ?? "", /0s|0秒/);
});

test("settled duration fallback keeps English narrow units inside a translated label", async () => {
	await render({
		...base,
		running: false,
		members: ["message:2_0"],
		result: {
			id: "1",
			terminalEntryId: "9",
			admittedAtMs: 1000,
			settledAtMs: 90000,
			terminalCause: "response",
			settlement: { status: "done" },
			responseMessageId: "8_0",
		},
	});
	assert.equal(host.textContent, "用时 1m 29s");
	assert.match(host.querySelector("button")?.getAttribute("aria-label") ?? "", /包含等待/);
	assert.equal(vi.getTimerCount(), 0);
});

test("missing or inverted time is unknown; paused execution never starts a clock", async () => {
	await render({ ...base, admittedAtMs: undefined });
	assert.match(host.textContent ?? "", /Activity|活动/);
	assert.doesNotMatch(host.textContent ?? "", /Working for|用时/);
	assert.equal(vi.getTimerCount(), 0);
	await render({ ...base, running: false });
	assert.equal(host.textContent, "");
	assert.equal(vi.getTimerCount(), 0);
	await render({
		...base,
		running: false,
		members: ["message:2_0"],
		result: {
			id: "1",
			terminalEntryId: "9",
			admittedAtMs: 5000,
			settledAtMs: 1000,
			terminalCause: "response",
			settlement: { status: "done" },
		},
	});
	assert.match(host.textContent ?? "", /previous messages|前面的/);
	assert.doesNotMatch(host.textContent ?? "", /Elapsed|用时/);
});

test("manual run choice survives row unmount and same-client scope navigation without carrying into another scope", async () => {
	const client: AppClient = {
		call: vi.fn(async () => {
			throw new Error("Disconnected view must not read");
		}),
		observe: vi.fn(async () => {
			throw new Error("No observation");
		}),
	};
	function Probe() {
		const owner = useActivityTranscript();
		assert.ok(owner);
		return (
			<button type="button" onClick={() => owner.setGroupChoice("run:1", true)}>
				{String(owner.groupChoices.get("run:1"))}
			</button>
		);
	}
	async function show(scope: Scope, visible: boolean) {
		await act(async () =>
			renderer.render(
				<AppClientProvider client={client}>
					<ActivityTranscriptProvider scope={scope} connected={false} running={false}>
						{visible && <Probe />}
					</ActivityTranscriptProvider>
				</AppClientProvider>,
			),
		);
	}
	const scope = { workspaceId: "w", conversationId: "c" };
	await show(scope, true);
	await act(async () => host.querySelector("button")?.click());
	assert.equal(host.textContent, "true");
	await show(scope, false);
	await show(scope, true);
	assert.equal(host.textContent, "true");
	await show({ ...scope, conversationId: "other" }, true);
	assert.equal(host.textContent, "undefined");
	await show(scope, true);
	assert.equal(host.textContent, "true");
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
});
