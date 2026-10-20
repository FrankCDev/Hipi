import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderedFonts } from "./gui-fonts.mjs";
import { exerciseProjectDisclosure } from "./gui-project-disclosure.mjs";
import { exerciseToolPacks } from "./gui-tool-packs.mjs";
import { exerciseWorkExperience } from "./gui-work-experience.mjs";

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
	"Conversation capabilities",
	"Close settings",
	"Appearance & language",
	"Models & credentials",
	"Runtime & data",
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
	if (selector === ".capabilities-trigger") return "Conversation capabilities";
	if ([".sidebar-settings-trigger", ".workbench-settings-trigger"].includes(selector)) return "Workbench settings";
	return "unrecognized target";
}
export async function evaluate(cdp, expression) {
	const result = await cdp.request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error("Renderer evaluation failed");
	return result.result.value;
}
export async function rememberCreateTrigger(cdp) {
	assert.equal(
		await evaluate(
			cdp,
			`(() => { window.__hipiGuiCreateTrigger = document.querySelector('.conversation-nav .workspace-create button[aria-label="New workspace"]'); return !!window.__hipiGuiCreateTrigger; })()`,
		),
		true,
		"Workspace creation requires its original primary trigger",
	);
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
export async function hover(cdp, selector) {
	const point = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
		const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getClientRects().length);
		if(nodes.length !== 1) return null;
		const e=nodes[0], r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
		return e.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
	})()`,
			),
		"unobstructed hover target",
	);
	await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
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
export async function openAppearance(cdp, trigger = ".workbench-settings-trigger") {
	await click(cdp, trigger);
	await until(
		() => evaluate(cdp, `!!document.querySelector('.unified-settings-dialog[role="dialog"]')`),
		"settings modal",
	);
	const english = await evaluate(cdp, `document.documentElement.lang === 'en'`);
	await click(cdp, ".settings-page-nav button", english ? "Appearance & language" : "外观与语言");
}
export async function setAppearanceChoice(cdp, field, value) {
	const choice = await appearanceChoice(cdp, field);
	await click(cdp, choice.selector);
	await click(cdp, '[role="option"]', value);
	await waitForSelectClosed(cdp, choice.selector);
}
export async function saveAppearance(cdp) {
	const english = await evaluate(cdp, `document.documentElement.lang === 'en'`);
	await click(cdp, ".settings-savebar button", english ? "Save" : "保存");
	await until(
		() => evaluate(cdp, `!!document.querySelector('.settings-feedback')?.textContent.trim()`),
		"appearance saved feedback",
	);
}
export async function setWorkbenchPreferences(cdp, locale, mode) {
	await openAppearance(cdp);
	await setAppearanceChoice(cdp, "language", locale === "en" ? "English" : "简体中文");
	const labels =
		locale === "en"
			? { light: "Light", dark: "Dark", system: "Follow system" }
			: { light: "浅色", dark: "深色", system: "跟随系统" };
	await setAppearanceChoice(cdp, "theme", labels[mode]);
	await saveAppearance(cdp);
	await dismissTo(cdp, ".workbench-settings-trigger");
	await until(() => evaluate(cdp, `document.documentElement.lang === ${JSON.stringify(locale)}`), "saved locale");
}
export async function selectEnglish(cdp) {
	await openAppearance(cdp);
	await setAppearanceChoice(cdp, "language", "English");
	await saveAppearance(cdp);
	await dismissTo(cdp, ".workbench-settings-trigger");
	await until(() => evaluate(cdp, `document.documentElement.lang === 'en'`), "English selected");
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
export async function appearanceChoice(cdp, field = "theme") {
	assert.ok(["theme", "language"].includes(field));
	const labels = field === "theme" ? ["Theme", "主题"] : ["Language", "语言"];
	return until(
		() =>
			evaluate(
				cdp,
				`(() => {
		const dialog = document.querySelector('.unified-settings-dialog[role="dialog"]');
		if (!dialog) return null;
		const labels = [...dialog.querySelectorAll('label')].filter(e => ${JSON.stringify(labels)}.includes(e.textContent.trim()));
		if (labels.length !== 1) return null;
		const control = document.getElementById(labels[0].htmlFor);
		if (!control || control.getAttribute('role') !== 'combobox') return null;
		return { mode: control.textContent.trim(), selector: '#' + CSS.escape(control.id) };
	})()`,
			),
		"appearance theme choice",
	);
}
async function inspectTheme(cdp, directory, reopened) {
	const settings = ".workbench-settings-trigger";
	const originalResolved = await evaluate(cdp, "document.documentElement.dataset.theme");
	assert.ok(["light", "dark"].includes(originalResolved));
	await openAppearance(cdp, ".sidebar-settings-trigger");
	const original = await appearanceChoice(cdp);
	resolvedTheme(original.mode, false);
	await modalBounds(cdp, ".unified-settings-dialog", 30000, "center");
	await capture(cdp, directory, reopened ? "settings-appearance-reopened" : "settings-appearance");
	// A select is the nested overlay now. Escape must restore its actual combobox.
	await click(cdp, original.selector);
	await pressKey(cdp, "Escape");
	await waitForSelectClosed(cdp, original.selector);
	await setAppearanceChoice(cdp, "theme", originalResolved === "light" ? "Dark" : "Light");
	await click(cdp, ".settings-savebar button", "Cancel");
	assert.equal((await appearanceChoice(cdp)).mode, original.mode, "Cancel must restore the saved preference");
	await until(
		() => evaluate(cdp, `document.documentElement.dataset.theme === ${JSON.stringify(originalResolved)}`),
		"cancelled preview restored",
	);
	await setAppearanceChoice(cdp, "theme", "Dark");
	await saveAppearance(cdp);
	await dismissTo(cdp, ".sidebar-settings-trigger");
	await until(() => evaluate(cdp, `document.documentElement.dataset.theme === 'dark'`), "saved dark theme");
	await assertNoAlerts(cdp);
	await capture(cdp, directory, reopened ? "dark-reopened" : "dark-completed");
	await openAppearance(cdp, settings);
	assert.equal((await appearanceChoice(cdp)).mode, "Dark", "Saved mode must survive closing and reopening settings");
	await setAppearanceChoice(cdp, "theme", original.mode);
	await saveAppearance(cdp);
	const geometry = await inspectModal(cdp, ".unified-settings-dialog", "center");
	await click(cdp, '.unified-settings-dialog button[data-slot="dialog-close"]');
	await waitForOverlayClosed(cdp, settings);
	await openAppearance(cdp);
	assert.equal((await appearanceChoice(cdp)).mode, original.mode, "Original theme preference was not restored");
	await setAppearanceChoice(cdp, "theme", originalResolved === "light" ? "Dark" : "Light");
	await dismissTo(cdp, settings);
	await openAppearance(cdp);
	assert.equal((await appearanceChoice(cdp)).mode, original.mode, "Closing settings must cancel unsaved preview");
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
		selectEscapeFocus: true,
		sidebarEscapeFocus: true,
		toolbarMouseCloseFocus: true,
		cancelledPreviewRestored: true,
		geometry,
	};
}
export async function modalBounds(cdp, selector, milliseconds = 30000, placement = "right") {
	assert.ok(["center", "right"].includes(placement), "Unknown modal placement");
	return until(
		async () => {
			const state = await evaluate(
				cdp,
				`(() => {
		if (location.href !== 'hipi-work://app/index.html') throw Error('Unexpected page');
		const dialog = document.querySelector(${JSON.stringify(selector)});
		if (!dialog) return null;
		const closes = [...dialog.querySelectorAll('button[data-slot="dialog-close"]')];
		const body = dialog.querySelector(${JSON.stringify(selector === ".unified-settings-dialog" ? ".settings-page-content" : '[data-slot="dialog-body"]')});
		const title = dialog.querySelector(${JSON.stringify(selector === ".unified-settings-dialog" ? ".settings-page-header h2" : '[data-slot="dialog-title"]')});
		if (closes.length !== 1 || !body || !title) return null;
		const close = closes[0];
		const rect = e => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
		const inside = r => r.width>0 && r.height>0 && r.x>=0 && r.y>=0 && r.x+r.width<=innerWidth+1 && r.y+r.height<=innerHeight+1;
		const d=rect(dialog), c=rect(close), b=rect(body), t=rect(title);
		return { ready: dialog.dataset.placement === ${JSON.stringify(placement)} && dialog.dataset.scrollBody === 'true' && inside(d) && inside(c) && inside(t) && inside(b) && !close.disabled && close.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)) && title.contains(document.elementFromPoint(t.x+t.width/2,t.y+t.height/2)),
			dialog:d,close:c,title:t,body:b,scrollTop:body.scrollTop,clientHeight:body.clientHeight,scrollHeight:body.scrollHeight };
	})()`,
			);
			return state?.ready ? state : null;
		},
		`modal viewport and reachable Close: ${selector}`,
		milliseconds,
	);
}
export async function inspectModal(cdp, selector, placement = "right") {
	const before = await modalBounds(cdp, selector, 30000, placement);
	const overflow = before.scrollHeight > before.clientHeight + 1;
	if (overflow) {
		const point = await modalWheelPoint(cdp, selector);
		await cdp.request("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: point.x,
			y: point.y,
			deltaX: 0,
			deltaY: before.scrollHeight,
		});
		await until(async () => {
			const after = await modalBounds(cdp, selector, 30000, placement);
			return after.scrollTop + after.clientHeight >= after.scrollHeight - 2 ? after : null;
		}, "modal body scrolled to bottom with Close still reachable");
	}
	await modalBounds(cdp, selector, 30000, placement);
	return {
		viewportContained: true,
		titleReachable: true,
		closeReachable: true,
		overflowingBody: overflow,
		scrolledToBottom: overflow,
	};
}
export async function modalWheelPoint(cdp, selector) {
	const point = await evaluate(
		cdp,
		`(() => {
		const body=document.querySelector(${JSON.stringify(selector)})?.querySelector(${JSON.stringify(selector === ".unified-settings-dialog" ? ".settings-page-content" : '[data-slot="dialog-body"]')});
		if(!body)return null;
		const r=body.getBoundingClientRect();
		for(const y of [r.y+r.height/2,r.y+4,r.y+r.height-4])for(const x of [r.x+r.width/2,r.x+4,r.x+r.width-4]){
			if(x<=r.x || x>=r.x+r.width || y<=r.y || y>=r.y+r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight)continue;
			let hit=document.elementFromPoint(x,y);
			if(!hit || !body.contains(hit))continue;
			let blocked=false;
			while(hit!==body){
				const style=getComputedStyle(hit);
				if(['TEXTAREA','SELECT','INPUT'].includes(hit.tagName) || (/(auto|scroll)/.test(style.overflowY) && hit.scrollHeight>hit.clientHeight+1)){blocked=true;break;}
				hit=hit.parentElement;
			}
			if(!blocked)return {x,y};
		}
		return null;
	})()`,
	);
	assert.ok(point, "Modal body has no unobstructed non-nested wheel target");
	return point;
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
	await click(cdp, ".capabilities-trigger");
	await click(cdp, '.capabilities-navigation button[data-section="files"]');
	await until(
		() =>
			evaluate(cdp, `document.querySelector('.capabilities-dialog')?.textContent.includes('Authorize model context')`),
		"permission details contents",
	);
	assert.ok(
		await evaluate(
			cdp,
			`[...document.querySelectorAll('.capabilities-dialog button')].some(e => e.textContent.trim() === 'Refresh permissions')`,
		),
		"Permission dialog must contain Refresh permissions",
	);
	await assertNoAlerts(cdp);
	const permissionGeometry = await inspectModal(cdp, ".capabilities-dialog");
	await click(cdp, '.capabilities-dialog button[data-slot="dialog-close"]');
	await waitForOverlayClosed(cdp, ".capabilities-trigger");
	await click(cdp, ".capabilities-trigger");
	await dismissTo(cdp, ".capabilities-trigger");
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
	await hover(cdp, ".conversation-link");
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
export async function settleFloatingAnimations(document, milliseconds = 3000, frame = requestAnimationFrame) {
	const selector =
		'[role="dialog"],[role="menu"],[data-slot="dialog-overlay"],[data-slot="popover-content"],.conversation-preview-card';
	const pending = () =>
		[...document.querySelectorAll(selector)]
			.flatMap((node) => node.getAnimations({ subtree: true }))
			.filter(
				(animation) =>
					animation.playState !== "finished" &&
					animation.playState !== "idle" &&
					Number.isFinite(animation.effect?.getComputedTiming().endTime),
			);
	let timer;
	let stopped = false;
	try {
		await Promise.race([
			(async () => {
				while (!stopped) {
					await Promise.all(pending().map((animation) => animation.finished.catch(() => {})));
					await new Promise((resolve) => frame(() => frame(resolve)));
					if (pending().length === 0) return;
				}
			})(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("Floating entrance animations did not settle")), milliseconds);
			}),
		]);
	} finally {
		stopped = true;
		clearTimeout(timer);
	}
}
export async function capture(cdp, directory, name) {
	assert.equal(
		await evaluate(
			cdp,
			`document.fonts.ready.then(() => (${settleFloatingAnimations.toString()})(document)).then(() => true, () => false)`,
		),
		true,
		"Screenshot floating entrance animations did not settle",
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
		const e = document.querySelector('.workspace-branch[data-selected="true"] .project-toggle');
		if (!e || e.disabled || !e.getClientRects().length) return null;
		const expanded = e.getAttribute('aria-expanded');
		return expanded === 'true' || expanded === 'false' ? { expanded } : null;
		})()`,
			),
		"reopened workspace toggle",
	);
	if (state.expanded === "false") await click(cdp, '.workspace-branch[data-selected="true"] .project-toggle');
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
export async function exercise(cdp, directory, reopened = false, fontObservations = []) {
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
	// Set and save the actual language preference through the settings form.
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
		const fonts = await renderedFonts(cdp, fixture, process.platform, fontObservations);
		await capture(cdp, directory, "reopened");
		const toolPacks = await exerciseToolPacks(
			cdp,
			{ click, evaluate, until, pressKey, assertNoAlerts, capture, inspectModal },
			directory,
			{ reopened: true, expectedScope: scope },
		);
		const workExperience = await exerciseWorkExperience(
			cdp,
			{
				evaluate,
				click,
				until,
				pressKey,
				capture,
				waitForOverlayClosed,
				appearanceChoice,
				assertNoAlerts,
				openAppearance,
				setWorkbenchPreferences,
				setAppearanceChoice,
				saveAppearance,
				inspectModal,
				hover,
			},
			directory,
			{ reopened: true },
		);
		const projectDisclosure = await exerciseProjectDisclosure(
			cdp,
			{ evaluate, click, until, capture, pressKey, waitForOverlayClosed, assertNoAlerts },
			directory,
			fixture,
			true,
		);
		return {
			reopened: true,
			projectDisclosure,
			fonts,
			activities,
			controls,
			theme,
			toolPacks,
			workExperience,
			noUnexpectedAlerts: true,
			messageKeys: await historyEvidence(cdp),
		};
	}
	await capture(cdp, directory, "initial");
	await rememberCreateTrigger(cdp);
	await click(cdp, '.conversation-nav button[aria-label="New workspace"]');
	await fill(cdp, '[role="dialog"] input', fixture.workspace);
	await click(cdp, '[role="dialog"] button[type="submit"]');
	await until(
		() =>
			evaluate(cdp, `document.querySelector('.project-name')?.textContent === ${JSON.stringify(fixture.workspace)}`),
		"workspace persisted",
	);
	// The same primary trigger becomes New conversation after selecting the created workspace.
	// The compact New workspace action is a different sibling, not a valid focus-return target.
	await waitForOverlayClosed(cdp, '.conversation-nav .workspace-create button[aria-label="New conversation"]');
	assert.equal(
		await evaluate(
			cdp,
			`(() => { const retained = window.__hipiGuiCreateTrigger === document.activeElement; delete window.__hipiGuiCreateTrigger; return retained; })()`,
		),
		true,
		"Creation must retain and focus the original primary action element",
	);
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
	const fonts = await renderedFonts(cdp, fixture, process.platform, fontObservations);
	await capture(cdp, directory, "completed");
	const toolPacks = await exerciseToolPacks(
		cdp,
		{ click, evaluate, until, pressKey, assertNoAlerts, capture, inspectModal },
		directory,
		{ expectedScope: scope },
	);
	const workExperience = await exerciseWorkExperience(
		cdp,
		{
			evaluate,
			click,
			until,
			pressKey,
			capture,
			waitForOverlayClosed,
			appearanceChoice,
			assertNoAlerts,
			openAppearance,
			setWorkbenchPreferences,
			setAppearanceChoice,
			saveAppearance,
			inspectModal,
			hover,
		},
		directory,
	);
	const projectDisclosure = await exerciseProjectDisclosure(
		cdp,
		{ evaluate, click, until, capture, pressKey, waitForOverlayClosed, assertNoAlerts },
		directory,
		fixture,
		false,
	);
	return {
		...observed,
		projectDisclosure,
		fonts,
		detailsGeometry,
		activities,
		controls,
		theme,
		toolPacks,
		workExperience,
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
