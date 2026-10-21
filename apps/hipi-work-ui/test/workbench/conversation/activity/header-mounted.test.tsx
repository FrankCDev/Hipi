// @vitest-environment jsdom
import assert from "node:assert/strict";
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
