import assert from "node:assert/strict";
import { inspectNativeAppearance } from "./gui-native-appearance.mjs";

export const layoutCases = [1440, 1280, 1024, 640].flatMap((width) =>
	["en", "zh-CN"].flatMap((locale) => ["light", "dark"].map((theme) => ({ width, height: 900, locale, theme }))),
);

export function deterministicCredentialEvidence(document) {
	const rows = [...document.querySelectorAll(".settings-modal .provider-service-row")];
	if (rows.length !== 1 || rows[0].dataset.setting !== "provider:faux" || !rows[0].disabled) return null;
	return {
		status: "not_applicable_to_deterministic_catalog",
		nativeCredentialStatus:
			"not_run; isolated production-mode journey is not supported by the deterministic smoke launch boundary",
	};
}

/** Bind readable consent to its actual trigger, selected receipt scope and retained conversation owner. */
export function directContextConsentEvidence(document, expectedScope, contextId, retainedOwner) {
	const selected = [...document.querySelectorAll('.conversation-link[aria-current="page"]')];
	const owners = [...document.querySelectorAll(".conversation-panel")];
	const dialogs = [...document.querySelectorAll(".context-consent-dialog")];
	if (
		!expectedScope?.workspaceId ||
		!expectedScope?.conversationId ||
		!contextId ||
		selected.length !== 1 ||
		selected[0].dataset.workspaceId !== expectedScope.workspaceId ||
		selected[0].dataset.conversationId !== expectedScope.conversationId ||
		owners.length !== 1 ||
		owners[0] !== retainedOwner ||
		!retainedOwner?.isConnected ||
		dialogs.length !== 1 ||
		dialogs[0].id !== contextId
	)
		return false;
	const dialog = dialogs[0];
	const paragraphs = [...dialog.querySelectorAll("p")].map((node) => node.textContent.trim());
	const authorize = [...dialog.querySelectorAll("button")].filter(
		(node) => node.textContent.trim() === "Authorize model context",
	);
	return (
		paragraphs.includes("Only this chat and the selected model") &&
		paragraphs.includes("Provider / model: faux / faux-1") &&
		paragraphs.includes("No authorized folders available. Authorize a folder in Project files first.") &&
		authorize.length === 1 &&
		authorize[0].disabled === true
	);
}

/** Observe the retained row's real tab stops, including temporarily disabled query-backed Pin. */
export function sidebarKeyboardEvidence(document, retained, index) {
	const selector =
		'[data-action="pin-conversation-direct"], [data-action="archive-conversation-direct"], .conversation-actions-trigger';
	const labels = ["Pin conversation", "Archive conversation", "Conversation actions: GUI 会话"];
	const selected = [...document.querySelectorAll('.conversation-link[aria-current="page"]')];
	const row = selected.length === 1 ? selected[0].closest(".conversation-nav-item") : null;
	const controls = row ? [...row.querySelectorAll(selector)] : [];
	const active = document.activeElement;
	const style = (node) => document.defaultView.getComputedStyle(node);
	const describe = (node) =>
		node
			? {
					role: node.getAttribute("role") || node.tagName.toLowerCase(),
					label: node.getAttribute("aria-label"),
					action: node.getAttribute("data-action"),
					inRow: !!row?.contains(node),
					disabled: node.disabled === true,
					focusVisible: node.matches(":focus-visible"),
					opacity: style(node).opacity,
				}
			: null;
	const stable =
		!!row &&
		row === retained?.row &&
		row.isConnected &&
		selected[0] === retained.link &&
		controls.length === 3 &&
		new Set(controls).size === 3 &&
		controls.every(
			(node, position) =>
				node === retained.controls[position] &&
				node.tagName === "BUTTON" &&
				node.getAttribute("aria-label") === labels[position] &&
				!node.disabled &&
				node.getAttribute("aria-disabled") !== "true" &&
				node.tabIndex === 0 &&
				node.getClientRects().length > 0 &&
				style(node).visibility === "visible" &&
				style(node).opacity === "1",
		);
	return {
		valid:
			!!stable &&
			active === (index === -1 ? retained.link : controls[index]) &&
			(index === -1 || active.matches(":focus-visible")),
		index,
		active: describe(active),
		controls: controls.map(describe),
	};
}
/** Read rendered geometry only; do not install UI state or replace runtime responses. */
export function workExperienceGeometry(document, viewport) {
	const selectors = {
		toolbar: ".app-toolbar",
		conversation: ".conversation-panel",
		composer: ".composer",
		input: ".composer textarea",
		submit: '.composer button[type="submit"]',
		model: ".model-status-trigger",
		permissions: ".capabilities-trigger",
		acquisition: ".composer-add-trigger",
	};
	const regions = Object.fromEntries(
		Object.entries(selectors).map(([name, selector]) => {
			const nodes = [...document.querySelectorAll(selector)];
			if (nodes.length !== 1) return [name, null];
			const node = nodes[0];
			const rect = node.getBoundingClientRect();
			return [
				name,
				{
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height,
					disabled: node.disabled === true,
					hit: node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
				},
			];
		}),
	);
	return { ...viewport, scrollWidth: document.documentElement.scrollWidth, regions };
}

export function assertWorkExperienceGeometry(state) {
	assert.ok(state && state.width > 0 && state.height > 0, "Missing viewport geometry");
	assert.ok(state.scrollWidth <= state.width + 1, "Workbench overflows horizontally");
	for (const [name, rect] of Object.entries(state.regions)) {
		assert.ok(rect && rect.width > 0 && rect.height > 0, `${name} is missing or collapsed`);
		assert.ok(
			rect.x >= -1 &&
				rect.y >= -1 &&
				rect.x + rect.width <= state.width + 1 &&
				rect.y + rect.height <= state.height + 1,
			`${name} escapes the visible viewport`,
		);
		if (["input", "submit", "model", "permissions", "acquisition"].includes(name)) {
			assert.equal(rect.disabled, false, `${name} must be actionable during draft layout acceptance`);
			assert.equal(rect.hit, true, `${name} is covered`);
		}
	}
	const { input, submit, composer, toolbar } = state.regions;
	assert.ok(input.y >= toolbar.y + toolbar.height, "Composer overlaps toolbar");
	assert.ok(input.y + input.height <= submit.y + 1, "Composer controls overlap editable text");
	assert.ok(submit.y + submit.height <= composer.y + composer.height + 1, "Send control escapes composer");
}

export async function nativeEditorKey(
	cdp,
	key,
	{ modifiers = 0, composing = false, platform = process.platform } = {},
) {
	const codes = { Enter: 13, Backspace: 8, a: 65, Tab: 9 };
	assert.ok(codes[key], "Unsupported work-experience key");
	// CDP does not translate Cocoa editing bindings; supply their native Chromium command on keydown only.
	const command =
		platform === "darwin" && !composing
			? key === "a" && modifiers === 4
				? "selectAll"
				: key === "Backspace" && modifiers === 0
					? "deleteBackward"
					: undefined
			: undefined;
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", {
			type,
			key,
			code: key === "a" ? "KeyA" : key,
			windowsVirtualKeyCode: composing ? 229 : codes[key],
			modifiers,
			...(type === "keyDown" && key === "Enter" && !composing ? { text: "\r" } : {}),
			...(type === "keyDown" && command ? { commands: [command] } : {}),
		});
}

/** A retained hidden dock is already closed; an obstructed visible close action is not. */
export function filePanelCleanupState(document) {
	const docks = document.querySelectorAll(".file-panel-dock");
	const buttons = document.querySelectorAll(".file-panel-close");
	if (document.querySelectorAll(".file-panel-dialog").length) return null;
	if (docks.length === 0 && buttons.length === 0) return "absent";
	if (docks.length !== 1 || buttons.length !== 1 || !docks[0].contains(buttons[0])) return null;
	const dock = docks[0];
	const button = buttons[0];
	if (dock.hidden || dock.inert || dock.getAttribute("aria-hidden") === "true")
		return dock.hidden &&
			dock.inert &&
			dock.getAttribute("aria-hidden") === "true" &&
			dock.getClientRects().length === 0 &&
			button.getClientRects().length === 0
			? "hidden"
			: null;
	const rectangle = button.getBoundingClientRect();
	return dock.getClientRects().length > 0 &&
		rectangle.width > 0 &&
		rectangle.height > 0 &&
		!button.disabled &&
		button.contains(document.elementFromPoint(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2))
		? "visible"
		: null;
}

export async function exerciseWorkExperience(cdp, helpers, directory, { reopened = false, expectedScope } = {}) {
	const {
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
		hover,
	} = helpers;
	const settings = ".sidebar-settings-trigger";
	const route = settingsHarness(cdp);
	const files = 'header button[aria-label="Show files"]';
	const readDraft = () => evaluate(cdp, "document.querySelector('.composer textarea').value");
	const readKeys = () =>
		evaluate(cdp, `Array.from(document.querySelectorAll('[data-message-id]')).map(e=>'message:'+e.dataset.messageId)`);
	const originalKeys = await readKeys();
	assert.equal(await readDraft(), "", "Layout acceptance requires the completed baseline's empty composer");
	assert.equal(await evaluate(cdp, `document.querySelector('.composer button[type="submit"]').disabled`), true);
	assert.equal(await evaluate(cdp, "document.querySelectorAll('.file-workbench').length"), 0);
	assert.equal(await evaluate(cdp, "document.querySelector('.work-shell').dataset.navigationCollapsed"), "false");
	await openAppearance(cdp);
	const originalMode = (await appearanceChoice(cdp)).mode;
	await route.close(settings);
	const samples = [];
	let failure;
	let result;
	let phase = "draft";
	async function resize(width) {
		await cdp.request("Emulation.setDeviceMetricsOverride", {
			width,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await until(() => evaluate(cdp, `innerWidth === ${width}`), "requested CSS viewport");
		await evaluate(
			cdp,
			"document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
		);
	}
	async function preferences(locale, theme) {
		await setWorkbenchPreferences(cdp, locale, theme);
		await until(
			() =>
				evaluate(
					cdp,
					`document.documentElement.lang === ${JSON.stringify(locale)} && document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
				),
			"applied locale and theme",
		);
	}
	try {
		// Disabled buttons intentionally ignore pointer hit testing. Exercise actionable layout
		// with a real draft instead of weakening the center-hit gate for the send control.
		const retainedDraft = "保留草稿 / retained draft";
		assert.equal(
			await evaluate(
				cdp,
				`(() => { window.__hipiGuiRetainedConversation = document.querySelector('.conversation-panel'); return !!window.__hipiGuiRetainedConversation; })()`,
			),
			true,
		);
		await click(cdp, ".composer textarea");
		await cdp.request("Input.insertText", { text: retainedDraft });
		phase = "settings";
		await route.open(".sidebar-settings-trigger", "appearance");
		assert.equal((await appearanceChoice(cdp)).mode, originalMode);
		const settingsEvidence = await route.inspect(directory, `work-experience-${reopened ? "reopened-" : ""}settings`);
		const nativeAppearance = await inspectNativeAppearance(
			cdp,
			helpers,
			route,
			directory,
			`work-experience-${reopened ? "reopened-" : ""}native-appearance`,
		);
		await click(cdp, '.settings-page-nav button[data-category="models"]');
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.settings-page-nav [aria-current="page"]')?.dataset.category === 'models' && document.querySelector('.settings-section:not([hidden]) [data-setting="provider:faux"]')?.disabled === true && document.querySelector('[data-setting="provider:faux"] output')?.dataset.state === 'configured'`,
				),
			"actual model catalog in selected category",
		);
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}settings-models`);
		// Category activation moves focus to its heading. Start keyboard traversal from the actual search input instead.
		await click(cdp, ".settings-search-input");
		for (let index = 0; index < 4; index++) await nativeEditorKey(cdp, "Tab");
		assert.equal(await evaluate(cdp, `document.activeElement?.dataset.category`), "runtime");
		await nativeEditorKey(cdp, "Enter");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.settings-page-nav [aria-current="page"]')?.dataset.category === 'runtime' && document.querySelector('.settings-section:not([hidden])')?.textContent.includes('GUI 会话') && document.activeElement === document.querySelector('.settings-page-heading')`,
				),
			"keyboard runtime category and heading focus with current conversation",
		);
		await route.geometry();
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}settings-runtime`);
		await route.close(".sidebar-settings-trigger");
		assert.equal(await readDraft(), retainedDraft, "Settings must retain the task draft");
		assert.equal(
			await evaluate(cdp, `window.__hipiGuiRetainedConversation === document.querySelector('.conversation-panel')`),
			true,
			"Settings must retain the conversation DOM identity",
		);
		assert.deepEqual(await readKeys(), originalKeys);
		assert.ok(expectedScope?.workspaceId && expectedScope?.conversationId, "Direct capabilities require receipt scope");
		await click(cdp, ".composer-add-trigger");
		const contextId = await evaluate(
			cdp,
			`document.querySelector('.composer-add-menu .capability-context-trigger')?.getAttribute('aria-controls')`,
		);
		assert.ok(contextId, "Direct Context trigger must identify its exact consent dialog");
		await click(cdp, ".composer-add-menu .capability-context-trigger");
		await until(
			() =>
				evaluate(
					cdp,
					`(${directContextConsentEvidence.toString()})(document,${JSON.stringify(expectedScope)},${JSON.stringify(contextId)},window.__hipiGuiRetainedConversation)`,
				),
			"direct Context opens exact scoped consent without an authorized root",
		);
		assert.equal(
			await evaluate(
				cdp,
				`[...document.querySelectorAll('.context-consent-dialog button')].find(e => e.textContent.trim() === 'Authorize model context')?.disabled`,
			),
			true,
			"No-root Context must not authorize access",
		);
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, ".composer-add-trigger");
		await click(cdp, ".composer-add-trigger");
		await click(cdp, ".composer-add-menu .capability-tools-trigger");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.conversation-options-dialog')?.dataset.section === 'tool-packs'
			&& document.querySelector('.conversation-options-dialog [data-slot="dialog-title"]')?.textContent === 'Tool packs' `,
				),
			"direct Tools opens the existing conversation tool-pack section",
		);
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, ".composer-add-trigger");
		assert.equal(
			await readDraft(),
			retainedDraft,
			"Direct capability dialogs must not submit or replace the task draft",
		);
		assert.deepEqual(await readKeys(), originalKeys);
		assert.equal(
			await evaluate(cdp, `window.__hipiGuiRetainedConversation === document.querySelector('.conversation-panel')`),
			true,
		);
		phase = "matrix";
		for (const item of reopened
			? layoutCases.filter((item) => item.locale === "en" && item.theme === "light")
			: layoutCases) {
			await resize(item.width);
			await preferences(item.locale, item.theme);
			assert.equal(await readDraft(), retainedDraft, "Layout changes must retain the task draft");
			assert.deepEqual(await readKeys(), originalKeys, "Layout changes must retain conversation identities");
			if (
				(item.width === 1440 && item.locale === "en" && item.theme === "light") ||
				(item.width === 640 && item.locale === "zh-CN" && item.theme === "dark")
			) {
				await openAppearance(cdp);
				await route.geometry();
				await capture(
					cdp,
					directory,
					`work-experience-${reopened ? "reopened-" : ""}settings-${item.width}-${item.locale}-${item.theme}`,
				);
				await route.close(settings);
			}
			const geometry = await evaluate(
				cdp,
				`(${workExperienceGeometry.toString()})(document,{width:innerWidth,height:innerHeight})`,
			);
			assertWorkExperienceGeometry(geometry);
			await assertNoAlerts(cdp);
			const screenshot = `work-experience-${reopened ? "reopened-" : ""}${item.width}-${item.locale}-${item.theme}`;
			await capture(cdp, directory, screenshot);
			samples.push({ ...item, geometry, screenshot: `${screenshot}.png` });
		}
		phase = "sidebar";
		await resize(1440);
		await preferences("en", "light");
		await click(cdp, ".composer textarea");
		await hover(cdp, ".composer textarea");
		await until(
			() => evaluate(cdp, `!document.querySelector('.conversation-preview-card')`),
			"sidebar default without hover card",
		);
		await until(
			() =>
				evaluate(
					cdp,
					`getComputedStyle(document.querySelector('.conversation-nav-item .conversation-actions-trigger')).opacity === '0'`,
				),
			"desktop sidebar actions hidden before hover or focus",
		);
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}sidebar-default`);
		await hover(cdp, ".conversation-link");
		await until(
			() =>
				evaluate(
					cdp,
					`!!document.querySelector('.conversation-preview-card') && getComputedStyle(document.querySelector('.conversation-nav-item .conversation-actions-trigger')).opacity === '1'`,
				),
			"sidebar hover preview and actions",
		);
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}sidebar-hover`);
		await hover(cdp, ".composer textarea");
		await until(
			() => evaluate(cdp, `!document.querySelector('.conversation-preview-card')`),
			"hover preview dismissed on pointer leave",
		);
		await click(cdp, ".conversation-link");
		await evaluate(
			cdp,
			`(() => {
				const links = [...document.querySelectorAll('.conversation-link[aria-current="page"]')];
				const link = links.length === 1 ? links[0] : null;
				const row = link?.closest('.conversation-nav-item');
				window.__hipiGuiKeyboardRow = {link, row, controls: row ? [...row.querySelectorAll('[data-action="pin-conversation-direct"], [data-action="archive-conversation-direct"], .conversation-actions-trigger')] : []};
			})()`,
		);
		const keyboardTrace = [];
		const keyboardEvidence = async (index) => {
			const evidence = await evaluate(
				cdp,
				`(${sidebarKeyboardEvidence.toString()})(document,window.__hipiGuiKeyboardRow,${index})`,
			);
			keyboardTrace.push(evidence);
			return evidence;
		};
		try {
			await until(
				async () => (await keyboardEvidence(-1)).valid,
				"selected sidebar row has settled, enabled Pin, Archive and overflow actions",
			);
			for (let index = 0; index < 3; index++) {
				await nativeEditorKey(cdp, "Tab");
				assert.equal((await keyboardEvidence(index)).valid, true, "Sidebar native Tab order or identity changed");
			}
		} catch (error) {
			throw new Error(`Sidebar keyboard trace: ${JSON.stringify(keyboardTrace)}`, { cause: error });
		}
		await nativeEditorKey(cdp, "Enter");
		await until(() => evaluate(cdp, `!!document.querySelector('[role="menu"]')`), "sidebar keyboard action menu");
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, ".conversation-nav-item .conversation-actions-trigger");
		assert.equal(
			(await keyboardEvidence(2)).valid,
			true,
			`Sidebar Escape must restore the retained overflow: ${JSON.stringify(keyboardTrace)}`,
		);
		assert.equal(await readDraft(), retainedDraft);
		assert.deepEqual(await readKeys(), originalKeys);
		await click(cdp, ".composer textarea");
		phase = "composer";
		await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
		await cdp.request("Input.insertText", { text: retainedDraft });
		await until(
			() => evaluate(cdp, `document.querySelector('.composer button[type="submit"]')?.disabled === false`),
			"draft is eligible to submit before exercising the composition guard",
		);
		await nativeEditorKey(cdp, "Enter", { modifiers: 8 });
		await cdp.request("Input.insertText", { text: "second line" });
		assert.equal(
			await readDraft(),
			"保留草稿 / retained draft\nsecond line",
			"Shift+Enter must insert a newline, not submit",
		);
		await cdp.request("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
		await nativeEditorKey(cdp, "Enter", { composing: true });
		await cdp.request("Input.insertText", { text: "中文" });
		const draft = await readDraft();
		assert.ok(draft.endsWith("中文"), "CDP composition text was not retained");
		assert.deepEqual(await readKeys(), originalKeys, "Composition confirmation must not submit a new task");
		await nativeEditorKey(cdp, "Tab");
		assert.ok(
			await evaluate(
				cdp,
				`(() => {const e=document.activeElement;const s=getComputedStyle(e);return !!e?.closest('.composer') && e.tagName==='BUTTON' && e.matches(':focus-visible') && (s.outlineStyle!=='none' || s.boxShadow!=='none');})()`,
			),
			"Keyboard composer focus must be visible",
		);
		await click(cdp, ".sidebar-collapse");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.work-shell').dataset.navigationCollapsed==='true' && !document.querySelector('.sidebar').getClientRects().length`,
				),
			"desktop sidebar collapsed",
		);
		assert.equal(await readDraft(), draft);
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}collapsed`);
		await click(cdp, ".navigation-toggle");
		await until(
			() => evaluate(cdp, `document.querySelector('.work-shell').dataset.navigationCollapsed==='false'`),
			"desktop sidebar restored",
		);
		phase = "files";
		await click(cdp, files);
		await until(
			() =>
				evaluate(
					cdp,
					"!!document.querySelector('.file-panel-dock') && document.querySelectorAll('.file-workbench').length===1",
				),
			"wide file canvas dock",
		);
		assert.equal(await readDraft(), draft);
		await resize(640);
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelectorAll('.file-panel-dialog[role="dialog"]').length===1 && !document.querySelector('.file-panel-dock') && document.querySelectorAll('.file-workbench').length===1`,
				),
			"single narrow file modal",
		);
		const modal = await evaluate(
			cdp,
			`(() => {const e=document.querySelector('.file-panel-dialog');const r=e.getBoundingClientRect(); const b=e.querySelector('.file-panel-close');const q=b.getBoundingClientRect();return {contained:r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,focus:e.contains(document.activeElement),closeHit:b.contains(document.elementFromPoint(q.x+q.width/2,q.y+q.height/2))};})()`,
		);
		assert.deepEqual(modal, { contained: true, focus: true, closeHit: true });
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}files-narrow`);
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, files);
		assert.equal(await readDraft(), draft);
		assert.deepEqual(await readKeys(), originalKeys, "Responsive file canvas must retain conversation identities");
		assert.equal(
			await evaluate(cdp, `window.__hipiGuiRetainedConversation === document.querySelector('.conversation-panel')`),
			true,
			"File canvas must retain the conversation DOM identity",
		);
		await click(cdp, ".navigation-toggle");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.work-shell').dataset.navigationOpen==='true' && document.querySelector('.sidebar').contains(document.activeElement)`,
				),
			"narrow navigation focus",
		);
		await pressKey(cdp, "Escape");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.work-shell').dataset.navigationOpen==='false' && document.activeElement===document.querySelector('.navigation-toggle')`,
				),
			"narrow navigation Escape focus",
		);
		await assertNoAlerts(cdp);
		// The deterministic catalog has no mutable official-provider row. Do not manufacture
		// one or reinterpret a faux configured status as a native credential-storage check.
		phase = "settings";
		await resize(1440);
		await openAppearance(cdp);
		await click(cdp, '.settings-page-nav button[data-category="models"]');
		const credentialJourney = await until(
			() => evaluate(cdp, `(${deterministicCredentialEvidence.toString()})(document)`),
			"actual deterministic catalog has one read-only faux service and no official credential editor",
		);
		await route.close(settings);
		assert.equal(await readDraft(), draft, "Provider list must retain the task draft");
		assert.deepEqual(await readKeys(), originalKeys);
		assert.equal(
			await evaluate(cdp, `window.__hipiGuiRetainedConversation === document.querySelector('.conversation-panel')`),
			true,
			"Provider list must retain the conversation DOM identity",
		);
		await assertNoAlerts(cdp);
		result = {
			samples,
			sidebarCollapse: true,
			settingsCategories: true,
			settingsImmediatePreferences: settingsEvidence,
			nativeAppearance,
			directCapabilitiesScopedAndFocusRestored: true,
			settingsKeyboardNavigation: true,
			credentialJourney,
			settingsRetainedDraftAndConversation: true,
			sidebarHoverAndKeyboardActions: true,
			narrowNavigationEscapeFocus: true,
			composerKeyboardFocus: true,
			shiftEnterPreservedDraft: true,
			cdpCompositionGuard: true,
			fileCanvasRetainedConversation: true,
			fileCanvasRetainedDraft: true,
			fileCanvasNarrowModalFocus: true,
			notValidated: [
				"physical IME",
				"native OS window resizing (CSS viewport emulation used)",
				"individual pending approval (no legitimate fixture in baseline)",
				"inline activity with tool records (baseline executes no tools)",
				"native font-number spinner (blur and Enter commits exercised)",
				"execution cancellation (baseline completed task preserved)",
				"error-state layout (covered separately by file-workbench fixture)",
				"visual review of generated screenshots",
			],
		};
	} catch (error) {
		failure = error;
		if (error instanceof Error) error.workExperiencePhase = phase;
		try {
			await capture(cdp, directory, "work-experience-failure");
		} catch {
			/* Preserve the first failure. */
		}
	} finally {
		try {
			// Close only acceptance-owned overlays, then restore actual preferences through their UI.
			for (
				let index = 0;
				index < 3 && (await evaluate(cdp, `!!document.querySelector('[role="dialog"],[role="menu"]')`));
				index++
			) {
				await pressKey(cdp, "Escape");
			}
			if (await evaluate(cdp, `!!document.querySelector('.settings-modal')`)) await route.close();
			await resize(1440);
			if (await evaluate(cdp, `document.querySelector('.work-shell').dataset.navigationCollapsed==='true'`))
				await click(cdp, ".navigation-toggle");
			const filesState = await until(
				() => evaluate(cdp, `(${filePanelCleanupState.toString()})(document)`),
				"file cleanup is absent, strictly hidden/inert, or visibly actionable",
			);
			if (filesState === "visible") {
				await click(cdp, ".file-panel-close");
				await until(
					async () => (await evaluate(cdp, `(${filePanelCleanupState.toString()})(document)`)) === "hidden",
					"file cleanup hides the retained dock without clicking its hidden close button",
				);
			}
			await preferences("en", "light");
			await click(cdp, ".composer textarea");
			await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
			await nativeEditorKey(cdp, "Backspace");
			assert.equal(await readDraft(), "", "Acceptance draft must be removed before restart");
			await openAppearance(cdp);
			await setAppearanceChoice(cdp, "theme", originalMode);
			await route.close(settings);
			await cdp.request("Emulation.clearDeviceMetricsOverride");
			await evaluate(cdp, "delete window.__hipiGuiRetainedConversation");
			await evaluate(cdp, "delete window.__hipiGuiKeyboardRow");
			assert.deepEqual(await readKeys(), originalKeys);
		} catch (restoreError) {
			if (restoreError instanceof Error) restoreError.workExperiencePhase = "restoration";
			failure = failure
				? new AggregateError([failure, restoreError], "Work-experience acceptance and restoration failed")
				: restoreError;
		}
	}
	if (failure) throw failure;
	return result;
}
