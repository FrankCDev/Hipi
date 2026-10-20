import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	addPartial,
	anchored,
	assertLongHistoryAcceptance,
	executionState,
	prependEvidence,
	viewport,
} from "./gui-long-history.mjs";

const snap = (top, index = 0, scrollTop = 300) => ({ scrollTop, rows: [{ key: "message:a", top, index }] });
test("prepend uses last observed old-index wheel baseline, never requested wheel delta", () => {
	const before = snap(100);
	assert.equal(
		prependEvidence([snap(150, 0, 250), snap(170, 0, 230)], before, snap(170, 32, 3000), "message:a").status,
		"validated",
	);
	assert.equal(prependEvidence([snap(170, 32, 3000)], before, snap(170, 32, 3000), "message:a").status, "notvalidated");
	assert.equal(prependEvidence([snap(170, 0, 230)], before, snap(170, 0, 230), "message:a").status, "notvalidated");
	assert.throws(() => prependEvidence([snap(170, 0, 230)], before, snap(0, 32, 3000), "message:a"), /Anchor moved/);
});
test("stream and expansion anchor reject drift, missing rows and non-finite geometry", () => {
	anchored(snap(30), snap(32), "message:a");
	assert.throws(() => anchored(snap(30), snap(200), "message:a"), /Anchor moved/);
	assert.throws(() => anchored(snap(30), { rows: [] }, "message:a"), /remain mounted/);
	assert.throws(() => anchored(snap(30), snap(Number.NaN), "message:a"), /finite/);
});
test("partial evidence excludes null, empty, duplicate and completed text", () => {
	const samples = new Set();
	for (const partial of [null, "", " ", "a", "a", "ab"]) addPartial(samples, { running: true, partial });
	addPartial(samples, { running: false, partial: "abc" });
	assert.equal(samples.size, 2);
	addPartial(samples, { running: true, partial: "abc" });
	assert.equal(samples.size, 3);
});
test("missing real scroll region cannot become viewport evidence", () =>
	assert.equal(viewport({ querySelector: () => null }), null));

function modelDocument({
	states = ["Running"],
	cancel = true,
	label = "faux-1",
	alert = false,
	connection = false,
} = {}) {
	return {
		querySelector(selector) {
			if (selector === ".conversation-panel .connection-bar") return connection ? {} : null;
			if (selector !== ".conversation-model-controls") return null;
			return {
				querySelector: (s) => (s === ".model-status-trigger" ? { textContent: label } : alert ? {} : null),
				querySelectorAll: (s) =>
					(s === "button" ? (cancel ? ["Cancel execution"] : []) : states).map((textContent) => ({ textContent })),
			};
		},
	};
}
test("global running evidence does not depend on virtual partial and rejects pending, failed or disconnected controls", () => {
	assert.equal(executionState(modelDocument()), "running");
	assert.equal(executionState(modelDocument({ states: [], cancel: false })), "ready");
	for (const overrides of [
		{ label: "Loading…" },
		{ states: ["Paused"] },
		{ states: ["Running", "Missing"] },
		{ alert: true },
		{ connection: true },
		{ cancel: false },
	])
		assert.equal(executionState(modelDocument(overrides)), "unknown");
	assert.equal(executionState({ querySelector: () => null }), "unknown");
});
test("acceptance cannot promote incomplete native observations or duplicated restart submissions", () => {
	const first = {
		prepend: { status: "validated" },
		oldestReached: true,
		expansion: { status: "validated" },
		scopeIsolation: true,
		streamValidation: "validated",
		persistedProbe: { userKey: "message:user", answerKey: "message:answer" },
	};
	const reopened = { ...first, readOnly: true };
	assertLongHistoryAcceptance(first, reopened);
	for (const broken of [
		{ ...first, prepend: { status: "notvalidated" } },
		{ ...first, expansion: { status: "notvalidated" } },
		{ ...first, streamValidation: "notvalidated" },
	])
		assert.throws(() => assertLongHistoryAcceptance(broken, reopened));
	assert.throws(() => assertLongHistoryAcceptance(first, { ...reopened, readOnly: false }));
	assert.throws(() => assertLongHistoryAcceptance(first, { ...reopened, persistedProbe: { userKey: "different" } }));
});
test("scenario stays separate, preserves native lifecycle, and cannot mutate application state through CDP", async () => {
	const source = await readFile(new URL("./gui-long-history.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(
		source,
		/scrollTop\s*=|hipiWorkDesktop\.request\(|setResponses|tokensPerSecond|localStorage|sessionStorage/,
	);
	const entry = await readFile(new URL("./smoke-packaged-long-history.mjs", import.meta.url), "utf8");
	assert.match(entry, /scenario: "long-history"/);
	assert.match(entry, /verify: verifyColdHistory/);
	assert.match(entry, /assertLongHistoryAcceptance/);
	const harness = await readFile(new URL("./smoke-packaged-gui.mjs", import.meta.url), "utf8");
	assert.match(harness, /export async function runPackagedGui/);
	assert.match(harness, /await assertNoPackageProcesses\(appDirectory\)/);
	assert.match(harness, /safeCleanup = scenarioResourcesClosed/);
	assert.match(harness, /if \(process.argv\[1\].*await runPackagedGui\(\)/);
	assert.doesNotMatch(harness, /--no-sandbox|disable-web-security/);
});
