import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sidebarPolicyAllowed, sidebarPolicyMarker } from "../../linux-sidebar-policy.mjs";
import {
	assertRetainedVirtualExtent,
	assertSidebarVirtualizationAcceptance,
	assertVirtualRecentFrame,
	startVirtualRecentTrace,
} from "./virtualization.mjs";

const seed = {
	active: { workspaceId: "active-work", conversationId: "active" },
	draft: "keep",
	recent: Array.from({ length: 600 }, (_, index) => ({
		workspaceId: "work",
		conversationId: `row-${index}`,
		title: `Repeated ${index % 7}`,
	})),
};

test("large native CI gate is success-gated, separately retained and never given the small policy", async () => {
	const workflow = await readFile(
		new URL("../../../../../.github/workflows/hipi-work-ci.yml", import.meta.url),
		"utf8",
	);
	const gate = workflow.indexOf("id: sidebar_virtualization\n");
	const next = workflow.indexOf("      - name:", gate);
	const step = workflow.slice(gate, next);
	assert.ok(gate > workflow.indexOf("id: sidebar\n"));
	assert.ok(gate < workflow.indexOf("id: gui_smoke\n"));
	assert.match(step, /success\(\) && steps\.sidebar\.outcome == 'success'/);
	assert.match(step, /node --conditions=source .*\/smoke-packaged-sidebar-virtualization\.mjs/);
	assert.doesNotMatch(step, /continue-on-error|HIPI_SIDEBAR_POLICY_ONCE|sudo|--no-sandbox|\|\| true/);
	assert.match(workflow, /always\(\) && steps\.sidebar_virtualization\.outcome != 'skipped'/);
	assert.match(workflow, /name: hipi-work-sidebar-virtualization-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.arch \}\}/);
	for (const extension of ["json", "png", "log"])
		assert.ok(workflow.includes(`.artifacts/hipi-work/packages/gui-sidebar-virtualization/*.${extension}`));
	assert.equal(workflow.split("HIPI_SIDEBAR_POLICY_ONCE:").length, 2);
});

test("large scenario cannot reuse the one-run small-sidebar sandbox allowance", () => {
	const env = {
		HIPI_SIDEBAR_POLICY_ONCE: sidebarPolicyMarker,
		GITHUB_ACTIONS: "true",
		GITHUB_EVENT_NAME: "push",
		GITHUB_REPOSITORY: "FrankCDev/Hipi",
		GITHUB_REF: "refs/heads/dot/develop",
		GITHUB_WORKFLOW_REF: "FrankCDev/Hipi/.github/workflows/hipi-work-ci.yml@refs/heads/dot/develop",
		GITHUB_RUN_NUMBER: "34",
		GITHUB_RUN_ATTEMPT: "1",
		HIPI_CI_MATRIX_OS: "ubuntu-24.04",
		RUNNER_OS: "Linux",
		GITHUB_SHA: "a".repeat(40),
	};
	assert.equal(sidebarPolicyAllowed(env, "sidebar", "linux"), true);
	assert.equal(sidebarPolicyAllowed(env, "sidebar-virtualization", "linux"), false);
});
function state() {
	return {
		samePanel: true,
		sameComposer: true,
		sameHistory: true,
		sameIde: true,
		sourceConnected: true,
		selected: [seed.active],
		draft: seed.draft,
		messages: [],
		fetching: false,
		revision: "1",
		viewport: { top: 0, bottom: 360, height: 360, scrollTop: 0 },
		list: { top: 0, bottom: 21601, rowsBottom: 21600, height: 21601 },
		rows: seed.recent.slice(0, 15).map((row, index) => ({
			...row,
			index,
			top: index * 36,
			bottom: (index + 1) * 36,
			height: 36,
			visible: index < 10,
			connected: true,
			links: 1,
		})),
	};
}
test("virtual oracle rejects eviction, duplicate identities, blank gaps, unbounded DOM and continuity loss", () => {
	assertVirtualRecentFrame(state(), seed);
	const baseline = { list: state().list, minHeight: 36, revision: "1" };
	assertRetainedVirtualExtent(state(), baseline, seed);
	for (const mutate of [
		(value) => {
			value.rows = [];
		},
		(value) => {
			value.rows[1] = { ...value.rows[0] };
		},
		(value) => {
			value.rows[1].conversationId = "wrong";
		},
		(value) => {
			value.rows[1].workspaceId = "wrong";
		},
		(value) => {
			value.rows[1].title = "wrong";
		},
		(value) => {
			value.rows.splice(1, 1);
		},
		(value) => {
			value.rows = seed.recent.slice(0, 100).map((row, index) => ({ ...value.rows[0], ...row, index }));
		},
		(value) => {
			value.rows[0].links = 2;
		},
		(value) => {
			value.sourceConnected = false;
		},
		(value) => {
			value.sameComposer = false;
		},
		(value) => {
			value.sameHistory = false;
		},
		(value) => {
			value.samePanel = false;
		},
		(value) => {
			value.sameIde = false;
		},
		(value) => {
			value.draft = "";
		},
		(value) => {
			value.selected = [seed.recent[0]];
		},
		(value) => {
			value.messages = ["submitted"];
		},
		(value) => {
			value.focusRequired = true;
			value.focusOnSource = false;
		},
	]) {
		const value = state();
		mutate(value);
		assert.throws(() => assertVirtualRecentFrame(value, seed));
	}
	for (const delta of [{ fetching: true }, { revision: "2" }, { list: { ...state().list, height: 9001 } }])
		assert.throws(() => assertRetainedVirtualExtent({ ...state(), ...delta }, baseline, seed));
});

test("virtual oracle permits real protected offscreen owner but not a viewport spacer hole", () => {
	const value = state();
	value.rows.push({
		...seed.recent[599],
		index: 599,
		top: 21564,
		bottom: 21600,
		height: 36,
		visible: false,
		connected: true,
		links: 1,
	});
	assertVirtualRecentFrame(value, seed);
	value.rows.splice(5, 1);
	assert.throws(() => assertVirtualRecentFrame(value, seed), /gap/);
});

test("a measured Show more sentinel is not mistaken for a blank virtual row", () => {
	const value = state();
	value.rows = value.rows.slice(0, 10);
	value.viewport.bottom = 392;
	value.viewport.height = 392;
	value.list = { top: 0, rowsBottom: 360, bottom: 392, height: 392 };
	assertVirtualRecentFrame(value, seed);
	value.rows.pop();
	assert.throws(() => assertVirtualRecentFrame(value, seed), /blank spacers/);
});

test("raw virtual observer samples every frame, records trusted inputs and releases its resources", () => {
	const callbacks = new Map(),
		listeners = new Map();
	let serial = 0,
		now = 0;
	const document = {
		defaultView: {
			performance: { now: () => now },
			requestAnimationFrame(callback) {
				callbacks.set(++serial, callback);
				return serial;
			},
			cancelAnimationFrame(id) {
				callbacks.delete(id);
			},
		},
		addEventListener(type, callback, capture) {
			assert.equal(capture, true);
			listeners.set(type, callback);
		},
		removeEventListener(type, callback) {
			assert.equal(listeners.get(type), callback);
			listeners.delete(type);
		},
	};
	const trace = startVirtualRecentTrace(document, () => ({ at: now }));
	for (const at of [1, 20, 35]) {
		now = at;
		const queued = [...callbacks.values()];
		callbacks.clear();
		for (const callback of queued) callback();
	}
	listeners.get("wheel")({ type: "wheel", isTrusted: true });
	const result = trace.stop();
	assert.deepEqual(result.frames, [{ at: 1 }, { at: 20 }, { at: 35 }]);
	assert.deepEqual(result.inputs, [{ type: "wheel", trusted: true, at: 35 }]);
	assert.equal(callbacks.size, 0);
	assert.equal(listeners.size, 0);
});

test("large acceptance distinguishes unavailable host thumb from observed native drag", () => {
	const value = {
		nativeInput: true,
		loaded: { canonicalEntries: 600, revealedEntries: 600, first: seed.recent[0], last: seed.recent.at(-1) },
		rawFrames: 100,
		peakRenderedRows: 35,
		wheelScrollback: true,
		keyboardScrollback: true,
		pageUpInputs: 3,
		menu: { retained: true, offscreenSource: true },
		thumb: { status: "unavailable", reason: "overlay host" },
	};
	const unavailable = assertSidebarVirtualizationAcceptance({ first: value, reopened: value });
	assert.equal(unavailable.status, "unqualified");
	assert.deepEqual(unavailable.missing, ["native-thumb-drag"]);
	assert.match(unavailable.reason, /not a product defect/);
	assert.match(unavailable.reason, /overlay host/);
	const positions = [
		{ phase: "middle", scrollTop: 8000, maximum: 16000 },
		{ phase: "end", scrollTop: 16000, maximum: 16000 },
		{ phase: "back", scrollTop: 0, maximum: 16000 },
	];
	const dragged = { ...value, thumb: { status: "observed", gutter: 15, positions } };
	assert.deepEqual(assertSidebarVirtualizationAcceptance({ first: dragged, reopened: dragged }), { status: "passed" });
	for (const pair of [
		{ first: value, reopened: dragged },
		{ first: dragged, reopened: value },
	])
		assert.equal(assertSidebarVirtualizationAcceptance(pair).status, "unqualified");
	for (const thumb of [
		{ status: "observed" },
		{ status: "observed", gutter: 0, from: 0, to: 8000 },
		{ status: "observed", gutter: 15, from: 0, to: 0 },
		{ status: "observed", gutter: 15, positions: positions.slice(0, 2) },
		{ status: "observed", gutter: 15, positions: positions.map((row) => ({ ...row, scrollTop: 0 })) },
		{ status: "observed", gutter: 15, positions: positions.map((row) => ({ ...row, scrollTop: 8000 })) },
		{ status: "observed", gutter: 15, positions: positions.map((row) => ({ ...row, maximum: 0 })) },
		{
			status: "observed",
			gutter: 15,
			positions: positions.map((row) => (row.phase === "back" ? { ...row, scrollTop: -1 } : row)),
		},
		{
			status: "observed",
			gutter: 15,
			positions: positions.map((row) => (row.phase === "end" ? { ...row, scrollTop: 20000 } : row)),
		},
	])
		assert.throws(() => assertSidebarVirtualizationAcceptance({ first: { ...value, thumb }, reopened: value }));
	for (const delta of [
		{ loaded: { ...value.loaded, canonicalEntries: 250 } },
		{ loaded: { ...value.loaded, canonicalEntries: 599, revealedEntries: 599 } },
		{ loaded: { ...value.loaded, revealedEntries: 500 } },
		{ rawFrames: 0 },
		{ peakRenderedRows: 600 },
		{ thumb: { status: "not_run" } },
		{ thumb: { status: "unavailable" } },
		{ thumb: { status: "unavailable", reason: " " } },
		{ thumb: { status: "unavailable", reason: true } },
		{ wheelScrollback: false },
		{ keyboardScrollback: false },
		{ pageUpInputs: 0 },
		{ menu: { retained: false } },
		{ menu: { retained: true, offscreenSource: false } },
	])
		assert.throws(() => assertSidebarVirtualizationAcceptance({ first: { ...value, ...delta }, reopened: value }));
});

test("native helper forbids JS input mutation and the fixture contains no submit command", async () => {
	const source = await readFile(new URL("./virtualization.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(
		source,
		/\.scrollIntoView\(|\.scrollTo\(|\.focus\(|\.blur\(|\.scrollTop\s*=(?!=)|dispatchEvent|new (?:MouseEvent|KeyboardEvent|PointerEvent)/,
	);
	assert.match(source, /Input\.dispatchMouseEvent/);
	assert.match(source, /Input\.dispatchKeyEvent/);
	assert.match(source, /status: ['"]unavailable['"]/);
	const fixture = await readFile(new URL("./virtualization-fixture.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(fixture, /runtime\.call\(['"]submit['"]/);
});
