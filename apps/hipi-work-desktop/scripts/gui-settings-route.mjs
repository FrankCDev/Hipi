import assert from "node:assert/strict";

const routeSelector = ".settings-modal";
const languageSelector = `${routeSelector} [data-setting="language"] [role="combobox"]`;
const themeSelector = `${routeSelector} input[name="appearance-theme"]`;
const storageKey = "hipi-work.preferences.v1";
const categories = ["general", "appearance", "models", "runtime"];

/** Renderer observations only. The native harness owns every input and navigation action. */
export function settingsModalGeometry(document, viewport) {
	const selectors = {
		route: ".settings-modal",
		close: '.settings-modal [data-slot="dialog-close"]',
		dialogTitle: '.settings-modal [data-slot="dialog-title"]',
		title: ".settings-modal .settings-page-heading",
		body: ".settings-modal .settings-page-content",
		search: ".settings-modal .settings-search-input",
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
					visible: node.getClientRects().length > 0,
					disabled: node.disabled === true,
					hit: node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
				},
			];
		}),
	);
	const route = document.querySelector(selectors.route);
	const body = document.querySelector(selectors.body);
	return {
		...viewport,
		regions,
		modal: route?.getAttribute("role") === "dialog" && route?.getAttribute("data-slot") === "dialog-content",
		overlay: document.querySelectorAll('[data-slot="dialog-overlay"]').length === 1,
		legacyControls: !!document.querySelector(".settings-savebar, .settings-unsaved-dialog"),
		scrollWidth: document.documentElement.scrollWidth,
		bodyScrollWidth: body?.scrollWidth,
		bodyClientWidth: body?.clientWidth,
		scrollTop: body?.scrollTop,
		clientHeight: body?.clientHeight,
		scrollHeight: body?.scrollHeight,
	};
}

export function assertSettingsModalGeometry(state) {
	assert.ok(state && state.width > 0 && state.height > 0, "Settings needs a visible viewport");
	assert.equal(state.modal, true, "Settings must expose modal dialog semantics");
	assert.equal(state.overlay, true, "Settings needs one dimming overlay");
	assert.equal(state.legacyControls, false, "Settings must persist without Save or a dirty-navigation guard");
	assert.ok(state.scrollWidth <= state.width + 1, "Settings overflows the viewport horizontally");
	assert.ok(state.bodyScrollWidth <= state.bodyClientWidth + 1, "Settings content overflows horizontally");
	for (const [name, rect] of Object.entries(state.regions)) {
		assert.ok(rect?.visible && rect.width > 0 && rect.height > 0, `Settings ${name} is missing or collapsed`);
		assert.ok(
			rect.x >= -1 &&
				rect.y >= -1 &&
				rect.x + rect.width <= state.width + 1 &&
				rect.y + rect.height <= state.height + 1,
			`Settings ${name} escapes the viewport`,
		);
		assert.equal(rect.disabled, false, `Settings ${name} is disabled`);
		assert.equal(rect.hit, true, `Settings ${name} is covered`);
	}
	const { route, body, title } = state.regions;
	for (const [name, rect] of Object.entries(state.regions)) {
		if (name === "route") continue;
		assert.ok(
			rect.x >= route.x - 1 &&
				rect.y >= route.y - 1 &&
				rect.x + rect.width <= route.x + route.width + 1 &&
				rect.y + rect.height <= route.y + route.height + 1,
			`Settings ${name} escapes its modal surface`,
		);
	}
	assert.ok(
		Math.abs(route.x * 2 + route.width - state.width) <= 2 &&
			Math.abs(route.y * 2 + route.height - state.height) <= 2 &&
			route.x >= (state.width <= 600 ? 12 : 24) - 1 &&
			route.y >= (state.width <= 600 ? 12 : 24) - 1 &&
			route.width <= 1001 &&
			route.height <= (state.width <= 600 ? state.height - 23 : 721),
		"Settings must be a centered bounded modal, not a full-screen page",
	);
	assert.ok(title.y >= body.y - 1 && title.y + title.height <= body.y + body.height + 1);
}

export function settingsChoice(document, field) {
	const routes = [...document.querySelectorAll(".settings-modal")];
	if (routes.length !== 1) return null;
	const route = routes[0];
	if (field === "theme") {
		const radios = [...route.querySelectorAll('input[name="appearance-theme"]')];
		const selected = radios.filter((node) => node.checked);
		if (
			radios.length !== 3 ||
			new Set(radios.map((node) => node.value)).size !== 3 ||
			!radios.every((node) => ["system", "light", "dark"].includes(node.value)) ||
			selected.length !== 1
		)
			return null;
		return {
			mode: selected[0].value,
			selector: `.settings-modal input[name="appearance-theme"][value="${selected[0].value}"]`,
		};
	}
	if (field !== "language") return null;
	const controls = [...route.querySelectorAll('[data-setting="language"] [role="combobox"]')];
	const locale = document.documentElement.lang;
	if (
		controls.length !== 1 ||
		!["en", "zh-CN"].includes(locale) ||
		controls[0].textContent.trim() !== (locale === "en" ? "English" : "简体中文")
	)
		return null;
	return {
		mode: locale,
		locale,
		selector: '.settings-modal [data-setting="language"] [role="combobox"]',
	};
}

export function assertSettingsDestination(state, category) {
	assert.equal(state.open, true, "Search must leave the Settings modal open");
	assert.equal(state.category, category, "Search navigated to the wrong category");
	assert.equal(state.query, "", "Selecting a search destination must clear its query");
	assert.equal(state.count, 1, "Search destination must resolve one actual setting");
	assert.equal(state.focused, true, "Search must focus the destination or its control");
	assert.equal(state.visible, true, "Search destination must be visible");
	assert.equal(state.detailsOpen, true, "Search must expand the destination's advanced section");
	assert.equal(state.dialogs, 1, "Search must retain only the Settings dialog, without opening another modal");
}

export function createSettingsHarness(cdp, helpers) {
	const { evaluate, click, until, nativeEditorKey, capture, pressKey } = helpers;
	const read = (expression) => evaluate(cdp, expression);
	const saved = () => read(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}) || 'null')`);
	const navigate = async (category) => {
		assert.ok(categories.includes(category), "Unknown Settings category");
		await click(cdp, `.settings-page-nav button[data-category="${category}"]`);
		await until(
			() =>
				read(
					`document.querySelector('.settings-page-nav [aria-current="page"]')?.dataset.category === ${JSON.stringify(category)} && document.activeElement === document.querySelector('.settings-page-heading')`,
				),
			"Settings category and heading focus",
		);
	};
	const open = async (trigger = ".sidebar-settings-trigger", category = "appearance") => {
		assert.ok(categories.includes(category), "Unknown Settings category");
		const navigation = await read(`(() => {
			const shell = document.querySelector('.work-shell');
			return { narrow: shell?.dataset.navigationMode === 'narrow',
				open: shell?.dataset.navigationOpen === 'true', collapsed: shell?.dataset.navigationCollapsed === 'true' };
		})()`);
		const reveal =
			trigger === ".sidebar-settings-trigger" && (navigation.narrow ? !navigation.open : navigation.collapsed);
		if (reveal) {
			await click(cdp, ".navigation-toggle");
			await until(
				() =>
					read(
						"!document.querySelector('.sidebar').inert && document.querySelector('.sidebar-settings-trigger').getClientRects().length > 0",
					),
				"Settings sidebar opener revealed through native navigation",
			);
		}
		assert.equal(
			await read(`(() => {
				if (document.querySelector(${JSON.stringify(routeSelector)})) return false;
				const nodes = [...document.querySelectorAll(${JSON.stringify(trigger)})].filter(e => !e.disabled && e.getClientRects().length);
				if (nodes.length !== 1) return false;
				const sidebar = document.querySelector('.sidebar'), main = document.querySelector('.main-shell');
				if (!sidebar || !main) return false;
				window.__hipiGuiSettingsOpener = { node: nodes[0], selector: ${JSON.stringify(trigger)}, sidebar, main,
					mainInert: main.inert, navigation: ${JSON.stringify(navigation)}, reveal: ${reveal} };
				return true;
			})()`),
			true,
			"Settings requires its exact visible original opener",
		);
		await click(cdp, trigger);
		await until(
			() =>
				read(
					`document.querySelector(${JSON.stringify(routeSelector)})?.getAttribute('role') === 'dialog' && document.activeElement === document.querySelector('.settings-search-input') && document.querySelectorAll('[role="dialog"]').length === 1`,
				),
			"Settings modal and initial search focus",
		);
		// Retain the actual node in the renderer, never serialize a React-backed DOM node through CDP.
		await read("void (window.__hipiGuiSettingsSurface = document.querySelector('.settings-modal'))");
		await retained(true);
		await navigate(category);
	};
	const retained = async (inert) => {
		assert.equal(
			await read(`(() => {
			const before = window.__hipiGuiSettingsOpener;
			return ['sidebar','main'].every(name => {
				const node = before[name], current = document.querySelector(name === 'sidebar' ? '.sidebar' : '.main-shell');
				return node === current && node.isConnected && node.inert === ${inert} &&
					getComputedStyle(node).visibility === 'visible' && Number(getComputedStyle(node).opacity) > 0;
			});
		})()`),
			true,
			"Settings must retain visible application owners with the correct inert state",
		);
	};
	const closed = async () => {
		await until(
			() =>
				read(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(
				!document.querySelector(${JSON.stringify(routeSelector)}) &&
				!document.querySelector('[role="dialog"],[role="menu"],[role="option"]') &&
				window.__hipiGuiSettingsOpener.node.isConnected &&
				document.activeElement === window.__hipiGuiSettingsOpener.node
			))))`),
			"Settings Close restores the exact opener",
		);
		// A narrow closed drawer may independently remain inert; main must be restored.
		assert.equal(
			await read(
				"window.__hipiGuiSettingsOpener.main === document.querySelector('.main-shell') && document.querySelector('.main-shell').inert === window.__hipiGuiSettingsOpener.mainInert",
			),
			true,
		);
		const navigation = await read(
			"({reveal:window.__hipiGuiSettingsOpener.reveal,...window.__hipiGuiSettingsOpener.navigation})",
		);
		if (navigation.reveal) {
			if (navigation.narrow) await pressKey(cdp, "Escape");
			else await click(cdp, ".sidebar-collapse");
			await until(
				() =>
					read(
						`document.querySelector('.work-shell').dataset.${navigation.narrow ? "navigationOpen" : "navigationCollapsed"} === '${navigation.narrow ? "false" : "true"}' && document.activeElement === document.querySelector('.navigation-toggle')`,
					),
				"Settings restores the navigation state it opened",
			);
		}
	};
	const close = async (trigger) => {
		assert.equal(
			await read(
				`!!window.__hipiGuiSettingsOpener?.node?.isConnected && (${JSON.stringify(trigger ?? null)} === null || window.__hipiGuiSettingsOpener.selector === ${JSON.stringify(trigger ?? null)})`,
			),
			true,
			"Settings Close must use the recorded original opener",
		);
		await click(cdp, '.settings-modal [data-slot="dialog-close"]');
		await closed();
	};
	const choice = async (field = "theme") => {
		assert.ok(["theme", "language"].includes(field), "Unknown appearance field");
		return until(
			() => read(`(${settingsChoice.toString()})(document, ${JSON.stringify(field)})`),
			"canonical Settings choice",
		);
	};
	const setChoice = async (field, value) => {
		assert.ok(["theme", "language"].includes(field), "Unknown appearance field");
		assert.ok(
			(field === "theme" ? ["system", "light", "dark"] : ["en", "zh-CN"]).includes(value),
			"Settings choices require canonical values",
		);
		await navigate(field === "language" ? "general" : "appearance");
		const before = await choice(field);
		if (before.mode === value) return;
		if (field === "theme") {
			await click(cdp, `${themeSelector}[value="${value}"]`);
		} else {
			await click(cdp, languageSelector);
			await click(cdp, '[role="option"]', value === "en" ? "English" : "简体中文");
			await until(
				() =>
					read(
						`!document.querySelector('[role="option"]') && document.activeElement === document.querySelector(${JSON.stringify(languageSelector)})`,
					),
				"language select restores its exact combobox",
			);
		}
		await until(async () => {
			const current = await choice(field);
			const persisted = await saved();
			return current.mode === value && persisted?.[field === "theme" ? "mode" : "locale"] === value;
		}, "Settings choice persists immediately without Save");
		if (field === "theme")
			await until(
				() =>
					read(
						`document.documentElement.dataset.theme === (${JSON.stringify(value)} === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : ${JSON.stringify(value)})`,
					),
				"theme choice applies immediately",
			);
	};
	const preferences = async (locale, mode) => {
		await open(".sidebar-settings-trigger", "general");
		await setChoice("language", locale);
		await setChoice("theme", mode);
		await close(".sidebar-settings-trigger");
	};
	const geometry = async () => {
		const state = await read(`(${settingsModalGeometry.toString()})(document, {width:innerWidth,height:innerHeight})`);
		assertSettingsModalGeometry(state);
		return state;
	};
	const replaceText = async (selector, value) => {
		await click(cdp, selector);
		await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
		await nativeEditorKey(cdp, "Backspace");
		await cdp.request("Input.insertText", { text: value });
		assert.equal(await read(`document.querySelector(${JSON.stringify(selector)})?.value`), value);
	};
	const search = async (query, target, category) => {
		assert.ok(categories.includes(category), "Unknown Settings search category");
		await replaceText(".settings-search-input", query);
		await click(cdp, `.settings-search-result[data-setting=${JSON.stringify(target)}]`);
		const state = await until(async () => {
			const destination = await read(`(() => {
					const route = document.querySelector(${JSON.stringify(routeSelector)});
					const nodes = [...(route?.querySelectorAll('.settings-page-content [data-setting]') ?? [])].filter(e => e.dataset.setting === ${JSON.stringify(target)});
					const node = nodes[0];
					let detailsOpen = true;
					for (let parent = node; parent && parent !== route; parent = parent.parentElement)
						if (parent.tagName === 'DETAILS' && !parent.open) detailsOpen = false;
					return { open: !!route, category: route?.querySelector('.settings-page-nav [aria-current="page"]')?.dataset.category,
						query: route?.querySelector('.settings-search-input')?.value, count: nodes.length,
						focused: !!node?.contains(document.activeElement), visible: !!node?.getClientRects().length,
						detailsOpen, dialogs: document.querySelectorAll('[role="dialog"]').length };
				})()`);
			return destination.open &&
				destination.category === category &&
				destination.query === "" &&
				destination.count === 1 &&
				destination.focused &&
				destination.visible &&
				destination.detailsOpen &&
				destination.dialogs === 1
				? destination
				: null;
		}, "Settings search destination");
		assertSettingsDestination(state, category);
		return state;
	};
	const top = async () => {
		const point = await read(`(() => {
			const body = document.querySelector('.settings-page-content'), r = body?.getBoundingClientRect();
			if (!body || !r) return null;
			for (const x of [r.x + 4, r.x + r.width - 4]) {
				const y = r.y + r.height / 2;
				if (body.contains(document.elementFromPoint(x,y))) return {x,y};
			}
			return null;
		})()`);
		assert.ok(point, "Settings content needs an unobstructed native wheel target");
		await until(async () => {
			if (await read(`document.querySelector('.settings-page-content').scrollTop <= 1`)) return true;
			await cdp.request("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				...point,
				deltaX: 0,
				deltaY: -4000,
			});
			return false;
		}, "Settings scrolls to the top through native wheel input");
	};
	const inspect = async (directory, prefix = "settings") => {
		const original = { locale: (await choice("language")).locale, mode: (await choice()).mode };
		const opener = await read("window.__hipiGuiSettingsOpener.selector");
		const screenshots = {};
		await navigate("general");
		await top();
		const generalGeometry = await geometry();
		await capture(cdp, directory, `${prefix}-general`);
		screenshots.general = `${prefix}-general.png`;
		await click(cdp, languageSelector);
		await pressKey(cdp, "Escape");
		await until(
			() =>
				read(
					`!document.querySelector('[role="option"]') && document.activeElement === document.querySelector(${JSON.stringify(languageSelector)})`,
				),
			"nested language Escape restores its combobox",
		);
		assert.equal(
			await read(
				"window.__hipiGuiSettingsSurface === document.querySelector('.settings-modal') && document.querySelectorAll('[role=\"dialog\"]').length === 1",
			),
			true,
			"Language Escape must retain its exact parent Settings dialog",
		);
		await setChoice("language", original.locale === "en" ? "zh-CN" : "en");
		await close(opener);
		await open(opener, "general");
		assert.notEqual((await choice("language")).locale, original.locale, "Language must survive modal reopen");
		await setChoice("language", original.locale);
		const changedMode = original.mode === "dark" ? "light" : "dark";
		await setChoice("theme", changedMode);
		await close(opener);
		await open(opener);
		assert.equal((await choice()).mode, changedMode, "Theme must survive modal reopen");
		await setChoice("theme", original.mode);
		await top();
		const appearanceGeometry = await geometry();
		await capture(cdp, directory, `${prefix}-appearance`);
		screenshots.appearance = `${prefix}-appearance.png`;
		const fontQuery = original.locale === "en" ? "UI font size" : "界面字号";
		await replaceText(".settings-search-input", fontQuery);
		await until(
			() => read(`!!document.querySelector('.settings-search-result[data-setting="uiFontSize"]')`),
			"native Settings search results",
		);
		await pressKey(cdp, "Escape");
		assert.equal(
			await read(
				`!!document.querySelector(${JSON.stringify(routeSelector)}) && document.querySelector('.settings-search-input')?.value === '' && document.activeElement === document.querySelector('.settings-search-input')`,
			),
			true,
			"Search Escape clears its query without closing Settings",
		);
		await pressKey(cdp, "Escape");
		await closed();
		await open(opener);
		const destination = await search(fontQuery, "uiFontSize", "appearance");
		const initial = await saved();
		const fontSizes = {};
		for (const [field, commit] of [
			["uiFontSize", "blur"],
			["codeFontSize", "Enter"],
		]) {
			const selector = `.settings-page-content [data-setting="${field}"] input`;
			const before = initial[field];
			const next = before === 15 ? 14 : 15;
			await replaceText(selector, String(next));
			assert.equal((await saved())[field], before, "Uncommitted font text must not persist");
			if (commit === "blur") await click(cdp, ".settings-search-input");
			else await nativeEditorKey(cdp, "Enter");
			await until(
				async () =>
					(await saved())[field] === next &&
					(await read(
						`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(field === "uiFontSize" ? "--font-ui-size" : "--font-code-size")}).trim()`,
					)) === `${next}px`,
				"font size commit persists and applies",
			);
			fontSizes[field] = { before, next, commit };
		}
		await capture(cdp, directory, `${prefix}-advanced`);
		screenshots.advanced = `${prefix}-advanced.png`;
		await close(opener);
		await open(opener);
		await search(fontQuery, "uiFontSize", "appearance");
		for (const [field, { before, next }] of Object.entries(fontSizes)) {
			const selector = `.settings-page-content [data-setting="${field}"] input`;
			assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), String(next));
			assert.equal((await saved())[field], next, "Committed font size must survive modal reopen");
			await replaceText(selector, String(before));
			await nativeEditorKey(cdp, "Enter");
			await until(async () => (await saved())[field] === before, "restore original font size");
		}
		await click(cdp, ".settings-advanced > summary");
		await top();
		const beforeImport = await saved();
		await click(cdp, '.settings-page-content button[data-setting="transfer"]');
		await until(
			() => read(`!!document.querySelector('.settings-import-dialog[role="dialog"]')`),
			"theme import alone opens a modal",
		);
		await capture(cdp, directory, `${prefix}-import`);
		screenshots.import = `${prefix}-import.png`;
		await click(cdp, ".settings-import-actions button", original.locale === "en" ? "Cancel" : "取消");
		await until(
			() =>
				read(
					`!document.querySelector('.settings-import-dialog') && window.__hipiGuiSettingsSurface === document.querySelector('.settings-modal') && document.querySelectorAll('[role="dialog"]').length === 1 && document.activeElement === document.querySelector('.settings-page-content button[data-setting="transfer"]')`,
				),
			"cancel-only import restores its exact trigger",
		);
		assert.deepEqual(await saved(), beforeImport, "Cancelling empty import must not change appearance");
		assert.equal((await choice()).mode, original.mode);
		assert.equal((await choice("language")).locale, original.locale);
		await top();
		return {
			generalGeometry,
			appearanceGeometry,
			searchDestination: destination,
			fontSizes,
			screenshots,
			initialSearchFocus: true,
			categoryHeadingFocus: true,
			exactCloseFocus: true,
			languageSelectEscapeFocus: true,
			immediateLanguagePersistence: true,
			immediateThemePersistence: true,
			fontBlurAndEnterPersistence: true,
			fontModalReopenPersistence: true,
			searchEscapeClearsOnly: true,
			emptySearchEscapeCloses: true,
			importCancelledWithoutChanges: true,
		};
	};
	return { open, close, choice, setChoice, preferences, geometry, search, inspect };
}
