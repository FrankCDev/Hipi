import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const packageText = JSON.stringify(
	{
		formatVersion: 1,
		id: "example.gui-trim",
		version: "1.0.0",
		name: "GUI Trim",
		description: "Deterministic GUI fixture",
		tools: [{ id: "trim", name: "Trim", description: "Trim line ends", pipeline: [{ op: "trimLineEnds" }] }],
	},
	null,
	2,
);
export const packageDigest = createHash("sha256").update(packageText).digest("hex");
const dialog = '[role="dialog"]:has(> [data-slot="dialog-title"])';

// Runs in the renderer, reads only public DOM, and returns selectors rather than modifying nodes.
export function readToolPacks(document, selector) {
	const matches = [...document.querySelectorAll(selector)];
	if (matches.length !== 1) return null;
	const root = matches[0];
	if (root.querySelector("h2")?.textContent !== "Tool packs") return null;
	const path = (node) => {
		const parts = [];
		while (node !== root) {
			parts.unshift(`:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`);
			node = node.parentElement;
		}
		return `${selector} > ${parts.join(" > ")}`;
	};
	const cards = [...root.querySelectorAll("article")].map((e) => ({
		selector: path(e),
		paragraphs: [...e.querySelectorAll("p")].map((p) => p.textContent.trim()),
		buttons: [...e.querySelectorAll("button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
	}));
	const section = [...root.querySelectorAll("section")].find(
		(e) => e.querySelector("h3")?.textContent === "Authorize live access",
	);
	return {
		cards,
		text: root.textContent,
		loaded:
			cards.some((c) => c.paragraphs[0]?.startsWith("GUI Trim ·")) ||
			root.textContent.includes("No tool packs on this page."),
		source: root.querySelector("textarea[readonly]")?.value ?? null,
		input: root.querySelector("textarea:not([readonly])")?.value ?? null,
		disclosure: section
			? {
					selector: path(section),
					text: section.textContent,
					checked: section.querySelector('input[type="checkbox"]')?.checked,
					disabled: [...section.querySelectorAll("button")].find(
						(e) => e.textContent.trim() === "Authorize live access",
					)?.disabled,
				}
			: null,
	};
}
export function packCard(state, status) {
	const cards = state.cards.filter(
		(c) => c.paragraphs[0] === `GUI Trim · 1.0.0 · ${status}` && c.paragraphs.includes(packageDigest),
	);
	assert.equal(cards.length, 1, `Expected one exact ${status} package card`);
	return cards[0];
}
export function bindingCard(state, status) {
	const cards = state.cards.filter(
		(c) =>
			c.paragraphs[0] === "Live tool access" &&
			c.paragraphs.includes(packageDigest) &&
			c.paragraphs.includes("faux / faux-1") &&
			c.paragraphs.some((p) => p.startsWith(`${status} · Expires:`)),
	);
	assert.equal(cards.length, 1, `Expected one exact ${status} binding card`);
	return cards[0];
}

// Call once after the baseline completed screenshot; call read-only reopened mode after cold restart.
// expectedScope must come from the existing receipt's workspace-id/conversation-id DOM, not a bridge RPC.
export async function exerciseToolPacks(cdp, helpers, directory, { reopened = false, expectedScope }) {
	const { click, evaluate, until, pressKey, assertNoAlerts, capture } = helpers;
	assert.ok(expectedScope?.workspaceId && expectedScope?.conversationId, "Receipt scope required");
	const read = () => evaluate(cdp, `(${readToolPacks.toString()})(document, ${JSON.stringify(dialog)})`);
	const ready = async () =>
		until(async () => {
			await assertNoAlerts(cdp);
			const state = await read();
			return state?.loaded && !state.text.includes("Loading…") ? state : null;
		}, "tool pack read complete");
	const waitCard = async (kind, status) =>
		until(async () => {
			const state = await ready();
			try {
				return (kind === "pack" ? packCard : bindingCard)(state, status);
			} catch {
				return null;
			}
		}, `${kind} persisted ${status}`);
	const button = (card, label) => click(cdp, `${card.selector} button`, label);
	const close = async () => {
		await pressKey(cdp, "Escape");
		await until(
			() =>
				evaluate(
					cdp,
					`!document.querySelector(${JSON.stringify(dialog)}) && [...document.querySelectorAll('.workbench-settings button')].some(e => e === document.activeElement && e.textContent.trim() === 'Tool packs')`,
				),
			"tool packs parent focus",
		);
		await pressKey(cdp, "Escape");
		await until(
			() =>
				evaluate(
					cdp,
					`!document.querySelector('[role="dialog"]') && document.activeElement === document.querySelector('button[aria-label="Workbench settings"]')`,
				),
			"settings focus",
		);
	};
	await click(cdp, 'button[aria-label="Workbench settings"]');
	await click(cdp, ".workbench-settings button", "Tool packs");
	await ready();
	if (!reopened) {
		assert.equal((await read()).cards.length, 0, "Fresh profile must have no packages or bindings");
		await click(cdp, `${dialog} textarea:not([readonly])`);
		await cdp.request("Input.insertText", { text: packageText });
		assert.equal((await read()).input, packageText);
		await click(cdp, `${dialog} button`, "Validate and preview");
		await until(async () => (await ready()).text.includes(packageDigest), "exact source digest preview");
		assert.equal((await read()).cards.length, 0, "Preview must not install or authorize");
		await click(cdp, `${dialog} button`, "Install this version");
		const disabled = await waitCard("pack", "Disabled");
		assert.equal(disabled.buttons.find((b) => b.text === "Authorize live access")?.disabled, true);
		assert.equal((await read()).cards.length, 1, "Install must not create a binding");
		await button(disabled, "Enable");
		const enabled = await waitCard("pack", "Enabled");
		await button(enabled, "Read full source");
		await until(async () => (await ready()).source === packageText, "complete immutable source");
		await button(enabled, "Authorize live access");
		const disclosure = await until(async () => (await ready()).disclosure, "binding disclosure");
		assert.ok(
			disclosure.text.includes(
				`Workspace / conversation: ${expectedScope.workspaceId} / ${expectedScope.conversationId}`,
			),
		);
		assert.ok(disclosure.text.includes("Fixed conversation model: faux / faux-1"));
		assert.ok(disclosure.text.includes(`Immutable version SHA-256: ${packageDigest}`));
		assert.equal(disclosure.checked, false);
		assert.equal(disclosure.disabled, true, "Explicit consent must precede submission");
		assert.equal((await read()).cards.length, 1, "Viewing disclosure must not authorize");
		await click(cdp, `${disclosure.selector} input[type="checkbox"]`);
		await until(async () => {
			const d = (await ready()).disclosure;
			return d.checked && !d.disabled;
		}, "explicit consent recorded");
		await click(cdp, `${disclosure.selector} button`, "Authorize live access");
		const active = await waitCard("binding", "Active");
		await capture(cdp, directory, "tool-packs-active");
		await button(active, "Revoke");
		await until(
			async () => (await ready()).cards.every((c) => c.paragraphs[0] !== "Live tool access"),
			"revoked binding absent from active view",
		);
		await click(cdp, `${dialog} button`, "Binding history");
		await waitCard("binding", "Revoked");
		await button(await waitCard("pack", "Enabled"), "Disable");
		await button(await waitCard("pack", "Disabled"), "Uninstall");
	}
	const uninstalled = await waitCard("pack", "Uninstalled");
	assert.equal(uninstalled.buttons.find((b) => b.text === "Enable")?.disabled, true);
	assert.equal(uninstalled.buttons.find((b) => b.text === "Authorize live access")?.disabled, true);
	await click(cdp, `${dialog} button`, "Binding history");
	const revoked = await waitCard("binding", "Revoked");
	assert.equal(revoked.buttons.find((b) => b.text === "Revoke")?.disabled, true);
	await button(uninstalled, "Read full source");
	await until(async () => (await ready()).source === packageText, "uninstalled exact source retained");
	await click(cdp, `${dialog} button`, "Active conversation bindings");
	assert.equal((await ready()).cards.filter((c) => c.paragraphs[0] === "Live tool access").length, 0);
	await click(cdp, `${dialog} button`, "Binding history");
	await waitCard("binding", "Revoked");
	await assertNoAlerts(cdp);
	await capture(cdp, directory, reopened ? "tool-packs-reopened" : "tool-packs-uninstalled");
	await close();
	return {
		digest: packageDigest,
		scope: expectedScope,
		packageStatus: "uninstalled",
		bindingStatus: "revoked",
		sourceRetained: true,
		coldRead: reopened,
		managementOnly: true,
	};
}
