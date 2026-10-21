import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exerciseConversationPin } from "./gui-conversation-pin.mjs";
import { exerciseConversationSearch } from "./gui-conversation-search.mjs";
import { renderedFonts } from "./gui-fonts.mjs";
import { exerciseProjectDisclosure } from "./gui-project-disclosure.mjs";
import { createSettingsHarness } from "./gui-settings-route.mjs";
import { exerciseSidebarHover } from "./gui-sidebar-hover.mjs";
import { exerciseToolPacks } from "./gui-tool-packs.mjs";
import { exerciseWorkExperience, nativeEditorKey } from "./gui-work-experience.mjs";

export const fixture = {
	workspace: "Chats",
	conversation: "GUI 会话",
	text: "真实桌面 中文流式验证",
	prompt: "GUI 会话\n真实桌面 中文流式验证",
	answer: "Hipi Work deterministic test answer. No model API or external tool was called.",
	streamTail: "This second paragraph keeps the response open while the first paragraph is already settled.",
};
const diagnosticLabels = [
	"Close",
	"Close activity",
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
	"工作台设置",
	"Appearance and language",
	"Save",
	"Cancel",
	"New project",
	"New chat",
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
	if (selector === ".sidebar-settings-trigger") return "Workbench settings";
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
export function assertInitialChatUnsubmitted(state, goal) {
	assert.equal(state.home, true, "Keyboard input left the initial chat composer");
	assert.equal(state.goal, goal, "Initial chat draft changed unexpectedly");
	assert.equal(state.sendType, "submit", "Home must expose the actual Send action");
	assert.equal(state.sendDisabled, false, "Safety must be tested with Send enabled");
	assert.equal(state.dialogs, 0, "Initial chat must not require a creation dialog");
	assert.equal(state.projects, 0, "Editing introduced a project branch before Send");
	assert.equal(state.conversations, 0, "Editing persisted a conversation before Send");
	assert.equal(state.messages, 0, "Editing submitted a turn before Send");
}
export function observeStreamingActions(document, observation) {
	if (document.querySelector(".conversation-model-controls")?.dataset.executionState !== "running") return;
	const actions = [...document.querySelectorAll(".conversation-panel .composer-submit")];
	const valid =
		actions.length === 1 &&
		actions[0].dataset.action === "stop" &&
		actions[0].type === "button" &&
		actions[0].getAttribute("aria-label") === "Cancel execution";
	if (valid) observation.soleStopObserved = true;
	else observation.invalidRunningActions++;
}
/** Keep DOM references in the renderer only. Presentation IDs, not text matching, identify the stream. */
export function observeMountedStream(document, observation, settledParagraph) {
	if (observation.streamNodes) return;
	const rows = [...document.querySelectorAll('[data-transcript-kind="assistant-stream"][data-message-key^="stream:"]')];
	if (rows.length !== 1) return;
	const row = rows[0];
	let identity;
	try {
		identity = JSON.parse(row.dataset.messageKey.slice("stream:".length));
	} catch {
		return;
	}
	if (
		!Array.isArray(identity) ||
		identity.length !== 3 ||
		identity.some((value) => typeof value !== "string" || !value)
	)
		return;
	const article = row.querySelector("article.message-assistant");
	const body = article?.querySelector(".markdown-body");
	const paragraph = body?.querySelector(":scope > p");
	if (
		article?.getAttribute("aria-busy") !== "true" ||
		row.dataset.messageId !== undefined ||
		!paragraph ||
		paragraph.textContent !== settledParagraph ||
		body.children.length < 2
	)
		return;
	observation.streamNodes = { key: row.dataset.messageKey, identity, row, article, body, paragraph, settledParagraph };
}
export function committedStreamEvidence(document, observation) {
	const retained = observation.streamNodes;
	if (!retained) return null;
	const rows = [...document.querySelectorAll("[data-message-key]")].filter(
		(row) => row.dataset.messageKey === retained.key,
	);
	if (rows.length !== 1) return null;
	const row = rows[0];
	const article = row.querySelector("article.message-assistant");
	const body = article?.querySelector(".markdown-body");
	const paragraph = body?.querySelector(":scope > p");
	const copies = [...(article?.querySelectorAll(".message-actions .message-copy") ?? [])];
	return {
		committed: row.dataset.transcriptKind === "assistant-message" && !!row.dataset.messageId,
		messageId: row.dataset.messageId,
		identity: retained.identity,
		sameRow: retained.row === row && retained.row.isConnected,
		sameArticle: retained.article === article && retained.article.isConnected,
		sameBody: retained.body === body && retained.body.isConnected,
		sameSettledParagraph: retained.paragraph === paragraph && retained.paragraph.isConnected,
		settledTextRetained: paragraph?.textContent === retained.settledParagraph,
		noStreamRows: document.querySelectorAll('[data-transcript-kind="assistant-stream"]').length === 0,
		copyEnabled: copies.length === 1 && copies[0].disabled === false,
	};
}
export function assertCommittedStreamIdentity(evidence, scope) {
	assert.ok(evidence?.committed, "Stream did not become an authoritative completed message");
	assert.ok(typeof evidence.messageId === "string" && evidence.messageId.length > 0);
	assert.deepEqual(evidence.identity.slice(0, 2), [scope.workspaceId, scope.conversationId]);
	for (const field of [
		"sameRow",
		"sameArticle",
		"sameBody",
		"sameSettledParagraph",
		"settledTextRetained",
		"noStreamRows",
		"copyEnabled",
	])
		assert.equal(evidence[field], true, `Stream completion failed mounted identity condition: ${field}`);
}
export async function inspectInitialChat(cdp) {
	const selector = ".prepared-task-input";
	await fill(cdp, selector, fixture.prompt);
	const read = async () => {
		await evaluate(cdp, "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
		return evaluate(
			cdp,
			`(() => {
		const home = document.querySelector('.new-chat-composer');
		const send = home?.querySelector('.composer-submit[data-action="send"]');
		return { home: !!home, goal: home?.querySelector('.prepared-task-input')?.value,
			sendType: send?.type, sendDisabled: send?.disabled,
			dialogs: document.querySelectorAll('[role="dialog"]').length,
			projects: document.querySelectorAll('.workspace-branch[data-workspace-id]').length,
			conversations: document.querySelectorAll('.conversation-link').length,
			messages: document.querySelectorAll('[data-message-id]').length };
	})()`,
		);
	};
	assertInitialChatUnsubmitted(await read(), fixture.prompt);
	await nativeEditorKey(cdp, "Enter", { modifiers: 8 });
	assertInitialChatUnsubmitted(await read(), `${fixture.prompt}\n`);
	await cdp.request("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
	await nativeEditorKey(cdp, "Enter", { composing: true });
	await cdp.request("Input.insertText", { text: "中文" });
	assertInitialChatUnsubmitted(await read(), `${fixture.prompt}\n中文`);
	await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
	await nativeEditorKey(cdp, "Backspace");
	await cdp.request("Input.insertText", { text: fixture.prompt });
	await click(cdp, ".new-conversation-trigger");
	assertInitialChatUnsubmitted(await read(), fixture.prompt);
	assert.equal(await evaluate(cdp, "document.activeElement === document.querySelector('.prepared-task-input')"), true);
	await click(cdp, ".new-chat-model-trigger");
	await click(cdp, ".new-chat-manage-models");
	await until(
		() =>
			evaluate(cdp, "document.querySelector('.settings-page-nav [aria-current=page]')?.dataset.category === 'models'"),
		"home model management modal",
	);
	await click(cdp, '.settings-modal [data-slot="dialog-close"]');
	await until(
		() =>
			evaluate(
				cdp,
				"!document.querySelector('.settings-modal') && document.activeElement === document.querySelector('.new-chat-model-trigger')",
			),
		"home model modal returns exact opener",
	);
	assertInitialChatUnsubmitted(await read(), fixture.prompt);
	return {
		shiftEnterOnlyNewline: true,
		cdpCompositionDoesNotSend: true,
		navigationDoesNotCreate: true,
		settingsRetainsDraft: true,
		singleSendRequired: true,
	};
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
export function settingsHarness(cdp) {
	return createSettingsHarness(cdp, { evaluate, click, until, nativeEditorKey, capture, pressKey });
}
export async function openAppearance(cdp, trigger = ".sidebar-settings-trigger") {
	await settingsHarness(cdp).open(trigger, "appearance");
}
export async function setAppearanceChoice(cdp, field, value) {
	await settingsHarness(cdp).setChoice(field, value);
}
export async function setWorkbenchPreferences(cdp, locale, mode) {
	await settingsHarness(cdp).preferences(locale, mode);
}
export async function selectEnglish(cdp) {
	const route = settingsHarness(cdp);
	await route.open(".sidebar-settings-trigger", "general");
	await route.setChoice("language", "en");
	await route.close(".sidebar-settings-trigger");
}
export async function assertNoAlerts(cdp) {
	const alerts = await evaluate(
		cdp,
		`Array.from(document.querySelectorAll('[role="alert"]')).slice(0, 10).map(e => e.textContent.trim().slice(0, 200))`,
	);
	assert.equal(alerts.length, 0, `Unexpected application alert: ${JSON.stringify(alerts)}`);
}
export function resolvedTheme(mode, systemDark) {
	assert.ok(["light", "dark", "system"].includes(mode), "Unknown appearance mode");
	return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}
export async function appearanceChoice(cdp, field = "theme") {
	return settingsHarness(cdp).choice(field);
}
async function inspectTheme(cdp, directory, reopened) {
	const route = settingsHarness(cdp);
	const originalResolved = await evaluate(cdp, "document.documentElement.dataset.theme");
	await route.open(".sidebar-settings-trigger", "appearance");
	const original = (await route.choice()).mode;
	const geometry = await route.geometry();
	await capture(cdp, directory, reopened ? "settings-appearance-reopened" : "settings-appearance");
	await route.setChoice("theme", "dark");
	await route.close(".sidebar-settings-trigger");
	await capture(cdp, directory, reopened ? "dark-reopened" : "dark-completed");
	await route.open(".sidebar-settings-trigger", "appearance");
	assert.equal((await route.choice()).mode, "dark", "Immediate theme choice must survive modal return");
	await route.setChoice("theme", original);
	await route.close(".sidebar-settings-trigger");
	const expected = resolvedTheme(original, await evaluate(cdp, "matchMedia('(prefers-color-scheme: dark)').matches"));
	await until(
		() => evaluate(cdp, `document.documentElement.dataset.theme === ${JSON.stringify(expected)}`),
		"original resolved theme restored",
	);
	return {
		originalMode: original,
		originalResolved,
		restoredResolved: expected,
		darkCaptured: true,
		immediateThemePersisted: true,
		sidebarCloseFocus: true,
		secondCloseFocus: true,
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
		const closes = [...dialog.querySelectorAll(':scope > button[data-slot="dialog-close"]')];
		const body = dialog.querySelector(${JSON.stringify('[data-slot="dialog-body"]')});
		const title = dialog.querySelector(${JSON.stringify('[data-slot="dialog-title"]')});
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
export async function inspectModal(cdp, selector, placement) {
	assert.ok(["center", "right"].includes(placement), "Explicit modal placement required");
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
		const body=document.querySelector(${JSON.stringify(selector)})?.querySelector(${JSON.stringify('[data-slot="dialog-body"]')});
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

	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.conversation-options-dialog[data-section="files"]')?.textContent.includes('Authorize model context')`,
			),
		"permission details contents",
	);
	assert.ok(
		await evaluate(
			cdp,
			`[...document.querySelectorAll('.conversation-options-dialog[data-section="files"] button')].some(e => e.textContent.trim() === 'Refresh permissions')`,
		),
		"Permission dialog must contain Refresh permissions",
	);
	await assertNoAlerts(cdp);
	const permissionGeometry = await inspectModal(cdp, ".conversation-options-dialog[data-section=files]", "center");
	await click(cdp, '.conversation-options-dialog[data-section="files"] button[data-slot="dialog-close"]');
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
	await nativeEditorKey(cdp, "Enter");
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
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('[role="menu"] .preview-title')?.textContent === ${JSON.stringify(fixture.conversation)} && !!document.querySelector('[role="menu"] time.preview-created') && !document.querySelector('.conversation-preview-card')`,
			),
		"sidebar action menu retains exact title/date without a competing preview",
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
export async function historyEvidence(cdp) {
	const rows = await until(async () => {
		const value = await evaluate(
			cdp,
			`Array.from(document.querySelectorAll('[data-message-id]')).map(row => ({key:'message:'+row.dataset.messageId,user:!!row.querySelector('article.message-user'),assistant:!!row.querySelector('article.message-assistant'),text:row.textContent}))`,
		);
		return value.length === 2 &&
			value.some((row) => row.user && row.text.includes(fixture.prompt)) &&
			value.some((row) => row.assistant && row.text.includes(fixture.answer))
			? value
			: undefined;
	}, "two persisted history rows");
	const keys = rows.map((row) => row.key);
	assert.equal(new Set(keys).size, 2, "Persisted history message identities must be unique");
	return keys;
}
export async function selectReopenedConversation(cdp) {
	if (
		await evaluate(
			cdp,
			`document.querySelector('.toolbar-conversation')?.textContent === ${JSON.stringify(fixture.conversation)}`,
		)
	)
		return;
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelectorAll('.recent-conversations').length === 1 && [...document.querySelectorAll('.sidebar .conversation-link')].filter(e => e.textContent.trim() === ${JSON.stringify(fixture.conversation)}).length === 1`,
			),
		"unique persisted conversation in Recent or Pinned",
	);
	await click(cdp, ".sidebar .conversation-link", fixture.conversation);
}
export async function assertDefaultChatScope(cdp, scope, reopened) {
	const state = await evaluate(
		cdp,
		`(() => {
		const projects = [...document.querySelectorAll('.workspace-branch[data-workspace-id]')];
		const recent = [...document.querySelectorAll('.recent-conversations')];
		const rows = [...document.querySelectorAll('.sidebar .conversation-link')];
		return { projects: projects.length, recent: recent.length,
			recentWorkspaceId: recent[0]?.dataset.workspaceId ?? null,
			rows: rows.map(row => ({ workspaceId: row.dataset.workspaceId, conversationId: row.dataset.conversationId,
				selected: row.getAttribute('aria-current') === 'page', location: row.dataset.sidebarLocation })),
			title: document.querySelector('.toolbar-conversation')?.textContent };
	})()`,
	);
	assert.equal(state.projects, reopened ? 1 : 0, "Only the deliberately created named project may appear");
	assert.equal(state.recent, 1);
	assert.equal(state.recentWorkspaceId, null, "Global Recent cannot claim one workspace identity");
	assert.deepEqual(
		state.rows,
		[{ ...scope, selected: true, location: reopened ? "pinned" : "recent" }],
		"One Send and restart must retain exactly one selected row with the actual receipt scope",
	);
	assert.equal(state.title, fixture.conversation);
}
export async function activityEvidence(cdp) {
	return until(async () => {
		const state = await evaluate(
			cdp,
			`(() => {
		const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(e => e.querySelector('h2')?.textContent === 'Tool activity');
		if (dialogs.length !== 1) return null;
		const dialog = dialogs[0];
		const paragraphs = [...dialog.querySelectorAll('p')].map(e => e.textContent);
		return {
			failed: !!dialog.querySelector('[role="alert"]'),
			loading: [...dialog.querySelectorAll('output')].some(e => e.textContent === 'Reading records…'),
			continuousWindow: dialog.querySelectorAll('[data-activity-history-window]').length === 1,
			empty: paragraphs.includes('No recorded tool activity.')
		}; })()`,
		);
		if (!state) return;
		assert.equal(state.failed, false, "Tool activity read failed");
		if (state.loading || !state.continuousWindow) return;
		assert.equal(
			state.empty,
			true,
			"Deterministic no-tool fixture must have a confirmed terminal empty activity window",
		);
		return { continuousWindow: true, empty: true };
	}, "successful continuous tool activity window");
}
async function inspectActivities(cdp, directory, reopened) {
	await click(cdp, 'button[aria-label="Conversation details"]');
	const selector = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
			const parent = document.querySelector('.workbench-detail-dialog');
			const triggers = [...(parent?.querySelectorAll('.activity-trigger') ?? [])];
			if (triggers.length !== 1 || !triggers[0].getAttribute('aria-controls')) return null;
			window.__hipiGuiActivityParent = parent;
			window.__hipiGuiActivityTrigger = triggers[0];
			return '#' + CSS.escape(triggers[0].getAttribute('aria-controls'));
		})()`,
			),
		"details owns one actual activity trigger",
	);
	await click(cdp, ".workbench-detail-dialog .activity-trigger");
	await activityEvidence(cdp);
	await click(cdp, `${selector} [data-activity-history-window]`);
	for (const key of ["End", "Home"]) {
		for (const type of ["keyDown", "keyUp"])
			await cdp.request("Input.dispatchKeyEvent", {
				type,
				key,
				code: key,
				windowsVirtualKeyCode: key === "End" ? 35 : 36,
			});
		assert.equal(
			await evaluate(
				cdp,
				`document.activeElement === document.querySelector(${JSON.stringify(`${selector} [data-activity-history-window]`)})`,
			),
			true,
			"Continuous activity navigation retains the actual scroll-region focus",
		);
		await activityEvidence(cdp);
	}
	const evidence = await activityEvidence(cdp);
	await capture(cdp, directory, reopened ? "activities-reopened" : "activities");
	await click(cdp, `${selector} button`, "Close activity");
	await until(
		() =>
			evaluate(
				cdp,
				`!document.querySelector(${JSON.stringify(selector)}) &&
			window.__hipiGuiActivityParent === document.querySelector('.workbench-detail-dialog') &&
			window.__hipiGuiActivityTrigger?.isConnected && document.activeElement === window.__hipiGuiActivityTrigger`,
			),
		"activity child closes to its exact retained details trigger",
	);
	await click(cdp, ".workbench-detail-dialog button", "Close");
	await waitForOverlayClosed(cdp, 'button[aria-label="Conversation details"]');
	await evaluate(cdp, "delete window.__hipiGuiActivityParent; delete window.__hipiGuiActivityTrigger");
	return { ...evidence, nestedFocusRestored: true };
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
	await until(() => evaluate(cdp, `!!document.querySelector('.new-conversation-trigger')`), "New chat action");
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
		await assertDefaultChatScope(cdp, scope, true);
		await inspectModal(cdp, ".workbench-detail-dialog", "right");
		await click(cdp, ".workbench-detail-dialog button", "Close");
		await waitForOverlayClosed(cdp, 'button[aria-label="Conversation details"]');
		const conversationPin = await exerciseConversationPin(cdp, directory, scope, fixture.conversation, true);
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
				settingsHarness,
				inspectModal,
				hover,
			},
			directory,
			{ reopened: true, expectedScope: scope },
		);
		const projectDisclosure = await exerciseProjectDisclosure(
			cdp,
			{ evaluate, click, until, capture, pressKey, waitForOverlayClosed, assertNoAlerts, inspectModal },
			directory,
			fixture,
			true,
			scope,
		);
		return {
			reopened: true,
			conversationPin,
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
	await until(
		() =>
			evaluate(
				cdp,
				"!!document.querySelector('.prepared-task-input') && document.querySelector('.new-chat-model-trigger')?.textContent.includes('faux')",
			),
		"configured model in initial chat",
	);
	const initialChat = await inspectInitialChat(cdp);
	await capture(cdp, directory, "initial-chat-ready");
	await evaluate(
		cdp,
		`(() => { window.__hipiGuiSmoke = { samples: [], running: false, soleStopObserved: false, invalidRunningActions: 0 };
		const sample=()=>{ const e=document.querySelector('article.message-assistant[aria-busy="true"]');
		if(e){window.__hipiGuiSmoke.running=true; const t=e.textContent; const a=window.__hipiGuiSmoke.samples;
		if(a.at(-1)!==t && a.length<128)a.push(t);}
		(${observeStreamingActions.toString()})(document,window.__hipiGuiSmoke);
		(${observeMountedStream.toString()})(document,window.__hipiGuiSmoke,${JSON.stringify(fixture.answer)});};
		window.__hipiGuiSmoke.observer=new MutationObserver(sample); window.__hipiGuiSmoke.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-busy','data-action','data-execution-state']}); })()`,
	);
	await click(cdp, '.new-chat-composer .composer-submit[data-action="send"]');
	await until(() => evaluate(cdp, "window.__hipiGuiSmoke.running"), "streaming DOM");
	await until(
		() => evaluate(cdp, "!!window.__hipiGuiSmoke.streamNodes"),
		"authoritative live stream with a settled first paragraph",
	);
	await capture(cdp, directory, "streaming");
	await click(cdp, 'button[aria-label="Conversation details"]');
	await until(
		() =>
			evaluate(cdp, `document.querySelector('[data-testid="execution-status"]')?.textContent === 'Result confirmed'`),
		"confirmed execution",
	);
	const observed = await evaluate(
		cdp,
		"(() => {const s=window.__hipiGuiSmoke;s.observer.disconnect();return {running:s.running,sampleCount:s.samples.length,soleStopObserved:s.soleStopObserved,invalidRunningActions:s.invalidRunningActions};})()",
	);
	assert.ok(observed.running && observed.sampleCount >= 2, "No incremental streaming evidence");
	assert.equal(
		observed.invalidRunningActions,
		0,
		"Running state exposed missing, duplicate or incorrect composer actions",
	);
	assert.equal(
		observed.soleStopObserved,
		true,
		"Streaming must expose the single actual Stop action, not another Send",
	);
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
	const detailsGeometry = await inspectModal(cdp, ".workbench-detail-dialog", "right");
	const scope = await receiptScope(cdp);
	const streamIdentity = await until(async () => {
		const evidence = await evaluate(cdp, `(${committedStreamEvidence.toString()})(document,window.__hipiGuiSmoke)`);
		return evidence?.committed && evidence.copyEnabled && evidence.noStreamRows ? evidence : null;
	}, "stream completion exposes canonical identity and enabled Copy");
	assertCommittedStreamIdentity(streamIdentity, scope);
	assert.equal(
		await evaluate(
			cdp,
			`window.__hipiGuiSmoke.streamNodes.body.textContent.includes(${JSON.stringify(fixture.streamTail)})`,
		),
		true,
		"Completed retained stream must contain the entire known tail",
	);
	await evaluate(cdp, "delete window.__hipiGuiSmoke.streamNodes");
	await assertDefaultChatScope(cdp, scope, false);
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
			settingsHarness,
			inspectModal,
			hover,
		},
		directory,
		{ expectedScope: scope },
	);
	const projectDisclosure = await exerciseProjectDisclosure(
		cdp,
		{ evaluate, click, until, capture, pressKey, waitForOverlayClosed, assertNoAlerts, inspectModal },
		directory,
		fixture,
		false,
		scope,
	);
	const conversationSearch = await exerciseConversationSearch(cdp, directory, scope);
	const sidebarHover = await exerciseSidebarHover(cdp, directory, scope, fixture.conversation);
	const conversationPin = await exerciseConversationPin(cdp, directory, scope, fixture.conversation, false);
	return {
		...observed,
		streamIdentity,
		initialChat,
		projectDisclosure,
		conversationPin,
		sidebarHover,
		conversationSearch,
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
