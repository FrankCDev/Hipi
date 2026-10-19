import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderedFonts } from "./gui-fonts.mjs";
import { exerciseToolPacks } from "./gui-tool-packs.mjs";

export const fixture = {
	workspace: "GUI 工作区",
	conversation: "GUI 会话",
	text: "真实桌面 中文流式验证",
	answer: "Hipi Work deterministic test answer. No model API or external tool was called.",
};
const diagnosticLabels = [
	"Close",
	"Close activity",
	"Refresh this page",
	"View activity",
	"Conversation details",
	"Model status",
	"Refresh model status",
	"Agent file permissions",
	"Refresh permissions",
	"Authorize model context",
	"Rename conversation",
	"View details",
	"Workbench settings",
	"Appearance and language",
	"Save",
	"Cancel",
	"New workspace",
	"New conversation",
	"Switch to English",
	"切换到中文",
	"Toggle light / dark theme",
	"Conversation actions",
];
export function diagnosticTarget(selector, text) {
	if (diagnosticLabels.includes(text)) return text;
	const label = selector.match(/\[aria-label="([^"]+)"\]/)?.[1];
	if (diagnosticLabels.includes(label)) return label;
	if (label?.startsWith("Conversation actions: ")) return "Conversation actions";
	if (selector === ".permission-controls button") return "Agent file permissions";
	return "unrecognized target";
}
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
export async function click(cdp, selector, text, milliseconds = 30000) {
	let lastState;
	const point = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
		if (location.href !== 'hipi-work://app/index.html') throw Error('Unexpected page');
		const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => !e.disabled && e.getClientRects().length && (!${JSON.stringify(text ?? "")} || e.textContent.trim() === ${JSON.stringify(text ?? "")}));
		if (nodes.length !== 1) return { count: nodes.length, hit: false };
		const e = nodes[0]; e.scrollIntoView({ block: 'center' }); const r=e.getBoundingClientRect();
		const x=r.x+r.width/2, y=r.y+r.height/2;
		return { count: 1, hit: e.contains(document.elementFromPoint(x,y)), point: {x,y} }; })()`,
			).then((state) => {
				lastState = state;
				return state.hit ? state.point : null;
			}),
		`click ${selector.replaceAll("=", ":")}${text === undefined ? "" : ` label ${JSON.stringify(text)}`}`,
		milliseconds,
	).catch((error) => {
		throw new Error(
			`${error.message}; candidates ${lastState?.count ?? "unavailable"}, centerHit ${lastState?.hit ?? "unavailable"}`,
		);
	});
	await cdp.request("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
	await cdp.request("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}
async function fill(cdp, selector, value) {
	await click(cdp, selector);
	await cdp.request("Input.insertText", { text: value });
	assert.equal(
		await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).value`),
		value,
		"Native text input must match fixture text",
	);
}
export async function pressKey(cdp, key) {
	const code = { Escape: 27, Home: 36, Enter: 13 }[key];
	assert.ok(code, "Unsupported smoke key");
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code });
}
async function dismissTo(cdp, selector) {
	await pressKey(cdp, "Escape");
	await waitForOverlayClosed(cdp, selector);
}
export async function waitForOverlayClosed(cdp, selector, text, milliseconds = 30000) {
	await until(
		() =>
			evaluate(
				cdp,
				`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(!document.querySelector('[role="dialog"], [role="menu"]') && [...document.querySelectorAll(${JSON.stringify(selector)})].some(e => e === document.activeElement && (!${JSON.stringify(text ?? "")} || e.textContent.trim() === ${JSON.stringify(text ?? "")}))))))`,
			),
		`overlay closed and trigger focus restored: ${diagnosticTarget(selector, text)}`,
		milliseconds,
	);
}
async function waitForSelectClosed(cdp, selector) {
	await until(
		() =>
			evaluate(
				cdp,
				`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(!document.querySelector('[role="option"]') && document.activeElement === document.querySelector(${JSON.stringify(selector)})))))`,
			),
		"select closed and original combobox focus restored",
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
export async function assertNoAlerts(cdp) {
	const alerts = await evaluate(
		cdp,
		`Array.from(document.querySelectorAll('[role="alert"]')).slice(0, 10).map(e => e.textContent.trim().slice(0, 200))`,
	);
	assert.equal(alerts.length, 0, `Unexpected application alert: ${JSON.stringify(alerts)}`);
}
export function resolvedTheme(mode, systemDark) {
	assert.ok(["Light", "Dark", "Follow system"].includes(mode), "Unknown appearance mode");
	return mode === "Follow system" ? (systemDark ? "dark" : "light") : mode.toLowerCase();
}
export async function appearanceChoice(cdp) {
	return until(
		() =>
			evaluate(
				cdp,
				`(() => {
		const dialog = document.querySelector('.settings-dialog[role="dialog"]');
		if (!dialog) return null;
		const labels = [...dialog.querySelectorAll('label')].filter(e => e.textContent.trim() === 'Theme');
		if (labels.length !== 1) return null;
		const control = document.getElementById(labels[0].htmlFor);
		if (!control || control.getAttribute('role') !== 'combobox') return null;
		return { mode: control.textContent.trim(), selector: '#' + CSS.escape(control.id) };
	})()`,
			),
		"appearance theme choice",
	);
}
async function closeAppearance(cdp) {
	await pressKey(cdp, "Escape");
	await waitAppearanceClosed(cdp);
}
async function waitAppearanceClosed(cdp) {
	await until(
		() =>
			evaluate(
				cdp,
				`!document.querySelector('.settings-dialog') && !!document.querySelector('.workbench-settings[role="dialog"]') && [...document.querySelectorAll('.workbench-settings button')].some(e => e.textContent.trim() === 'Appearance and language' && e === document.activeElement)`,
			),
		"nested appearance closed with parent and trigger focus retained",
	);
}
async function inspectTheme(cdp, directory, reopened) {
	const settings = 'button[aria-label="Workbench settings"]';
	const toggle = '.workbench-settings button[aria-label="Toggle light / dark theme"]';
	const originalResolved = await evaluate(cdp, "document.documentElement.dataset.theme");
	assert.ok(["light", "dark"].includes(originalResolved), "Appearance resolved theme must be light or dark");
	await click(cdp, settings);
	await click(cdp, ".workbench-settings button", "Appearance and language");
	const original = await appearanceChoice(cdp);
	resolvedTheme(original.mode, false); // Reject unknown mode labels before changing anything.
	await assertNoAlerts(cdp);
	await closeAppearance(cdp);
	if (originalResolved === "dark") {
		await click(cdp, toggle);
		await until(
			() => evaluate(cdp, `document.documentElement.dataset.theme === 'light'`),
			"theme button light transition",
		);
	}
	await click(cdp, toggle);
	await until(() => evaluate(cdp, `document.documentElement.dataset.theme === 'dark'`), "theme button dark transition");
	await dismissTo(cdp, settings);
	await assertNoAlerts(cdp);
	await capture(cdp, directory, reopened ? "dark-reopened" : "dark-completed");
	// Toggle saves an explicit mode. Restore the original system/light/dark preference through the form.
	await click(cdp, settings);
	await click(cdp, ".workbench-settings button", "Appearance and language");
	const current = await appearanceChoice(cdp);
	await click(cdp, current.selector);
	await click(cdp, '[role="option"]', original.mode);
	await waitForSelectClosed(cdp, current.selector);
	await click(cdp, ".settings-dialog button", "Save");
	await waitAppearanceClosed(cdp);
	await click(cdp, ".workbench-settings button", "Appearance and language");
	assert.equal((await appearanceChoice(cdp)).mode, original.mode, "Original theme preference was not restored");
	await closeAppearance(cdp);
	await dismissTo(cdp, settings);
	const expected = resolvedTheme(
		original.mode,
		await evaluate(cdp, `matchMedia('(prefers-color-scheme: dark)').matches`),
	);
	await until(
		() => evaluate(cdp, `document.documentElement.dataset.theme === ${JSON.stringify(expected)}`),
		"original resolved theme restored",
	);
	return {
		originalMode: original.mode,
		originalResolved,
		restoredResolved: expected,
		darkCaptured: true,
		nestedEscapeFocus: true,
	};
}
export async function modalBounds(cdp, selector, milliseconds = 30000) {
	return until(
		async () => {
			const state = await evaluate(
				cdp,
				`(() => {
		if (location.href !== 'hipi-work://app/index.html') throw Error('Unexpected page');
		const dialog = document.querySelector(${JSON.stringify(selector)});
		if (!dialog) return null;
		const closes = [...dialog.querySelectorAll('button')].filter(e => e.textContent.trim() === 'Close');
		const body = dialog.querySelector('[data-slot="dialog-body"]');
		if (closes.length !== 1 || !body) return null;
		const close = closes[0];
		const rect = e => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
		const inside = r => r.width>0 && r.height>0 && r.x>=0 && r.y>=0 && r.x+r.width<=innerWidth+1 && r.y+r.height<=innerHeight+1;
		const d=rect(dialog), c=rect(close), b=rect(body);
		return { ready: dialog.dataset.placement === 'right' && inside(d) && inside(c) && !close.disabled && close.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)),
			dialog:d,close:c,body:b,scrollTop:body.scrollTop,clientHeight:body.clientHeight,scrollHeight:body.scrollHeight };
	})()`,
			);
			return state?.ready ? state : null;
		},
		`modal viewport and reachable Close: ${selector}`,
		milliseconds,
	);
}
export async function inspectModal(cdp, selector) {
	const before = await modalBounds(cdp, selector);
	const overflow = before.scrollHeight > before.clientHeight + 1;
	if (overflow) {
		await cdp.request("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: before.body.x + before.body.width / 2,
			y: before.body.y + before.body.height / 2,
			deltaX: 0,
			deltaY: before.scrollHeight,
		});
		await until(async () => {
			const after = await modalBounds(cdp, selector);
			return after.scrollTop + after.clientHeight >= after.scrollHeight - 2 ? after : null;
		}, "modal body scrolled to bottom with Close still reachable");
	}
	await modalBounds(cdp, selector);
	return { viewportContained: true, closeReachable: true, overflowingBody: overflow, scrolledToBottom: overflow };
}
async function inspectControls(cdp) {
	await click(cdp, 'button[aria-label="Model status"]');
	await until(
		() =>
			evaluate(
				cdp,
				`(() => { const dialog = document.querySelector('.model-status-popover[role="dialog"]'); return !!dialog?.textContent.includes('faux-1') && [...dialog.querySelectorAll('button')].some(e => e.textContent.trim() === 'Refresh model status'); })()`,
			),
		"model status model and refresh control ready",
	);
	await assertNoAlerts(cdp);
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
		"Permission dialog must contain Refresh permissions",
	);
	await assertNoAlerts(cdp);
	const permissionGeometry = await inspectModal(cdp, ".permission-detail-dialog");
	await click(cdp, ".permission-detail-dialog button", "Close");
	await waitForOverlayClosed(cdp, ".permission-controls button", "Agent file permissions");
	await click(cdp, ".permission-controls button", "Agent file permissions");
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
		"Cancelled rename must preserve conversation title",
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
		permissionGeometry,
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
	assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Renderer screenshot must be PNG");
	assert.ok(bytes.length > 1000, "Empty screenshot");
	await writeFile(join(directory, `${name}.png`), bytes);
}
export async function captureFailure(cdp, directory) {
	const result = { controls: "unavailable", screenshot: "unavailable" };
	try {
		const controls = await evaluate(
			cdp,
			`(() => {
		if (location.href !== 'hipi-work://app/index.html') throw Error('Unexpected page');
		const allowed = new Set(${JSON.stringify(diagnosticLabels)});
		const nodes = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')];
		return { total: nodes.length, truncated: nodes.length > 100, controls: nodes.slice(0,100).map(e => {
			const raw = (e.getAttribute('aria-label') || e.textContent || '').trim();
			const r = e.getBoundingClientRect();
			return { role: e.getAttribute('role') === 'menuitem' ? 'menuitem' : 'button',
				label: allowed.has(raw) ? raw : '<unrecognized>', visible: !!e.getClientRects().length,
				disabled: !!e.disabled, inDialog: !!e.closest('[role="dialog"]'), focused: e === document.activeElement,
				centerHit: e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) };
		}) };
	})()`,
		);
		await writeFile(join(directory, "failure-controls.json"), `${JSON.stringify(controls, null, 2)}\n`);
		result.controls = "saved";
	} catch {
		/* Diagnostic failure must not replace the original smoke failure. */
	}
	try {
		assert.equal(
			await evaluate(cdp, "location.href"),
			"hipi-work://app/index.html",
			"Failure capture requires the owned app page",
		);
		await capture(cdp, directory, "failure");
		result.screenshot = "saved";
	} catch {
		/* Preserve the original error even when the renderer is gone. */
	}
	return result;
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
	assert.equal(new Set(keys).size, 2, "Persisted history message identities must be unique");
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
	await waitForOverlayClosed(cdp, "button", "View activity");
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
		"Renderer must use preload bridge without Node globals",
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
			"Reopened conversation must retain user text",
		);
		await click(cdp, 'button[aria-label="Conversation details"]');
		const scope = await receiptScope(cdp);
		await inspectModal(cdp, ".workbench-detail-dialog");
		await click(cdp, ".workbench-detail-dialog button", "Close");
		await waitForOverlayClosed(cdp, 'button[aria-label="Conversation details"]');
		const activities = await inspectActivities(cdp, directory, true);
		const controls = await inspectControls(cdp);
		const theme = await inspectTheme(cdp, directory, true);
		await assertNoAlerts(cdp);
		const fonts = await renderedFonts(cdp, fixture);
		await capture(cdp, directory, "reopened");
		const toolPacks = await exerciseToolPacks(
			cdp,
			{ click, evaluate, until, pressKey, assertNoAlerts, capture },
			directory,
			{ reopened: true, expectedScope: scope },
		);
		return {
			reopened: true,
			fonts,
			activities,
			controls,
			theme,
			toolPacks,
			noUnexpectedAlerts: true,
			messageKeys: await historyEvidence(cdp),
		};
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
	await waitForOverlayClosed(cdp, '.conversation-nav button[aria-label="New workspace"]');
	await click(cdp, '.workspace-branch button[aria-label="New conversation"]');
	await fill(cdp, '[role="dialog"] input', fixture.conversation);
	await click(cdp, '[role="dialog"] [role="combobox"]');
	await until(
		() => evaluate(cdp, `document.querySelector('[role="option"]')?.textContent.includes('faux')`),
		"deterministic model catalog",
	);
	await click(cdp, '[role="option"]');
	await waitForSelectClosed(cdp, '[role="dialog"] [role="combobox"]');
	await click(cdp, '[role="dialog"] button[type="submit"]');
	await until(() => evaluate(cdp, "!!document.querySelector('.composer textarea')"), "conversation composer");
	await waitForOverlayClosed(cdp, '.workspace-branch button[aria-label="New conversation"]');
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
		"Completed conversation must display deterministic answer",
	);
	assert.ok(
		await evaluate(
			cdp,
			`document.querySelector('.conversation-panel')?.textContent.includes(${JSON.stringify(fixture.text)})`,
		),
		"Completed conversation must display user text",
	);
	const detailsGeometry = await inspectModal(cdp, ".workbench-detail-dialog");
	const scope = await receiptScope(cdp);
	await click(cdp, '[role="dialog"] button', "Close");
	await waitForOverlayClosed(cdp, 'button[aria-label="Conversation details"]');
	const activities = await inspectActivities(cdp, directory, false);
	const controls = await inspectControls(cdp);
	const theme = await inspectTheme(cdp, directory, false);
	await assertNoAlerts(cdp);
	const fonts = await renderedFonts(cdp, fixture);
	await capture(cdp, directory, "completed");
	const toolPacks = await exerciseToolPacks(
		cdp,
		{ click, evaluate, until, pressKey, assertNoAlerts, capture },
		directory,
		{ expectedScope: scope },
	);
	return {
		...observed,
		fonts,
		detailsGeometry,
		activities,
		controls,
		theme,
		toolPacks,
		noUnexpectedAlerts: true,
		messageKeys: await historyEvidence(cdp),
	};
}

export async function receiptScope(cdp) {
	const scope = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
		const root=document.querySelector('.workbench-detail-dialog');
		const workspaceId=root?.querySelector('[data-testid="workspace-id"]')?.textContent.trim();
		const conversationId=root?.querySelector('[data-testid="conversation-id"]')?.textContent.trim();
		return workspaceId && conversationId ? {workspaceId,conversationId} : null;
	})()`,
			),
		"receipt scope identifiers",
	);
	for (const value of Object.values(scope))
		assert.match(value, /^[A-Za-z0-9_-]{1,128}$/, "Receipt scope must contain valid identifiers");
	return scope;
}
