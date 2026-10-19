import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const fixture = {
	workspace: "GUI 工作区",
	conversation: "GUI 会话",
	text: "真实桌面 中文流式验证",
	answer: "Hipi Work deterministic test answer. No model API or external tool was called.",
};
export async function evaluate(cdp, expression) {
	const result = await cdp.request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error("Renderer evaluation failed");
	return result.result.value;
}
export async function until(check, label, milliseconds = 30000) {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out: ${label}`);
}
async function click(cdp, selector, text) {
	const point = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
		if (location.href !== 'hipi-work://app/index.html') throw Error('Unexpected page');
		const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => !e.disabled && e.getClientRects().length && (!${JSON.stringify(text ?? "")} || e.textContent.trim() === ${JSON.stringify(text ?? "")}));
		if (nodes.length !== 1) return null;
		const e = nodes[0]; e.scrollIntoView({ block: 'center' }); const r=e.getBoundingClientRect();
		const x=r.x+r.width/2, y=r.y+r.height/2; if (!e.contains(document.elementFromPoint(x,y))) return null;
		return {x,y}; })()`,
			),
		`click ${selector}`,
	);
	await cdp.request("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
	await cdp.request("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}
async function fill(cdp, selector, value) {
	await click(cdp, selector);
	await cdp.request("Input.insertText", { text: value });
	assert.equal(await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).value`), value);
}
export async function capture(cdp, directory, name) {
	await evaluate(
		cdp,
		"document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
	);
	const image = await cdp.request("Page.captureScreenshot", { format: "png", fromSurface: true });
	const bytes = Buffer.from(image.data, "base64");
	assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.ok(bytes.length > 1000, "Empty screenshot");
	await writeFile(join(directory, `${name}.png`), bytes);
}
async function historyEvidence(cdp) {
	const rows = await until(async () => {
		const value = await evaluate(
			cdp,
			`Array.from(document.querySelectorAll('[data-message-key^="message:"]')).map(row => ({key:row.dataset.messageKey,user:!!row.querySelector('article.message-user'),assistant:!!row.querySelector('article.message-assistant'),text:row.textContent}))`,
		);
		return value.length === 2 &&
			value.some((row) => row.user && row.text.includes(fixture.text)) &&
			value.some((row) => row.assistant && row.text.includes(fixture.answer))
			? value
			: undefined;
	}, "two persisted history rows");
	const keys = rows.map((row) => row.key);
	assert.equal(new Set(keys).size, 2);
	return keys;
}
export async function exercise(cdp, directory, reopened = false) {
	await cdp.request("Runtime.enable");
	await cdp.request("Log.enable");
	await cdp.request("Page.enable");
	await until(
		() => evaluate(cdp, "location.href === 'hipi-work://app/index.html' && !!document.querySelector('.work-shell')"),
		"connected real workbench",
	);
	assert.deepEqual(
		await evaluate(
			cdp,
			"({bridge:typeof window.hipiWorkDesktop?.request,node:typeof window.require,process:typeof window.process})",
		),
		{ bridge: "function", node: "undefined", process: "undefined" },
	);
	// Use the app's language control rather than injecting preference state.
	if (await evaluate(cdp, `!!document.querySelector('button[aria-label="Switch to English"]')`))
		await click(cdp, 'button[aria-label="Switch to English"]');
	await until(() => evaluate(cdp, `!!document.querySelector('button[aria-label="New workspace"]')`), "English labels");
	if (reopened) {
		const selected = await evaluate(
			cdp,
			`document.querySelector('.toolbar-conversation')?.textContent === ${JSON.stringify(fixture.conversation)}`,
		);
		if (!selected) {
			const expanded = await evaluate(
				cdp,
				`document.querySelector('.project-toggle')?.getAttribute('aria-expanded') === 'true'`,
			);
			if (!expanded) await click(cdp, ".project-toggle");
			await click(cdp, ".conversation-list button.conversation-link", fixture.conversation);
		}
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.conversation-panel')?.textContent.includes(${JSON.stringify(fixture.answer)})`,
				),
			"persisted answer on reopen",
		);
		assert.ok(
			await evaluate(
				cdp,
				`document.querySelector('.conversation-panel')?.textContent.includes(${JSON.stringify(fixture.text)})`,
			),
		);
		await capture(cdp, directory, "reopened");
		return { reopened: true, messageKeys: await historyEvidence(cdp) };
	}
	await capture(cdp, directory, "initial");
	await click(cdp, '.conversation-nav button[aria-label="New workspace"]');
	await fill(cdp, '[role="dialog"] input', fixture.workspace);
	await click(cdp, '[role="dialog"] button[type="submit"]');
	await until(
		() =>
			evaluate(cdp, `document.querySelector('.project-name')?.textContent === ${JSON.stringify(fixture.workspace)}`),
		"workspace persisted",
	);
	await click(cdp, '.workspace-branch button[aria-label="New conversation"]');
	await fill(cdp, '[role="dialog"] input', fixture.conversation);
	await click(cdp, '[role="dialog"] [role="combobox"]');
	await until(
		() => evaluate(cdp, `document.querySelector('[role="option"]')?.textContent.includes('faux')`),
		"deterministic model catalog",
	);
	await click(cdp, '[role="option"]');
	await click(cdp, '[role="dialog"] button[type="submit"]');
	await until(() => evaluate(cdp, "!!document.querySelector('.composer textarea')"), "conversation composer");
	await evaluate(
		cdp,
		`(() => { window.__hipiGuiSmoke = { samples: [], running: false };
		const sample=()=>{ const e=document.querySelector('article.message-assistant[aria-busy="true"]');
		if(e){window.__hipiGuiSmoke.running=true; const t=e.textContent; const a=window.__hipiGuiSmoke.samples;
		if(a.at(-1)!==t && a.length<128)a.push(t);}};
		window.__hipiGuiSmoke.observer=new MutationObserver(sample); window.__hipiGuiSmoke.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-busy']}); })()`,
	);
	await fill(cdp, ".composer textarea", fixture.text);
	await click(cdp, '.composer button[type="submit"]');
	await until(() => evaluate(cdp, "window.__hipiGuiSmoke.running"), "streaming DOM");
	await capture(cdp, directory, "streaming");
	await click(cdp, 'button[aria-label="Conversation details"]');
	await until(
		() =>
			evaluate(cdp, `document.querySelector('[data-testid="execution-status"]')?.textContent === 'Result confirmed'`),
		"confirmed execution",
	);
	const observed = await evaluate(
		cdp,
		"(() => {const s=window.__hipiGuiSmoke;s.observer.disconnect();return {running:s.running,sampleCount:s.samples.length};})()",
	);
	assert.ok(observed.running && observed.sampleCount >= 2, "No incremental streaming evidence");
	assert.ok(
		await evaluate(
			cdp,
			`document.querySelector('.conversation-panel')?.textContent.includes(${JSON.stringify(fixture.answer)})`,
		),
	);
	assert.ok(
		await evaluate(
			cdp,
			`document.querySelector('.conversation-panel')?.textContent.includes(${JSON.stringify(fixture.text)})`,
		),
	);
	await capture(cdp, directory, "completed");
	return { ...observed, messageKeys: await historyEvidence(cdp) };
}
