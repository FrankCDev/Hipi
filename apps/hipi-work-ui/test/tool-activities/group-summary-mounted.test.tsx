// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { type GroupSummaryContent, useGroupSummary } from "../../src/features/tool-activities/group-summary.tsx";

let host: HTMLDivElement;
let root: Root;
function Summary({
	value,
	identity,
	immediate = false,
}: {
	value: GroupSummaryContent;
	identity: string;
	immediate?: boolean;
}) {
	const shown = useGroupSummary(value, identity, immediate ? "immediate" : "deferred");
	return (
		<output data-active={String(shown.active)}>
			{shown.title}:{shown.status}
		</output>
	);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.setSystemTime(0);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
const render = (identity: string, title = identity, immediate = false, active = true, status = title) =>
	act(async () => root.render(<Summary identity={identity} value={{ title, status, active }} immediate={immediate} />));
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
test("changed active keys dwell for one second while same-key text updates immediately", async () => {
	await render("a", "A", false, true, "pending");
	await advance(250);
	await render("a", "updated A", false, true, "running");
	assert.equal(host.textContent, "updated A:running");
	await render("b");
	await advance(749);
	assert.equal(host.textContent, "updated A:running");
	await advance(1);
	assert.equal(host.textContent, "b:b");
	await advance(1200);
	await render("c");
	assert.equal(host.textContent, "c:c");
});
test("churn cancels old timers, keeps the latest target and completion is immediate", async () => {
	await render("a");
	await advance(200);
	await render("b");
	await advance(300);
	await render("c");
	assert.equal(vi.getTimerCount(), 1);
	await advance(500);
	assert.equal(host.textContent, "c:c");
	await render("d");
	await advance(100);
	await render("summary", "Tool activity", true, false);
	assert.equal(host.textContent, "Tool activity:Tool activity");
	assert.equal(host.querySelector("output")?.dataset.active, "false");
	assert.equal(vi.getTimerCount(), 0);
	await advance(2000);
	assert.equal(host.textContent, "Tool activity:Tool activity");
});
test("unmount clears pending summary work; reduced motion does not invent a crossfade", async () => {
	document.documentElement.dataset.reducedMotion = "on";
	try {
		await render("a");
		await render("b");
		assert.equal(vi.getTimerCount(), 1);
		await act(async () => root.unmount());
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		delete document.documentElement.dataset.reducedMotion;
	}
});
