import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	addPartial,
	anchored,
	assertLongHistoryAcceptance,
	continuousDocumentState,
	executionState,
	observeExecution,
	observeStream,
	prependEvidence,
	streamEvidence,
	viewport,
} from "./gui-long-history.mjs";

function streamModel(initial = {}) {
	let value = {
		executionState: "running",
		partial: null,
		jump: true,
		scrollTop: 100,
		scrollHeight: 1000,
		clientHeight: 500,
		rows: [{ key: "message:a", top: 100, visible: true }],
		...initial,
	};
	let now = 0;
	let nextFrame = 0;
	let deadline;
	const frames = new Map();
	const observer = runInNewContext(`(${observeStream.toString()})(document,read)`, {
		document: {},
		read: () => {
			if (value instanceof Error) throw value;
			return value;
		},
		performance: { now: () => now },
		requestAnimationFrame: (callback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id) => frames.delete(id),
		setTimeout: (callback) => {
			deadline = callback;
			return 1;
		},
		clearTimeout: () => {
			deadline = undefined;
		},
	});
	return {
		observer,
		callback: () => frames.values().next().value,
		frame(update) {
			value = update === null || update instanceof Error ? update : { ...value, ...update };
			now += 16;
			const [id, callback] = frames.entries().next().value ?? [];
			frames.delete(id);
			callback?.();
		},
		timeout: () => deadline?.(),
		resources: () => frames.size + Number(!!deadline),
	};
}

test("post-wheel frame sampling captures exact distinct running text between host polls, not length or terminal text", () => {
	const model = streamModel({ partial: "aa" });
	for (const partial of ["aa", "", " ", null, "bb", "cc"]) model.frame({ partial });
	model.frame({ executionState: "ready", partial: "dd" });
	assert.equal(model.observer.done, true);
	const observation = model.observer.stop();
	assert.deepEqual(
		Array.from(observation.partialObservations, (sample) => sample.units),
		[2, 2, 2],
	);
	assert.equal(observation.samples.at(-1).state, "ready");
	const evidence = streamEvidence(observation);
	assert.equal(evidence.streamValidation, "validated");
	assert.equal(evidence.streamPartialSamples, 3);
	assert.equal(evidence.streamAnchorSamples.length, 8);
	assert.equal(model.resources(), 0);
	assert.ok(!JSON.stringify(observation).includes('"aa"'));
});

test("stream sampler cannot count before leaving bottom or recover earlier partials after ready", () => {
	const notAway = streamModel({ jump: false, partial: "pre-wheel" });
	assert.equal(notAway.observer.stop().reason, "not-away-from-bottom");
	assert.equal(notAway.observer.stop().partialObservations.length, 0);
	assert.throws(() => streamEvidence(notAway.observer.stop()), /Incomplete frame observation/);
	const ready = streamModel({ executionState: "ready", partial: "completed" });
	const evidence = streamEvidence(ready.observer.stop());
	assert.equal(evidence.streamPartialSamples, 0);
	assert.equal(evidence.streamValidation, "notvalidated");
	assert.equal(ready.resources(), 0);
});

test("transient unknown state, missing anchor, drift, invalid geometry and read failures are latched", () => {
	for (const [update, reason] of [
		[{ executionState: "unknown" }, "unknown-execution-state"],
		[{ rows: [] }, "missing-anchor"],
		[{ rows: [{ key: "message:a", top: 200 }] }, "anchor-moved"],
		[{ rows: [{ key: "message:a", top: Number.NaN }] }, "anchor-moved"],
		[null, "missing-viewport"],
		[new Error("read failed"), "read-failed"],
	]) {
		const model = streamModel({ partial: "first" });
		model.frame(update);
		const failed = JSON.stringify(model.observer.stop());
		model.frame({ executionState: "ready", rows: [{ key: "message:a", top: 100 }] });
		assert.equal(model.observer.stop().reason, reason);
		assert.equal(JSON.stringify(model.observer.stop()), failed);
		assert.equal(model.resources(), 0);
		assert.throws(() => streamEvidence(model.observer.stop()), /Incomplete frame observation/);
	}
});

test("frame sampler bounds duration, frames, partial count and size, and disposes on early stop", () => {
	const timeout = streamModel();
	timeout.timeout();
	assert.equal(timeout.observer.stop().reason, "timeout");
	const frames = streamModel();
	for (let n = 0; n < 2050; n++) frames.frame({});
	assert.equal(frames.observer.stop().reason, "frame-count-limit");
	assert.equal(frames.observer.stop().samples.length, 2048);
	const count = streamModel();
	for (let n = 0; n < 130; n++) count.frame({ partial: `sample:${n}` });
	assert.equal(count.observer.stop().reason, "partial-count-limit");
	assert.equal(count.observer.stop().partialObservations.length, 128);
	const size = streamModel({ partial: "a".repeat(65537) });
	assert.equal(size.observer.stop().reason, "partial-size-limit");
	const cancelled = streamModel();
	const retainedCallback = cancelled.callback();
	assert.equal(cancelled.observer.stop().reason, "cancelled");
	const stopped = JSON.stringify(cancelled.observer.stop());
	retainedCallback();
	assert.equal(JSON.stringify(cancelled.observer.stop()), stopped);
	for (const model of [timeout, frames, count, size, cancelled]) {
		assert.equal(model.resources(), 0);
		assert.throws(() => streamEvidence(model.observer.stop()), /Incomplete frame observation/);
	}
});

test("execution-start diagnostics distinguish missing status from missing partial, stay bounded and dispose", () => {
	let callback;
	let stopped = false;
	let state = { executionState: "ready", running: false, partial: null };
	const observer = runInNewContext(`(${observeExecution.toString()})(document,read)`, {
		document: { body: {} },
		read: () => state,
		performance: { now: () => 100 },
		MutationObserver: class {
			constructor(take) {
				callback = take;
			}
			observe() {}
			disconnect() {
				stopped = true;
			}
		},
	});
	for (let n = 0; n < 140; n++) {
		state = { executionState: n > 70 ? "running" : "ready", running: n > 70, partial: "private-fixture".repeat(n + 1) };
		callback();
	}
	const result = observer.stop();
	assert.equal(stopped, true);
	assert.equal(result.samples.length, 128);
	assert.equal(result.runningSeen, true);
	assert.equal(result.partialSeen, true);
	assert.ok(result.samples.some((sample) => sample.state === "ready" && sample.partialUnits > 0));
	assert.ok(!JSON.stringify(result).includes("private-fixture"));
});

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
		continuousDocument: { status: "validated", exactOriginal: true, startEndStart: true },
		scopeIsolation: true,
		streamValidation: "validated",
		persistedProbe: { userKey: "message:user", answerKey: "message:answer" },
	};
	const reopened = { ...first, readOnly: true };
	assertLongHistoryAcceptance(first, reopened);
	for (const broken of [
		{ ...first, prepend: { status: "notvalidated" } },
		{ ...first, continuousDocument: { status: "notvalidated" } },
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
	assert.ok(source.indexOf("await wheel(-200);") < source.indexOf("globalThis.__hipiStreamObservation="));
	assert.match(source, /finally \{[\s\S]*o\.stop\(\);delete globalThis\.__hipiStreamObservation/);
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

test("continuous document observations require one canonical body and both real paragraph boundaries", () => {
	const paragraphs = [
		{ textContent: "lead", getBoundingClientRect: () => ({ top: 20, bottom: 40 }) },
		{ textContent: "tail\nEND", getBoundingClientRect: () => ({ top: 60, bottom: 1200 }) },
	];
	let complete = true;
	const body = { querySelectorAll: () => paragraphs };
	const rows = [{ dataset: { messageId: "one" }, querySelector: () => (complete ? body : null) }];
	const document = {
		querySelectorAll: () => rows,
		querySelector: () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 500 }) }),
	};
	const before = continuousDocumentState(document, "one");
	assert.equal(before.text, "lead\n\ntail\nEND");
	assert.equal(before.startVisible, true);
	assert.equal(before.endVisible, false);
	paragraphs[0].getBoundingClientRect = () => ({ top: -700, bottom: -680 });
	paragraphs[1].getBoundingClientRect = () => ({ top: -660, bottom: 480 });
	const after = continuousDocumentState(document, "one");
	assert.equal(after.text, before.text);
	assert.equal(after.startVisible, false);
	assert.equal(after.endVisible, true);
	complete = false;
	assert.equal(continuousDocumentState(document, "one"), null);
	complete = true;
	rows.push(rows[0]);
	assert.equal(continuousDocumentState(document, "one"), null);
});
