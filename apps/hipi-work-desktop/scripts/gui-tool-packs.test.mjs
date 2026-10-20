import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { until } from "./gui-flow.mjs";
import {
	bindingCard,
	closeToolPacks,
	exerciseToolPacks,
	packageDigest,
	packageText,
	packCard,
	readToolPacks,
} from "./gui-tool-packs.mjs";

const dialog = '.conversation-options-dialog[role="dialog"][data-section="tool-packs"]';
const panel = `${dialog} [data-slot="dialog-body"]`;

function toolPackSurface() {
	const heading = { textContent: "Tool packs" };
	const title = { textContent: "Tool packs" };
	const attributes = { section: "tool-packs" };
	const shell = {
		dataset: attributes,
		querySelector: (selector) => {
			if (selector === '[data-slot="dialog-title"]') return title;
			throw new Error(`Unexpected selector: ${selector}`);
		},
	};
	const sections = [];
	const root = {
		id: "capability-section",
		textContent: "No tool packs on this page.",
		children: sections,
		closest: (selector) => {
			assert.equal(selector, '.conversation-options-dialog[role="dialog"]');
			return shell;
		},
		querySelector: (selector) => (selector === ":scope > .capabilities-section-heading > h3" ? heading : null),
		querySelectorAll: (selector) => (selector === "section" ? sections : []),
	};
	const dialogs = [shell];
	const document = {
		querySelectorAll: (selector) => {
			if (selector === '[role="dialog"]') return dialogs;
			assert.equal(selector, panel);
			return [root];
		},
	};
	return { document, root, heading, title, attributes, dialogs, sections };
}

test("mouse close targets the capability X and both routes require closed dialogs and the unique actual trigger", async () => {
	for (const mouse of [false, true]) {
		const calls = [];
		let polls = 0;
		const trigger = { textContent: "Capabilities" };
		const oldTrigger = { textContent: "Tool packs" };
		const states = [
			{ dialog: {}, triggers: [trigger], active: trigger },
			{ dialog: null, triggers: [], active: null },
			{ dialog: null, triggers: [trigger, { ...trigger }], active: trigger },
			{ dialog: null, triggers: [trigger], active: oldTrigger },
			{ dialog: null, triggers: [trigger], active: trigger },
		];
		await closeToolPacks(
			{},
			{
				click: async (_cdp, selector) => calls.push(selector),
				pressKey: async (_cdp, key) => calls.push(key),
				until,
				evaluate: async (_cdp, expression) => {
					const state = states[polls++];
					return runInNewContext(expression, {
						document: {
							querySelector: (selector) => {
								assert.equal(selector, '[role="dialog"]');
								return state.dialog;
							},
							querySelectorAll: (selector) => {
								assert.equal(selector, "button.composer-add-trigger");
								return state.triggers;
							},
							activeElement: state.active,
						},
					});
				},
			},
			mouse,
		);
		assert.deepEqual(calls, [mouse ? `${dialog} button[data-slot="dialog-close"]` : "Escape"]);
		assert.equal(polls, states.length);
	}
});

test("fixture identity is exact UTF-8 JSON and exposes only a deterministic transform", () => {
	assert.equal(packageDigest, createHash("sha256").update(packageText, "utf8").digest("hex"));
	const fixture = JSON.parse(packageText);
	assert.equal(fixture.formatVersion, 1);
	assert.deepEqual(fixture.tools[0].pipeline, [{ op: "trimLineEnds" }]);
	assert.ok(Buffer.byteLength(packageText) < 65536);
});
test("pack assertions reject preview text, wrong digests, duplicates and stale state", () => {
	const card = { paragraphs: ["GUI Trim · 1.0.0 · Disabled", "Deterministic GUI fixture", packageDigest] };
	assert.equal(packCard({ cards: [card] }, "Disabled"), card);
	for (const cards of [[], [card, card], [{ paragraphs: [card.paragraphs[0], "wrong digest"] }]])
		assert.throws(() => packCard({ cards }, "Disabled"));
	assert.throws(() => packCard({ cards: [card] }, "Enabled"));
});
test("binding evidence requires exact model, digest, kind and authoritative visible status", () => {
	const paragraphs = ["Live tool access", packageDigest, "faux / faux-1", "Revoked · Expires: 1/1/2026"];
	const card = { paragraphs };
	assert.equal(bindingCard({ cards: [card] }, "Revoked"), card);
	assert.throws(() => bindingCard({ cards: [card] }, "Active"));
	for (const index of [0, 1, 2, 3]) {
		const changed = [...paragraphs];
		changed[index] = "wrong";
		assert.throws(() => bindingCard({ cards: [{ paragraphs: changed }] }, "Revoked"));
	}
});
test("ambiguous or absent tool-pack sections cannot become lifecycle evidence", () => {
	for (const nodes of [[], [{}, {}]]) assert.equal(readToolPacks({ querySelectorAll: () => nodes }, panel), null);
});
test("tool-pack evidence requires its selected section in the sole correctly titled capability dialog", () => {
	assert.equal(readToolPacks(toolPackSurface().document, panel).loaded, true);
	for (const invalidate of [
		({ root }) => {
			root.closest = () => null;
		},
		({ dialogs }) => {
			dialogs.push({});
		},
		({ title }) => {
			title.textContent = "File access & approvals";
		},
		({ attributes }) => {
			attributes.section = undefined;
		},
		({ attributes }) => {
			attributes.section = "files";
		},
	]) {
		const surface = toolPackSurface();
		invalidate(surface);
		assert.equal(readToolPacks(surface.document, panel), null);
	}
});
test("scope is required before sending any input", async () => {
	let sent = false;
	await assert.rejects(
		exerciseToolPacks(
			{
				request: () => {
					sent = true;
				},
			},
			{},
			"/tmp",
			{},
		),
		/Receipt scope required/,
	);
	assert.equal(sent, false);
});
test("disclosure checks the authorization submit button, not its preceding expiry combobox", () => {
	const { document, root, sections } = toolPackSurface();
	const section = {
		textContent: "Authorize live access",
		querySelector: (selector) => (selector === "h3" ? { textContent: "Authorize live access" } : { checked: false }),
		querySelectorAll: () => [
			{ textContent: "15 minutes", disabled: false },
			{ textContent: "Authorize live access", disabled: true },
		],
	};
	sections.push(section);
	section.parentElement = root;
	const state = readToolPacks(document, panel);
	assert.equal(state.loaded, true);
	assert.equal(state.disclosure.disabled, true);
	assert.equal(state.disclosure.selector, `${panel} > :nth-child(1)`);
	root.textContent = "Initial shell";
	assert.equal(readToolPacks(document, panel).loaded, false);
});

test("cold restart performs only read controls and validates retained uninstalled source and revoked binding", async () => {
	const pack = {
		selector: ".pack",
		paragraphs: ["GUI Trim · 1.0.0 · Uninstalled", packageDigest],
		buttons: [
			{ text: "Enable", disabled: true },
			{ text: "Authorize live access", disabled: true },
		],
	};
	const binding = {
		selector: ".binding",
		paragraphs: ["Live tool access", packageDigest, "faux / faux-1", "Revoked · Expires: date"],
		buttons: [{ text: "Revoke", disabled: true }],
	};
	let history = false;
	let source = null;
	let open = false;
	let escapes = 0;
	const trigger = {};
	const clicked = [];
	const helpers = {
		async click(_cdp, selector, label) {
			clicked.push({ selector, label });
			if (selector === ".composer-add-trigger") {
				assert.equal(label, undefined);
				assert.equal(open, false);
				open = true;
				return;
			}
			assert.equal(open, true);
			if (selector === ".composer-add-menu .capability-tools-trigger") {
				assert.equal(label, undefined);
				return;
			}
			assert.ok(["Binding history", "Active conversation bindings", "Read full source"].includes(label));
			assert.equal(selector, label === "Read full source" ? ".pack button" : `${panel} button`);
			if (label === "Binding history") history = true;
			if (label === "Active conversation bindings") history = false;
			if (label === "Read full source") source = packageText;
		},
		async evaluate(_cdp, expression) {
			if (expression.startsWith("(function readToolPacks")) {
				assert.equal(open, true);
				assert.ok(expression.endsWith(`(document, ${JSON.stringify(panel)})`));
				return { loaded: true, text: "Tool packs", cards: history ? [pack, binding] : [pack], source };
			}
			return runInNewContext(expression, {
				document: {
					querySelector: () => (open ? {} : null),
					querySelectorAll: () => [trigger],
					activeElement: open ? null : trigger,
				},
			});
		},
		async until(check) {
			const value = await check();
			assert.ok(value);
			return value;
		},
		async pressKey(_cdp, key) {
			assert.equal(key, "Escape");
			assert.equal(open, true);
			open = false;
			escapes++;
		},
		async assertNoAlerts() {},
		async inspectModal(_cdp, selector, placement) {
			assert.equal(selector, dialog);
			assert.equal(placement, "center");
			return { titleReachable: true, closeReachable: true, scrolledToBottom: true };
		},
		async capture(_cdp, _directory, name) {
			assert.equal(name, "tool-packs-reopened");
		},
	};
	const result = await exerciseToolPacks(
		{ request: () => assert.fail("No direct CDP input in cold read") },
		helpers,
		"unused",
		{ reopened: true, expectedScope: { workspaceId: "work", conversationId: "conversation" } },
	);
	assert.equal(result.coldRead, true);
	assert.equal(result.managementOnly, true);
	assert.equal(result.retainedGeometry.closeReachable, true);
	assert.equal(result.escapeFocus, true);
	assert.ok(clicked.some(({ label }) => label === "Read full source"));
	assert.deepEqual(clicked.slice(0, 2), [
		{ selector: ".composer-add-trigger", label: undefined },
		{ selector: ".composer-add-menu .capability-tools-trigger", label: undefined },
	]);
	assert.equal(escapes, 1, "The capability surface closes directly, without an obsolete settings parent");
	assert.equal(open, false);
});
