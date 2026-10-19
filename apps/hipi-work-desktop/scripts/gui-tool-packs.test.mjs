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

test("mouse close targets only the fixed X and both close routes await actual parent focus", async () => {
	for (const mouse of [false, true]) {
		const calls = [];
		let polls = 0;
		const trigger = { textContent: "Tool packs" };
		await closeToolPacks(
			{},
			{
				click: async (_cdp, selector) => calls.push(selector),
				pressKey: async (_cdp, key) => calls.push(key),
				until,
				evaluate: async (_cdp, expression) => {
					polls++;
					return runInNewContext(expression, {
						document: {
							querySelector: () => null,
							querySelectorAll: () => [trigger],
							activeElement: polls < 2 ? null : trigger,
						},
					});
				},
			},
			mouse,
		);
		assert.deepEqual(calls, [mouse ? '.tool-packs-dialog button[data-slot="dialog-close"]' : "Escape"]);
		assert.equal(polls, 2);
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
test("ambiguous or absent dialogs cannot become lifecycle evidence", () => {
	for (const nodes of [[], [{}, {}]]) assert.equal(readToolPacks({ querySelectorAll: () => nodes }, ".dialog"), null);
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
	const section = {
		textContent: "Authorize live access",
		querySelector: (selector) => (selector === "h3" ? { textContent: "Authorize live access" } : { checked: false }),
		querySelectorAll: () => [
			{ textContent: "15 minutes", disabled: false },
			{ textContent: "Authorize live access", disabled: true },
		],
	};
	const root = {
		textContent: "No tool packs on this page.",
		children: [section],
		querySelector: (selector) => (selector === "h2" ? { textContent: "Tool packs" } : null),
		querySelectorAll: (selector) => (selector === "section" ? [section] : []),
	};
	section.parentElement = root;
	const state = readToolPacks({ querySelectorAll: () => [root] }, ".dialog");
	assert.equal(state.loaded, true);
	assert.equal(state.disclosure.disabled, true);
	root.textContent = "Initial shell";
	assert.equal(readToolPacks({ querySelectorAll: () => [root] }, ".dialog").loaded, false);
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
	const clicked = [];
	const helpers = {
		async click(_cdp, _selector, label) {
			if (label)
				assert.ok(
					["Tool packs", "Binding history", "Active conversation bindings", "Read full source"].includes(label),
				);
			clicked.push(label);
			if (label === "Binding history") history = true;
			if (label === "Active conversation bindings") history = false;
			if (label === "Read full source") source = packageText;
		},
		async evaluate(_cdp, expression) {
			if (expression.startsWith("(function readToolPacks"))
				return { loaded: true, text: "Tool packs", cards: history ? [pack, binding] : [pack], source };
			return true;
		},
		async until(check) {
			const value = await check();
			assert.ok(value);
			return value;
		},
		async pressKey(_cdp, key) {
			assert.equal(key, "Escape");
		},
		async assertNoAlerts() {},
		async inspectModal(_cdp, selector, placement) {
			assert.equal(selector, ".tool-packs-dialog");
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
	assert.ok(clicked.includes("Read full source"));
});
