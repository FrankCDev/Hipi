import assert from "node:assert/strict";

export const layoutCases = [1440, 1280, 1024, 640].flatMap((width) =>
	["en", "zh-CN"].flatMap((locale) => ["light", "dark"].map((theme) => ({ width, height: 900, locale, theme }))),
);

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
		context: ".capability-context-trigger",
		tools: ".capability-tools-trigger",
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
		if (["input", "submit", "model", "permissions", "context", "tools"].includes(name)) {
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
		saveAppearance,
		inspectModal,
		inspectSettingsGuard,
		hover,
	} = helpers;
	const settings = ".workbench-settings-trigger";
	const files = 'header button[aria-label="Show files"]';
	const readDraft = () => evaluate(cdp, "document.querySelector('.composer textarea').value");
	const readKeys = () =>
		evaluate(
			cdp,
			`Array.from(document.querySelectorAll('[data-message-key^="message:"]')).map(e=>e.dataset.messageKey)`,
		);
	const originalKeys = await readKeys();
	assert.equal(await readDraft(), "", "Layout acceptance requires the completed baseline's empty composer");
	assert.equal(await evaluate(cdp, `document.querySelector('.composer button[type="submit"]').disabled`), true);
	assert.equal(await evaluate(cdp, "document.querySelectorAll('.file-workbench').length"), 0);
	assert.equal(await evaluate(cdp, "document.querySelector('.work-shell').dataset.navigationCollapsed"), "false");
	await openAppearance(cdp);
	const originalMode = (await appearanceChoice(cdp)).mode;
	await pressKey(cdp, "Escape");
	await waitForOverlayClosed(cdp, settings);
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
		await click(cdp, ".sidebar-settings-trigger");
		await until(
			() => evaluate(cdp, `document.activeElement === document.querySelector('.settings-page-header h2')`),
			"settings heading receives initial focus",
		);
		assert.equal((await appearanceChoice(cdp)).mode, originalMode);
		await inspectSettingsGuard(cdp);
		await click(cdp, '.settings-page-nav button[data-category="models"]');
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.settings-page-nav [aria-current="page"]')?.dataset.category === 'models' && document.querySelector('.settings-section:not([hidden])')?.textContent.includes('faux-1')`,
				),
			"actual model catalog in selected category",
		);
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}settings-models`);
		await click(cdp, '.settings-page-nav button[data-category="models"]');
		await nativeEditorKey(cdp, "Tab");
		assert.equal(await evaluate(cdp, `document.activeElement?.dataset.category`), "runtime");
		// Native button activation requires Enter's character event, not only a JS keydown.
		await nativeEditorKey(cdp, "Enter");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.settings-page-nav [aria-current="page"]')?.dataset.category === 'runtime' && document.querySelector('.settings-section:not([hidden])')?.textContent.includes('GUI 会话')`,
				),
			"keyboard runtime category with current conversation",
		);
		await inspectModal(cdp, ".unified-settings-dialog", "center");
		await capture(cdp, directory, `work-experience-${reopened ? "reopened-" : ""}settings-runtime`);
		await click(cdp, ".settings-section:not([hidden]) button", "Return to conversation");
		await waitForOverlayClosed(cdp, ".sidebar-settings-trigger");
		assert.equal(await readDraft(), retainedDraft, "Settings must retain the task draft");
		assert.equal(
			await evaluate(cdp, `window.__hipiGuiRetainedConversation === document.querySelector('.conversation-panel')`),
			true,
			"Settings must retain the conversation DOM identity",
		);
		assert.deepEqual(await readKeys(), originalKeys);
		assert.ok(expectedScope?.workspaceId && expectedScope?.conversationId, "Direct capabilities require receipt scope");
		await click(cdp, ".capability-context-trigger");
		await until(
			() =>
				evaluate(
					cdp,
					`(() => {
			const dialog = document.querySelector('.context-consent-dialog');
			return dialog?.textContent.includes(${JSON.stringify(`${expectedScope.workspaceId} / ${expectedScope.conversationId}`)})
				&& dialog.textContent.includes('faux-1') && dialog.textContent.includes('No authorized folders available.');
		})()`,
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
		await waitForOverlayClosed(cdp, ".capability-context-trigger");
		await click(cdp, ".capability-tools-trigger");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.capabilities-section')?.dataset.section === 'tool-packs'
			&& document.querySelector('.capabilities-navigation [aria-current="page"]')?.dataset.section === 'tool-packs'
			&& document.querySelector('.capabilities-summary strong')?.textContent === document.querySelector('.toolbar-conversation')?.textContent`,
				),
			"direct Tools opens the existing conversation tool-pack section",
		);
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, ".capability-tools-trigger");
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
				await inspectModal(cdp, ".unified-settings-dialog", "center");
				await capture(
					cdp,
					directory,
					`work-experience-${reopened ? "reopened-" : ""}settings-${item.width}-${item.locale}-${item.theme}`,
				);
				await pressKey(cdp, "Escape");
				await waitForOverlayClosed(cdp, settings);
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
		await nativeEditorKey(cdp, "Tab");
		assert.ok(
			await evaluate(
				cdp,
				`document.activeElement === document.querySelector('.conversation-nav-item .conversation-actions-trigger') && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).opacity === '1'`,
			),
			"Sidebar actions must be keyboard discoverable",
		);
		await pressKey(cdp, "Enter");
		await until(() => evaluate(cdp, `!!document.querySelector('[role="menu"]')`), "sidebar keyboard action menu");
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, ".conversation-nav-item .conversation-actions-trigger");
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
		// Keep the platform credential read mandatory, but independent core visual evidence comes first.
		phase = "settings";
		await resize(1440);
		await openAppearance(cdp);
		await click(cdp, '.settings-page-nav button[data-category="models"]');
		assert.equal(
			await evaluate(
				cdp,
				`(() => { const matches=[...document.querySelectorAll('.settings-section:not([hidden]) button')].filter(e => e.textContent.trim() === 'Model settings'); window.__hipiGuiCredentialTrigger = matches.length === 1 ? matches[0] : null; return !!window.__hipiGuiCredentialTrigger; })()`,
			),
			true,
		);
		phase = "credential_open";
		await click(cdp, ".settings-section:not([hidden]) button", "Model settings");
		await until(
			() =>
				evaluate(
					cdp,
					`!!document.querySelector('.model-settings-dialog') && !document.querySelector('.model-settings-dialog button[data-slot="dialog-close"]').disabled`,
				),
			"credential status read completed",
		);
		phase = "credential_close";
		await pressKey(cdp, "Escape");
		await until(
			() =>
				evaluate(
					cdp,
					`!document.querySelector('.model-settings-dialog') && !!document.querySelector('.unified-settings-dialog') && window.__hipiGuiCredentialTrigger?.isConnected && document.activeElement === window.__hipiGuiCredentialTrigger`,
				),
			"nested credentials restores exact trigger",
		);
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, settings);
		assert.equal(await readDraft(), draft, "Nested credentials must retain the task draft");
		assert.deepEqual(await readKeys(), originalKeys);
		assert.equal(
			await evaluate(cdp, `window.__hipiGuiRetainedConversation === document.querySelector('.conversation-panel')`),
			true,
			"Nested credentials must retain the conversation DOM identity",
		);
		await assertNoAlerts(cdp);
		result = {
			samples,
			sidebarCollapse: true,
			settingsCategories: true,
			settingsDirtyNavigationGuard: true,
			directCapabilitiesScopedAndFocusRestored: true,
			settingsKeyboardNavigation: true,
			nestedCredentialsEscapeFocus: true,
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
				if (await evaluate(cdp, `!!document.querySelector('.settings-unsaved-dialog')`)) {
					const english = await evaluate(cdp, `document.documentElement.lang === 'en'`);
					await click(cdp, ".settings-unsaved-actions > button", english ? "Discard changes" : "放弃修改");
				} else await pressKey(cdp, "Escape");
			}
			await resize(1440);
			if (await evaluate(cdp, `document.querySelector('.work-shell').dataset.navigationCollapsed==='true'`))
				await click(cdp, ".navigation-toggle");
			if (await evaluate(cdp, "!!document.querySelector('.file-panel-close')")) await click(cdp, ".file-panel-close");
			await preferences("en", "light");
			await click(cdp, ".composer textarea");
			await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
			await nativeEditorKey(cdp, "Backspace");
			assert.equal(await readDraft(), "", "Acceptance draft must be removed before restart");
			await openAppearance(cdp);
			await setAppearanceChoice(cdp, "theme", originalMode);
			await saveAppearance(cdp);
			await pressKey(cdp, "Escape");
			await waitForOverlayClosed(cdp, settings);
			await cdp.request("Emulation.clearDeviceMetricsOverride");
			await evaluate(cdp, "delete window.__hipiGuiRetainedConversation; delete window.__hipiGuiCredentialTrigger");
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
