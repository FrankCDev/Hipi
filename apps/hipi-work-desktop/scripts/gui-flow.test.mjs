import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	activityEvidence,
	appearanceChoice,
	assertNoAlerts,
	captureFailure,
	click,
	fixture,
	pressKey,
	resolvedTheme,
	selectReopenedConversation,
} from "./gui-flow.mjs";

test("click failure identifies requested text and refuses covered or ambiguous controls", async () => {
	for (const state of [
		{ count: 1, hit: false },
		{ count: 2, hit: false },
	]) {
		const cdp = {
			async request(method) {
				assert.equal(method, "Runtime.evaluate", "No input may be sent to an unverified target");
				return { result: { value: state } };
			},
		};
		await assert.rejects(
			click(cdp, '[role="dialog"] button', "Close", 1),
			/text="Close"; candidates=[12], centerHit=false/,
		);
	}
});

test("failure capture is bounded and redacts unknown button text; renderer loss never throws", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-gui-diagnostic-test-"));
	const node = {
		textContent: "private-content-must-not-be-recorded",
		getAttribute: () => null,
		getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
		getClientRects: () => [{}],
		closest: () => null,
		contains: () => false,
		get value() {
			throw new Error("Input values must never be read");
		},
	};
	const png = Buffer.alloc(1100);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png);
	const cdp = {
		async request(method, params) {
			if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
			assert.equal(method, "Runtime.evaluate");
			if (params.expression.startsWith("document.fonts.ready")) return { result: { value: undefined } };
			return {
				result: {
					value: runInNewContext(params.expression, {
						location: { href: "hipi-work://app/index.html" },
						document: { querySelectorAll: () => Array.from({ length: 105 }, () => node), elementFromPoint: () => null },
					}),
				},
			};
		},
	};
	try {
		assert.deepEqual(await captureFailure(cdp, directory), { controls: "saved", screenshot: "saved" });
		const raw = await readFile(join(directory, "failure-controls.json"), "utf8");
		assert.ok(!raw.includes("private-content"));
		const value = JSON.parse(raw);
		assert.equal(value.total, 105);
		assert.equal(value.controls.length, 100);
		assert.equal(value.truncated, true);
		assert.equal(value.controls[0].label, "<unrecognized>");
		assert.deepEqual(
			await captureFailure(
				{
					request: async () => {
						throw new Error("closed");
					},
				},
				directory,
			),
			{ controls: "unavailable", screenshot: "unavailable" },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function renderer({ expanded = true, delay = 0, selected = false } = {}) {
	const clicks = [];
	let reads = 0;
	const node = (name, y, textContent) => ({
		name,
		textContent,
		disabled: false,
		getClientRects: () => [{}],
		getBoundingClientRect: () => ({ x: 0, y, width: 20, height: 20 }),
		getAttribute: () => String(expanded),
		scrollIntoView() {},
		contains(other) {
			return other === this;
		},
	});
	const toggle = node("toggle", 0, "GUI 工作区");
	const conversation = node("conversation", 40, fixture.conversation);
	const document = {
		querySelector(selector) {
			if (selector === ".toolbar-conversation") return selected ? { textContent: fixture.conversation } : null;
			if (selector === ".project-toggle") return ++reads > delay ? toggle : null;
			throw new Error(`Unexpected selector: ${selector}`);
		},
		querySelectorAll(selector) {
			if (selector === ".project-toggle") return reads > delay ? [toggle] : [];
			if (selector === ".conversation-list button.conversation-link") return expanded ? [conversation] : [];
			throw new Error(`Unexpected selector: ${selector}`);
		},
		elementFromPoint(_x, y) {
			return y < 30 ? toggle : conversation;
		},
	};
	return {
		clicks,
		async request(method, params) {
			if (method === "Runtime.evaluate") {
				return {
					result: {
						value: runInNewContext(params.expression, {
							document,
							location: { href: "hipi-work://app/index.html" },
						}),
					},
				};
			}
			assert.equal(method, "Input.dispatchMouseEvent");
			if (params.type === "mouseReleased") {
				const target = document.elementFromPoint(params.x, params.y);
				clicks.push(target.name);
				if (target === toggle) expanded = !expanded;
			}
			return {};
		},
	};
}

test("keyboard smoke emits paired native CDP events and rejects unknown keys", async () => {
	const events = [];
	const cdp = {
		async request(method, params) {
			events.push({ method, ...params });
		},
	};
	await pressKey(cdp, "Escape");
	assert.deepEqual(events, [
		{ method: "Input.dispatchKeyEvent", type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
		{ method: "Input.dispatchKeyEvent", type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	]);
	await assert.rejects(pressKey(cdp, "Delete"), /Unsupported smoke key/);
	assert.equal(events.length, 2);
});

test("theme restoration distinguishes system preference from explicit light and dark", () => {
	assert.equal(resolvedTheme("Follow system", false), "light");
	assert.equal(resolvedTheme("Follow system", true), "dark");
	assert.equal(resolvedTheme("Light", true), "light");
	assert.equal(resolvedTheme("Dark", false), "dark");
	assert.throws(() => resolvedTheme("unknown", false), /Unknown appearance mode/);
});

test("appearance choice follows the Theme label association rather than an arbitrary combobox", async () => {
	const control = { id: "theme-choice", textContent: " Follow system ", getAttribute: () => "combobox" };
	const document = {
		querySelector(selector) {
			assert.equal(selector, '.settings-dialog[role="dialog"]');
			return {
				querySelectorAll: () => [
					{ textContent: "Language", htmlFor: "locale-choice" },
					{ textContent: "Theme", htmlFor: "theme-choice" },
				],
			};
		},
		getElementById(id) {
			assert.equal(id, "theme-choice");
			return control;
		},
	};
	const cdp = {
		async request(_method, params) {
			return { result: { value: runInNewContext(params.expression, { document, CSS: { escape: (value) => value } }) } };
		},
	};
	const choice = await appearanceChoice(cdp);
	assert.equal(choice.mode, "Follow system");
	assert.equal(choice.selector, "#theme-choice");
});

test("unexpected application alerts fail even without console errors or visible geometry", async () => {
	let elements = [];
	const cdp = {
		async request(_method, params) {
			return {
				result: {
					value: runInNewContext(params.expression, {
						document: {
							querySelectorAll(selector) {
								assert.equal(selector, '[role="alert"]');
								return elements;
							},
						},
					}),
				},
			};
		},
	};
	await assertNoAlerts(cdp);
	elements = [{ textContent: " Records could not be read ", getClientRects: () => [] }];
	await assert.rejects(assertNoAlerts(cdp), /Unexpected application alert.*Records could not be read/);
});

test("reopen waits for delayed workspace DOM and never collapses an already expanded branch", async () => {
	const cdp = renderer({ expanded: true, delay: 2 });
	await selectReopenedConversation(cdp);
	assert.deepEqual(cdp.clicks, ["conversation"]);
});

test("reopen expands an actually collapsed branch through input before selecting the conversation", async () => {
	const cdp = renderer({ expanded: false, delay: 1 });
	await selectReopenedConversation(cdp);
	assert.deepEqual(cdp.clicks, ["toggle", "conversation"]);
});

test("reopen preserves an already restored conversation selection without extra input", async () => {
	const cdp = renderer({ selected: true });
	await selectReopenedConversation(cdp);
	assert.deepEqual(cdp.clicks, []);
});

test("activity evidence requires a loaded successful page, not merely absence of console errors", async () => {
	let paragraphs = [];
	let loading = true;
	let failed = false;
	let reads = 0;
	const dialog = {
		querySelector(selector) {
			if (selector === "h2") return { textContent: "Tool activity" };
			if (selector === '[role="alert"]') return failed ? {} : null;
			throw new Error(`Unexpected selector: ${selector}`);
		},
		querySelectorAll(selector) {
			if (selector === "p") return paragraphs.map((textContent) => ({ textContent }));
			if (selector === "output") return loading ? [{ textContent: "Reading records…" }] : [];
			throw new Error(`Unexpected selector: ${selector}`);
		},
	};
	const cdp = {
		async request(method, params) {
			assert.equal(method, "Runtime.evaluate");
			if (++reads === 3) {
				loading = false;
				paragraphs = [
					"Task-record section",
					"No activity in this scanned page. More records may be available on the next page.",
				];
			}
			return { result: { value: runInNewContext(params.expression, { document: { querySelector: () => dialog } }) } };
		},
	};
	assert.deepEqual(await activityEvidence(cdp), { section: "Task-record section", empty: true });
	assert.equal(reads, 3);
	failed = true;
	await assert.rejects(activityEvidence(cdp), /Tool activity read failed/);
	failed = false;
	paragraphs = ["Task-record section"];
	await assert.rejects(activityEvidence(cdp), /confirmed empty activity page/);
});
