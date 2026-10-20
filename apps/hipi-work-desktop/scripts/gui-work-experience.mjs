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
		permissions: ".permission-controls button",
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
		if (["input", "submit", "model", "permissions"].includes(name)) assert.equal(rect.hit, true, `${name} is covered`);
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

export async function exerciseWorkExperience(cdp, helpers, directory, { reopened = false } = {}) {
	const { evaluate, click, until, pressKey, capture, waitForOverlayClosed, appearanceChoice, assertNoAlerts } = helpers;
	const settings = 'button[aria-label="Workbench settings"],button[aria-label="工作台设置"]';
	const files = 'header button[aria-label="Show files"]';
	const readDraft = () => evaluate(cdp, "document.querySelector('.composer textarea').value");
	const readKeys = () =>
		evaluate(
			cdp,
			`Array.from(document.querySelectorAll('[data-message-key^="message:"]')).map(e=>e.dataset.messageKey)`,
		);
	const originalKeys = await readKeys();
	assert.equal(await readDraft(), "", "Layout acceptance requires the completed baseline's empty composer");
	assert.equal(await evaluate(cdp, "document.querySelectorAll('.file-workbench').length"), 0);
	assert.equal(await evaluate(cdp, "document.querySelector('.work-shell').dataset.navigationCollapsed"), "false");
	await click(cdp, settings);
	await click(cdp, ".workbench-settings button", "Appearance and language");
	const originalMode = (await appearanceChoice(cdp)).mode;
	await pressKey(cdp, "Escape");
	await until(() => evaluate(cdp, "!document.querySelector('.settings-dialog')"), "appearance closed");
	await pressKey(cdp, "Escape");
	await waitForOverlayClosed(cdp, settings);
	const samples = [];
	let failure;
	let result;
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
		await click(cdp, settings);
		const language = locale === "en" ? "Switch to English" : "切换到中文";
		if (await evaluate(cdp, `!!document.querySelector('.workbench-settings button[aria-label="${language}"]')`))
			await click(cdp, `.workbench-settings button[aria-label="${language}"]`);
		if (await evaluate(cdp, `document.documentElement.dataset.theme !== ${JSON.stringify(theme)}`))
			await click(
				cdp,
				'.workbench-settings button[aria-label="Toggle light / dark theme"],.workbench-settings button[aria-label="切换明暗主题"]',
			);
		await pressKey(cdp, "Escape");
		await waitForOverlayClosed(cdp, settings);
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
		for (const item of reopened
			? layoutCases.filter((item) => item.locale === "en" && item.theme === "light")
			: layoutCases) {
			await resize(item.width);
			await preferences(item.locale, item.theme);
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
		await resize(1440);
		await preferences("en", "light");
		await click(cdp, ".composer textarea");
		await cdp.request("Input.insertText", { text: "保留草稿 / retained draft" });
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
		result = {
			samples,
			sidebarCollapse: true,
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
			)
				await pressKey(cdp, "Escape");
			await resize(1440);
			if (await evaluate(cdp, `document.querySelector('.work-shell').dataset.navigationCollapsed==='true'`))
				await click(cdp, ".navigation-toggle");
			if (await evaluate(cdp, "!!document.querySelector('.file-panel-close')")) await click(cdp, ".file-panel-close");
			await preferences("en", "light");
			await click(cdp, ".composer textarea");
			await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
			await nativeEditorKey(cdp, "Backspace");
			assert.equal(await readDraft(), "", "Acceptance draft must be removed before restart");
			await click(cdp, settings);
			await click(cdp, ".workbench-settings button", "Appearance and language");
			const choice = await appearanceChoice(cdp);
			await click(cdp, choice.selector);
			await click(cdp, '[role="option"]', originalMode);
			await until(() => evaluate(cdp, `!document.querySelector('[role="option"]')`), "theme choice closed");
			await click(cdp, ".settings-dialog button", "Save");
			await until(() => evaluate(cdp, "!document.querySelector('.settings-dialog')"), "theme preference saved");
			await pressKey(cdp, "Escape");
			await waitForOverlayClosed(cdp, settings);
			await cdp.request("Emulation.clearDeviceMetricsOverride");
			assert.deepEqual(await readKeys(), originalKeys);
		} catch (restoreError) {
			failure = failure
				? new AggregateError([failure, restoreError], "Work-experience acceptance and restoration failed")
				: restoreError;
		}
	}
	if (failure) throw failure;
	return result;
}
