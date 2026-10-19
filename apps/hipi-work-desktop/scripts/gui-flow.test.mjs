import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { activityEvidence, fixture, pressKey, selectReopenedConversation } from "./gui-flow.mjs";

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
