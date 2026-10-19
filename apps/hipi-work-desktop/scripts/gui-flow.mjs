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
export async function pressKey(cdp, key) {
	const code = { Escape: 27, Home: 36, Enter: 13 }[key];
	assert.ok(code, "Unsupported smoke key");
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code });
}
async function dismissTo(cdp, selector) {
	await pressKey(cdp, "Escape");
	await until(
		() =>
			evaluate(
				cdp,
				`!document.querySelector('[role="dialog"], [role="menu"]') && document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
			),
		"overlay closed and trigger focus restored",
	);
}
async function selectEnglish(cdp) {
	await click(cdp, 'button[aria-label="Workbench settings"], button[aria-label="工作台设置"]');
	await until(
		() => evaluate(cdp, `!!document.querySelector('.workbench-settings[role="dialog"]')`),
		"workbench settings",
	);
	if (await evaluate(cdp, `!!document.querySelector('.workbench-settings button[aria-label="Switch to English"]')`))
		await click(cdp, '.workbench-settings button[aria-label="Switch to English"]');
	await until(
		() => evaluate(cdp, `!!document.querySelector('.workbench-settings button[aria-label="切换到中文"]')`),
		"English selected",
	);
	await dismissTo(cdp, 'button[aria-label="Workbench settings"]');
}
async function inspectControls(cdp) {
	await click(cdp, 'button[aria-label="Model status"]');
	await until(
		() =>
			evaluate(cdp, `document.querySelector('.model-status-popover[role="dialog"]')?.textContent.includes('faux-1')`),
		"model status contents",
	);
	assert.ok(
		await evaluate(
			cdp,
			`[...document.querySelectorAll('.model-status-popover button')].some(e => e.textContent.trim() === 'Refresh model status')`,
		),
	);
	await dismissTo(cdp, 'button[aria-label="Model status"]');
	await click(cdp, ".permission-controls button", "Agent file permissions");
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.permission-detail-dialog')?.textContent.includes('Authorize model context')`,
			),
		"permission details contents",
	);
	assert.ok(
		await evaluate(
			cdp,
			`[...document.querySelectorAll('.permission-detail-dialog button')].some(e => e.textContent.trim() === 'Refresh permissions')`,
		),
	);
	await dismissTo(cdp, ".permission-controls button");
	const actions = `header button[aria-label="Conversation actions: ${fixture.conversation}"]`;
	await click(cdp, actions);
	await pressKey(cdp, "Home");
	await until(
		() =>
			evaluate(
				cdp,
				`document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement.textContent.trim() === 'Rename conversation'`,
			),
		"keyboard rename menu item",
	);
	await pressKey(cdp, "Enter");
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('[role="dialog"] input')?.value === ${JSON.stringify(fixture.conversation)}`,
			),
		"rename dialog original title",
	);
	await dismissTo(cdp, actions);
	assert.equal(
		await evaluate(cdp, `document.querySelector('.toolbar-conversation')?.textContent`),
		fixture.conversation,
	);
	const sidebarActions = `.conversation-nav-item button[aria-label="Conversation actions: ${fixture.conversation}"]`;
	await click(cdp, sidebarActions);
	await click(cdp, '[role="menuitem"]', "View details");
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.conversation-preview-card[role="dialog"]')?.textContent.includes(${JSON.stringify(fixture.conversation)})`,
			),
		"sidebar conversation preview",
	);
	await dismissTo(cdp, sidebarActions);
	return {
		modelPopover: true,
		permissionDialog: true,
		keyboardRenameCancelled: true,
		sidebarPreview: true,
		focusRestored: true,
	};
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
export async function selectReopenedConversation(cdp) {
	const selected = await evaluate(
		cdp,
		`document.querySelector('.toolbar-conversation')?.textContent === ${JSON.stringify(fixture.conversation)}`,
	);
	if (selected) return;
	// The workbench shell can render before its workspace query has returned.
	// Missing is not collapsed: wait for the actual button before deciding to toggle it.
	const state = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
		const e = document.querySelector('.project-toggle');
		if (!e || e.disabled || !e.getClientRects().length) return null;
		const expanded = e.getAttribute('aria-expanded');
		return expanded === 'true' || expanded === 'false' ? { expanded } : null;
		})()`,
			),
		"reopened workspace toggle",
	);
	if (state.expanded === "false") await click(cdp, ".project-toggle");
	await click(cdp, ".conversation-list button.conversation-link", fixture.conversation);
}
export async function activityEvidence(cdp) {
	return until(async () => {
		const state = await evaluate(
			cdp,
			`(() => {
		const dialog = document.querySelector('[role="dialog"]');
		if (dialog?.querySelector('h2')?.textContent !== 'Tool activity') return null;
		const paragraphs = [...dialog.querySelectorAll('p')].map(e => e.textContent);
		return {
			failed: !!dialog.querySelector('[role="alert"]'),
			loading: [...dialog.querySelectorAll('output')].some(e => e.textContent === 'Reading records…'),
			section: paragraphs.find(t => t === 'Task-record section' || t === 'Retained-result section'),
			empty: paragraphs.includes('No activity in this scanned page. More records may be available on the next page.')
		}; })()`,
		);
		if (!state) return;
		assert.equal(state.failed, false, "Tool activity read failed");
		if (state.loading || !state.section) return;
		assert.equal(state.empty, true, "Deterministic no-tool fixture must have a confirmed empty activity page");
		return { section: state.section, empty: true };
	}, "successful tool activity page");
}
async function inspectActivities(cdp, directory, reopened) {
	await click(cdp, "button", "View activity");
	await activityEvidence(cdp);
	await click(cdp, '[role="dialog"] button', "Refresh this page");
	const evidence = await activityEvidence(cdp);
	await capture(cdp, directory, reopened ? "activities-reopened" : "activities");
	await click(cdp, '[role="dialog"] button', "Close activity");
	await until(() => evaluate(cdp, `!document.querySelector('[role="dialog"]')`), "activity dialog closed");
	return evidence;
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
	// Settings is a real popover; absence of its language button is not evidence of English.
	await selectEnglish(cdp);
	await until(() => evaluate(cdp, `!!document.querySelector('button[aria-label="New workspace"]')`), "English labels");
	if (reopened) {
		await selectReopenedConversation(cdp);
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
		const activities = await inspectActivities(cdp, directory, true);
		const controls = await inspectControls(cdp);
		await capture(cdp, directory, "reopened");
		return { reopened: true, activities, controls, messageKeys: await historyEvidence(cdp) };
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
	await click(cdp, '[role="dialog"] button', "Close");
	await until(() => evaluate(cdp, `!document.querySelector('[role="dialog"]')`), "conversation details closed");
	const activities = await inspectActivities(cdp, directory, false);
	const controls = await inspectControls(cdp);
	await capture(cdp, directory, "completed");
	return { ...observed, activities, controls, messageKeys: await historyEvidence(cdp) };
}
