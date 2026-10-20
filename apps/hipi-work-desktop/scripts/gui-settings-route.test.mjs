import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	assertSettingsDestination,
	assertSettingsModalGeometry,
	createSettingsHarness,
	settingsChoice,
	settingsModalGeometry,
} from "./gui-settings-route.mjs";

const routeSelector = ".settings-modal";
const languageSelector = `${routeSelector} [data-setting="language"] [role="combobox"]`;
const themeSelector = `${routeSelector} input[name="appearance-theme"]`;

function geometryFixture() {
	const rectangles = {
		route: { x: 50, y: 40, width: 900, height: 720 },
		close: { x: 900, y: 55, width: 32, height: 32 },
		dialogTitle: { x: 70, y: 55, width: 180, height: 27 },
		title: { x: 310, y: 100, width: 300, height: 40 },
		body: { x: 300, y: 90, width: 650, height: 650 },
		search: { x: 70, y: 120, width: 220, height: 32 },
	};
	const nodes = Object.fromEntries(
		Object.entries(rectangles).map(([name, rect]) => [
			name,
			{
				getBoundingClientRect: () => rect,
				getClientRects: () => [rect],
				contains: () => true,
				getAttribute: (attribute) =>
					name === "route"
						? attribute === "role"
							? "dialog"
							: attribute === "data-slot"
								? "dialog-content"
								: null
						: null,
				scrollWidth: rect.width,
				clientWidth: rect.width,
				clientHeight: rect.height,
				scrollHeight: 1200,
				scrollTop: 0,
			},
		]),
	);
	const bySelector = {
		[routeSelector]: nodes.route,
		[`${routeSelector} [data-slot="dialog-close"]`]: nodes.close,
		[`${routeSelector} [data-slot="dialog-title"]`]: nodes.dialogTitle,
		[`${routeSelector} .settings-page-heading`]: nodes.title,
		[`${routeSelector} .settings-page-content`]: nodes.body,
		[`${routeSelector} .settings-search-input`]: nodes.search,
	};
	const document = {
		documentElement: { scrollWidth: 1000 },
		querySelectorAll: (selector) =>
			selector === '[data-slot="dialog-overlay"]' ? [{}] : bySelector[selector] ? [bySelector[selector]] : [],
		querySelector: (selector) => bySelector[selector] ?? null,
		elementFromPoint: () => ({}),
	};
	return { document, nodes, rectangles };
}

test("modal geometry requires centered bounded surface, Close, heading, search and dim overlay", () => {
	const { document, nodes } = geometryFixture();
	const state = settingsModalGeometry(document, { width: 1000, height: 800 });
	assert.doesNotThrow(() => assertSettingsModalGeometry(state));
	assert.equal(state.scrollHeight, 1200);
	nodes.route.getAttribute = () => null;
	assert.throws(() => assertSettingsModalGeometry(settingsModalGeometry(document, state)), /modal dialog semantics/);
});

test("modal geometry rejects covered, offscreen, ambiguous, modal and horizontally overflowing layouts", () => {
	const fixture = geometryFixture();
	const valid = settingsModalGeometry(fixture.document, { width: 1000, height: 800 });
	for (const [field, value] of Object.entries({
		modal: false,
		overlay: false,
		legacyControls: true,
		scrollWidth: 1200,
		bodyScrollWidth: 1000,
	})) {
		assert.throws(() => assertSettingsModalGeometry({ ...valid, [field]: value }));
	}
	for (const name of ["route", "close", "dialogTitle", "title", "body", "search"]) {
		for (const change of [{ hit: false }, { visible: false }, { y: -50 }, { width: 0 }, { disabled: true }]) {
			assert.throws(() =>
				assertSettingsModalGeometry({
					...valid,
					regions: { ...valid.regions, [name]: { ...valid.regions[name], ...change } },
				}),
			);
		}
		assert.throws(() => assertSettingsModalGeometry({ ...valid, regions: { ...valid.regions, [name]: null } }));
	}
	assert.throws(() =>
		assertSettingsModalGeometry({
			...valid,
			regions: { ...valid.regions, route: { ...valid.regions.route, width: 700 } },
		}),
	);
});

test("canonical choices require exact radio values and the General language control, not arbitrary labels", () => {
	const radios = ["system", "light", "dark"].map((value) => ({ value, checked: value === "system" }));
	const language = { textContent: "English" };
	const route = {
		querySelectorAll: (selector) => (selector === 'input[name="appearance-theme"]' ? radios : [language]),
	};
	const document = {
		documentElement: { lang: "en" },
		querySelectorAll: () => [route],
	};
	assert.equal(settingsChoice(document, "theme").mode, "system");
	assert.equal(settingsChoice(document, "language").locale, "en");
	assert.equal(settingsChoice(document, "language").selector, languageSelector);
	language.textContent = "简体中文";
	assert.equal(settingsChoice(document, "language"), null);
	document.documentElement.lang = "zh-CN";
	assert.equal(settingsChoice(document, "language").locale, "zh-CN");
	radios[1].checked = true;
	assert.equal(settingsChoice(document, "theme"), null);
	radios[1].checked = false;
	radios[2].value = "system";
	assert.equal(settingsChoice(document, "theme"), null);
	assert.equal(settingsChoice(document, "unknown"), null);
	document.querySelectorAll = () => [route, route];
	assert.equal(settingsChoice(document, "language"), null);
});

test("search destination assertions reject hidden advanced content, lost focus, query and parent-modal regressions", () => {
	const valid = {
		open: true,
		category: "appearance",
		query: "",
		count: 1,
		focused: true,
		visible: true,
		detailsOpen: true,
		dialogs: 1,
	};
	assert.doesNotThrow(() => assertSettingsDestination(valid, "appearance"));
	for (const [field, value] of Object.entries({
		open: false,
		category: "general",
		query: "font",
		count: 2,
		focused: false,
		visible: false,
		detailsOpen: false,
		dialogs: 2,
	})) {
		assert.throws(() => assertSettingsDestination({ ...valid, [field]: value }, "appearance"));
	}
});

// This renderer model verifies harness contracts only. It is not native Electron acceptance evidence.
function renderer({
	persist = true,
	persistFontCommits = true,
	commitOnInput = false,
	restoreExact = true,
	initialSearchFocus = true,
	importChanges = false,
	narrow = false,
	collapsed = false,
	hideOwner = false,
	replaceOwner = false,
} = {}) {
	const events = [];
	const screenshots = [];
	const preferences = { locale: "en", mode: "system", uiFontSize: 14, codeFontSize: 13 };
	let stored = { ...preferences };
	let open = false;
	let category = "general";
	let selecting = false;
	let importing = false;
	let advancedOpen = false;
	const window = {};
	const { document, nodes } = geometryFixture();
	const sidebar = { isConnected: true, inert: false };
	const main = { isConnected: true, inert: false };
	const shell = {
		dataset: {
			navigationMode: narrow ? "narrow" : "desktop",
			navigationOpen: "false",
			navigationCollapsed: String(collapsed),
		},
	};
	const navigationToggle = {};
	const opener = { isConnected: true, disabled: false, getClientRects: () => [{}] };
	const search = { value: "", getClientRects: () => [{}] };
	const heading = {};
	const transfer = {};
	const language = {
		get textContent() {
			return preferences.locale === "en" ? "English" : "简体中文";
		},
	};
	const advanced = {
		tagName: "DETAILS",
		get open() {
			return advancedOpen;
		},
	};
	const controls = Object.fromEntries(
		["uiFontSize", "codeFontSize"].map((field) => [
			field,
			{ field, value: String(preferences[field]), getClientRects: () => (advancedOpen ? [{}] : []) },
		]),
	);
	const rows = Object.fromEntries(
		Object.entries(controls).map(([field, control]) => {
			const row = {
				dataset: { setting: field },
				parentElement: advanced,
				contains: (node) => node === control,
				getClientRects: () => (advancedOpen ? [{}] : []),
			};
			control.parentElement = row;
			return [field, row];
		}),
	);
	const radios = ["system", "light", "dark"].map((value) => ({
		value,
		get checked() {
			return preferences.mode === value;
		},
	}));
	const route = {
		...nodes.route,
		querySelector: (selector) => document.querySelector(selector),
		querySelectorAll: (selector) =>
			selector === 'input[name="appearance-theme"]'
				? radios
				: selector === '[data-setting="language"] [role="combobox"]'
					? [language]
					: selector === ".settings-page-content [data-setting]"
						? Object.values(rows)
						: [],
	};
	// React-backed DOM nodes can contain cycles and cannot be returned with CDP returnByValue.
	route.rendererOwner = route;
	advanced.parentElement = route;
	const geometryNodes = {
		[`${routeSelector} [data-slot="dialog-close"]`]: nodes.close,
		[`${routeSelector} [data-slot="dialog-title"]`]: nodes.dialogTitle,
		[`${routeSelector} .settings-page-heading`]: nodes.title,
		[`${routeSelector} .settings-page-content`]: nodes.body,
		[`${routeSelector} .settings-search-input`]: nodes.search,
	};
	document.documentElement = {
		scrollWidth: 1000,
		get lang() {
			return preferences.locale;
		},
		get dataset() {
			return { theme: preferences.mode === "system" ? "light" : preferences.mode };
		},
	};
	document.querySelector = (selector) => {
		if (selector === ".sidebar") return sidebar;
		if (selector === ".main-shell") return replaceOwner && open ? { ...main } : main;
		if (selector === ".work-shell") return shell;
		if (selector === ".navigation-toggle") return navigationToggle;
		if (selector === '[data-slot="dialog-overlay"]') return open ? {} : null;
		if (selector === routeSelector) return open ? route : null;
		if (selector === ".sidebar-settings-trigger" || selector === ".sidebar-settings-trigger") return opener;
		if (selector === ".settings-search-input") return open ? search : null;
		if (selector === ".settings-page-heading") return heading;
		if (selector === ".settings-page-content") return nodes.body;
		if (selector === '.settings-page-nav [aria-current="page"]') return { dataset: { category } };
		if (selector === languageSelector) return language;
		if (selector === '[role="option"]') return selecting ? {} : null;
		if (selector === ".settings-import-dialog" || selector === '.settings-import-dialog[role="dialog"]')
			return importing ? {} : null;
		if (selector === '[role="dialog"]' || selector === '[role="dialog"],[role="menu"],[role="option"]')
			return importing || selecting ? {} : null;
		if (selector === '.settings-page-content button[data-setting="transfer"]') return transfer;
		if (selector.startsWith(".settings-search-result[")) return search.value ? {} : null;
		const field = selector.match(/^\.settings-page-content \[data-setting="(uiFontSize|codeFontSize)"\] input$/)?.[1];
		if (field) return controls[field];
		return geometryNodes[selector] ?? null;
	};
	document.querySelectorAll = (selector) => {
		if (selector === '[role="dialog"]') return [...(open ? [route] : []), ...(importing ? [{}] : [])];
		if (selector === routeSelector) return open ? [route] : [];
		const node = document.querySelector(selector);
		return node ? [node] : [];
	};
	const commit = () => {
		const active = document.activeElement;
		if (active?.field) {
			preferences[active.field] = Number(active.value);
			if (persist && persistFontCommits) stored = { ...preferences };
		}
	};
	const context = {
		document,
		window,
		innerWidth: 1000,
		innerHeight: 800,
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: (callback) => callback(),
		getComputedStyle: () => ({
			visibility: hideOwner && open ? "hidden" : "visible",
			opacity: "1",
			getPropertyValue: (property) => `${preferences[property === "--font-ui-size" ? "uiFontSize" : "codeFontSize"]}px`,
		}),
		localStorage: { getItem: () => JSON.stringify(stored) },
	};
	const helpers = {
		evaluate: async (_cdp, expression) => {
			const result = await runInNewContext(expression, context);
			if (result !== undefined) JSON.stringify(result);
			return result;
		},
		until: async (check, label) => {
			for (let i = 0; i < 4; i++) {
				const result = await check();
				if (result) return result;
			}
			throw new Error(`Timed out: ${label}`);
		},
		click: async (_cdp, selector, text) => {
			events.push({ kind: "click", selector, text });
			commit();
			if (selector === ".navigation-toggle") {
				shell.dataset.navigationOpen = narrow ? "true" : "false";
				shell.dataset.navigationCollapsed = "false";
				sidebar.inert = false;
				main.inert = narrow;
			} else if (selector === ".sidebar-collapse") {
				shell.dataset.navigationCollapsed = "true";
				sidebar.inert = true;
				document.activeElement = navigationToggle;
			} else if (selector.endsWith("settings-trigger")) {
				open = true;
				sidebar.inert = main.inert = true;
				advancedOpen = false;
				for (const [field, control] of Object.entries(controls)) control.value = String(preferences[field]);
				document.activeElement = initialSearchFocus ? search : heading;
			} else if (selector === '.settings-modal [data-slot="dialog-close"]') {
				open = false;
				sidebar.inert = false;
				main.inert = shell.dataset.navigationOpen === "true";
				document.activeElement = restoreExact ? opener : { ...opener };
			} else if (selector.startsWith(".settings-page-nav")) {
				category = selector.match(/data-category="([^"]+)"/)[1];
				document.activeElement = heading;
			} else if (selector === languageSelector) {
				selecting = true;
				document.activeElement = language;
			} else if (selector === '[role="option"]') {
				preferences.locale = text === "English" ? "en" : "zh-CN";
				if (persist) stored = { ...preferences };
				selecting = false;
				document.activeElement = language;
			} else if (selector.startsWith(themeSelector)) {
				preferences.mode = selector.match(/value="([^"]+)"/)[1];
				if (persist) stored = { ...preferences };
			} else if (selector.startsWith(".settings-search-result[")) {
				category = "appearance";
				search.value = "";
				advancedOpen = true;
				document.activeElement = controls.uiFontSize;
			} else if (selector === ".settings-advanced > summary") {
				advancedOpen = !advancedOpen;
				document.activeElement = advanced;
			} else if (selector === '.settings-page-content button[data-setting="transfer"]') {
				importing = true;
				document.activeElement = {};
			} else if (selector === ".settings-import-actions button") {
				assert.equal(text, preferences.locale === "en" ? "Cancel" : "取消");
				importing = false;
				if (importChanges) stored = { ...stored, mode: "dark" };
				document.activeElement = transfer;
			} else {
				document.activeElement = document.querySelector(selector);
				assert.ok(document.activeElement, `Unknown click target: ${selector}`);
			}
		},
		nativeEditorKey: async (_cdp, key, options) => {
			events.push({ kind: "key", key, options });
			if (key === "Backspace") document.activeElement.value = "";
			if (key === "Enter") commit();
		},
		pressKey: async (_cdp, key) => {
			assert.equal(key, "Escape");
			events.push({ kind: "escape" });
			if (selecting) selecting = false;
			else if (document.activeElement === search && search.value) search.value = "";
			else if (!open && shell.dataset.navigationOpen === "true") {
				shell.dataset.navigationOpen = "false";
				sidebar.inert = true;
				main.inert = false;
				document.activeElement = navigationToggle;
			} else {
				open = false;
				sidebar.inert = main.inert = false;
				document.activeElement = restoreExact ? opener : { ...opener };
			}
		},
		capture: async (_cdp, _directory, name) => {
			screenshots.push(name);
		},
	};
	const cdp = {
		request: async (method, params) => {
			assert.equal(method, "Input.insertText", "Harness may only use native text input outside injected helpers");
			events.push({ kind: "insertText", text: params.text });
			document.activeElement.value = params.text;
			if (commitOnInput) commit();
		},
	};
	return { harness: createSettingsHarness(cdp, helpers), events, screenshots, preferences, context, document };
}

test("open and Close require initial search focus and exact opener identity, not a replacement matching its selector", async () => {
	const valid = renderer();
	await valid.harness.open();
	await valid.harness.close(".sidebar-settings-trigger");
	assert.equal(valid.events.at(-1).selector, '.settings-modal [data-slot="dialog-close"]');
	const replacement = renderer({ restoreExact: false });
	await replacement.harness.open();
	await assert.rejects(replacement.harness.close(), /exact opener/);
	const wrongFocus = renderer({ initialSearchFocus: false });
	await assert.rejects(wrongFocus.harness.open(), /initial search focus/);
	const wrongTrigger = renderer();
	await wrongTrigger.harness.open();
	await assert.rejects(wrongTrigger.harness.close(".different-settings-trigger"), /recorded original opener/);
});

test("modal capture retains the actual cyclic DOM node without returning it through CDP", async () => {
	const fixture = renderer();
	await fixture.harness.open();
	const surface = fixture.document.querySelector(".settings-modal");
	assert.equal(fixture.context.window.__hipiGuiSettingsSurface, surface);
	assert.throws(() => JSON.stringify(surface), /circular/i);
	await fixture.harness.close();
	assert.equal(fixture.context.window.__hipiGuiSettingsSurface, surface);
});

test("sidebar-only Settings opens through narrow/collapsed navigation then restores it after exact modal focus return", async () => {
	for (const options of [{ narrow: true }, { collapsed: true }]) {
		const fixture = renderer(options);
		await fixture.harness.open();
		await fixture.harness.close();
		assert.equal(fixture.events[0].selector, ".navigation-toggle");
		assert.equal(fixture.document.activeElement, fixture.document.querySelector(".navigation-toggle"));
		assert.equal(fixture.document.querySelector(".work-shell").dataset.navigationOpen, "false");
		assert.equal(
			fixture.document.querySelector(".work-shell").dataset.navigationCollapsed,
			String(!!options.collapsed),
		);
	}
});

test("opening Settings rejects hidden or remounted retained application owners", async () => {
	for (const options of [{ hideOwner: true }, { replaceOwner: true }])
		await assert.rejects(renderer(options).harness.open(), /retain visible application owners/);
});

test("canonical language and radio mutations require immediate persistence and apply through native helpers", async () => {
	const fixture = renderer();
	await fixture.harness.preferences("zh-CN", "dark");
	assert.equal(fixture.preferences.locale, "zh-CN");
	assert.equal(fixture.preferences.mode, "dark");
	assert.ok(fixture.events.some((event) => event.selector === `${themeSelector}[value="dark"]`));
	assert.ok(fixture.events.some((event) => event.selector === '[role="option"]' && event.text === "简体中文"));
	const unsaved = renderer({ persist: false });
	await unsaved.harness.open();
	await assert.rejects(unsaved.harness.setChoice("theme", "dark"), /persists immediately/);
	await assert.rejects(fixture.harness.setChoice("theme", "Dark"), /canonical values/);
});

test("inspection exercises native search, font blur/Enter and reopen, import cancellation, and restores preferences", async () => {
	const fixture = renderer();
	await fixture.harness.open(".sidebar-settings-trigger");
	const initial = { ...fixture.preferences };
	const result = await fixture.harness.inspect("/not-used", "settings-native");
	assert.deepEqual(fixture.preferences, initial);
	assert.deepEqual(fixture.screenshots, [
		"settings-native-general",
		"settings-native-appearance",
		"settings-native-advanced",
		"settings-native-import",
	]);
	assert.equal(result.fontSizes.uiFontSize.commit, "blur");
	assert.equal(result.fontSizes.codeFontSize.commit, "Enter");
	assert.equal(result.searchDestination.focused, true);
	assert.equal(result.importCancelledWithoutChanges, true);
	assert.equal((await fixture.harness.choice()).mode, "system");
	assert.ok(fixture.events.filter((event) => event.kind === "insertText").length >= 6);
	assert.ok(fixture.events.some((event) => event.kind === "key" && event.key === "a"));
	assert.ok(fixture.events.some((event) => event.kind === "key" && event.key === "Backspace"));
	assert.ok(fixture.events.some((event) => event.kind === "key" && event.key === "Enter"));
	assert.equal(fixture.events.filter((event) => event.selector === ".settings-import-actions button").length, 1);
	assert.ok(
		fixture.events.every(
			(event) => !event.selector || !/copyTheme|credential|savebar|unsaved-dialog/.test(event.selector),
		),
		"Settings inspection must not mutate clipboard, credentials, or obsolete Save/Cancel controls",
	);
});

test("font inspection rejects eager draft persistence and non-persisted commits", async () => {
	for (const [options, error] of [
		[{ commitOnInput: true }, /Uncommitted font text must not persist/],
		[{ persistFontCommits: false }, /font size commit persists and applies/],
	]) {
		const fixture = renderer(options);
		await fixture.harness.open();
		await assert.rejects(fixture.harness.inspect("/not-used"), error);
	}
});

test("import cancellation must preserve the complete saved appearance, not just the selected radio", async () => {
	const fixture = renderer({ importChanges: true });
	await fixture.harness.open();
	await assert.rejects(fixture.harness.inspect("/not-used"), /Cancelling empty import must not change appearance/);
});
