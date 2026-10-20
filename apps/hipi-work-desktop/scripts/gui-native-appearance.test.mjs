import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	assertNativeBackdrop,
	backgroundAlpha,
	inspectNativeAppearance,
	nativeAppearanceSnapshot,
} from "./gui-native-appearance.mjs";

const familySelector = '[data-setting="uiFont"] .settings-font-control > [role="combobox"]:first-of-type';
const styleSelector = '[data-setting="uiFont"] .settings-font-control > [role="combobox"]:nth-of-type(2)';
const switchSelector = '[data-setting="translucentSidebar"] [role="switch"]';
const regular = { family: "Arial", fullName: "Arial Regular", postscriptName: "ArialMT", style: "Regular" };
const bold = { family: "Arial", fullName: "Arial Bold", postscriptName: "Arial-BoldMT", style: "Bold" };

// A synthetic renderer proves harness branching and cleanup only, never native acceptance.
function renderer({
	backdrop = "vibrancy",
	reduced = false,
	fontError = false,
	failCapture = false,
	persistStyle = true,
	retainOwner = true,
	loadFace = true,
} = {}) {
	const original = { locale: "en", mode: "light", uiFont: "system", localFontFaces: {}, translucentSidebar: false };
	let preferences = structuredClone(original);
	let routeOpen = true;
	let menu;
	let catalogOpened = false;
	let catalogLoaded = false;
	let failedCapture = false;
	const events = [];
	const screenshots = [];
	const expressions = [];
	const owner = {
		isConnected: true,
		querySelector: () => ({ value: "保留草稿 / retained draft" }),
		querySelectorAll: () => [{ dataset: { messageId: "owned-message" } }],
	};
	const document = { activeElement: null };
	const node = (name) => ({ name, getClientRects: () => [{}] });
	const root = {
		...node("root"),
		get dataset() {
			return { nativeBackdrop: enabled() ? "on" : "off" };
		},
	};
	const family = {
		...node("family"),
		get textContent() {
			return preferences.localFontFaces.ui?.family ?? "System";
		},
	};
	const style = {
		...node("style"),
		get textContent() {
			return preferences.localFontFaces.ui?.style;
		},
	};
	const toggle = {
		...node("toggle"),
		get checked() {
			return preferences.translucentSidebar;
		},
		disabled: reduced,
		closest: () => ({ querySelector: () => (reduced ? { textContent: "System reduced transparency." } : null) }),
	};
	const catalog = {
		get dataset() {
			return {
				fontCatalogState: catalogOpened ? (fontError ? "error" : "ready") : "idle",
				...(catalogOpened && !fontError ? { fontFamilyCount: "2" } : {}),
				...(fontError ? { fontError: "DENIED" } : {}),
			};
		},
	};
	const nodes = {
		html: root,
		body: node("body"),
		"#root": node("app"),
		".settings-modal": node("route"),
		".settings-page-sidebar": node("settingsSidebar"),
		".settings-page-main": node("settingsMain"),
		".sidebar": node("sidebar"),
		".main-shell": node("main"),
	};
	const enabled = () => backdrop !== "unsupported" && !reduced && preferences.translucentSidebar;
	document.documentElement = root;
	Object.defineProperty(document, "fonts", {
		get: () =>
			Object.assign(
				preferences.localFontFaces.ui && loadFace
					? [{ family: `Hipi local ${preferences.localFontFaces.ui.postscriptName}`, status: "loaded" }]
					: [],
				{ ready: Promise.resolve() },
			),
	});
	document.querySelector = (selector) => {
		if (selector === familySelector) return routeOpen ? family : null;
		if (selector === styleSelector) return routeOpen && preferences.localFontFaces.ui ? style : null;
		if (selector === switchSelector) return routeOpen && backdrop !== "unsupported" ? toggle : null;
		if (selector === "[data-font-catalog-state]") return routeOpen ? catalog : null;
		if (selector === '[role="option"]') return menu ? {} : null;
		if (selector === ".conversation-panel") return retainOwner || routeOpen ? owner : { ...owner };
		if (selector.startsWith(".settings-") && !routeOpen) return null;
		return nodes[selector] ?? null;
	};
	document.querySelectorAll = (selector) => {
		assert.equal(selector, '[role="option"]');
		return (
			menu === "family"
				? ["System", "Serif", "Monospace", "Custom font", "Arial", "Other Font"]
				: menu === "style"
					? ["Regular", "Bold"]
					: []
		).map((textContent) => ({ textContent }));
	};
	const getComputedStyle = (element) => ({
		backgroundColor:
			enabled() && ["root", "body", "app"].includes(element.name)
				? "rgba(0, 0, 0, 0)"
				: enabled() && ["sidebar"].includes(element.name)
					? "color(srgb 1 1 1 / 0.95)"
					: "rgb(255, 255, 255)",
		fontFamily: preferences.localFontFaces.ui
			? `"Hipi local ${preferences.localFontFaces.ui.postscriptName}", system-ui`
			: "system-ui",
		visibility: "visible",
		opacity: "1",
		getPropertyValue: (property) =>
			property === "--font-ui"
				? preferences.localFontFaces.ui
					? `"Hipi local ${preferences.localFontFaces.ui.postscriptName}", system-ui`
					: "system-ui"
				: "95%",
	});
	const context = {
		document,
		getComputedStyle,
		location: { href: "hipi-work://app/index.html" },
		localStorage: { getItem: () => JSON.stringify(preferences) },
		requestAnimationFrame: (callback) => callback(),
		window: {
			__hipiGuiSettingsOpener: { selector: ".sidebar-settings-trigger" },
			hipiWorkAppearance: {
				fontsSupported: true,
				listFonts: () => {
					throw new Error("Harness must not invoke enumeration outside UI");
				},
				request: (request) => {
					assert.deepEqual(JSON.parse(JSON.stringify(request)), { version: 1, method: "status" });
					events.push("read-native-status");
					return Promise.resolve({
						ok: true,
						result: {
							version: 1,
							platform: backdrop === "unsupported" ? "linux" : "macos",
							backdrop,
							reducedTransparency: reduced,
							backdropEnabled: enabled(),
							fontSmoothing: true,
						},
					});
				},
			},
		},
	};
	const helpers = {
		evaluate: async (_cdp, expression) => {
			expressions.push(expression);
			return runInNewContext(expression, context);
		},
		until: async (check, label) => {
			for (let index = 0; index < 4; index++) {
				const value = await check();
				if (value) return value;
			}
			throw new Error(`Timed out: ${label}`);
		},
		click: async (_cdp, selector, label) => {
			events.push({ selector, label });
			if (selector === familySelector) {
				menu = "family";
				catalogOpened = true;
				if (!catalogLoaded) events.push("ui-native-enumeration");
				catalogLoaded = true;
				document.activeElement = family;
			} else if (selector === styleSelector) {
				menu = "style";
				document.activeElement = style;
			} else if (selector === '[role="option"]') {
				if (menu === "family") {
					if (label === "System") preferences.localFontFaces = {};
					else {
						assert.equal(label, "Arial");
						preferences.localFontFaces = { ui: { ...regular } };
					}
					document.activeElement = family;
				} else {
					assert.equal(menu, "style");
					assert.equal(label, "Bold");
					if (persistStyle) preferences.localFontFaces = { ui: { ...bold } };
					document.activeElement = style;
				}
				menu = undefined;
			} else if (selector === switchSelector) {
				assert.notEqual(backdrop, "unsupported");
				assert.equal(reduced, false);
				preferences = { ...preferences, translucentSidebar: !preferences.translucentSidebar };
			} else assert.fail(`Unexpected native input: ${selector}`);
		},
		pressKey: async (_cdp, key) => {
			assert.equal(key, "Escape");
			menu = undefined;
			document.activeElement = family;
			events.push("escape");
		},
		capture: async (_cdp, _directory, name) => {
			if (failCapture && name.endsWith("font-applied") && !failedCapture) {
				failedCapture = true;
				throw new Error("Owned screenshot failed");
			}
			screenshots.push(name);
		},
	};
	const route = {
		close: async (opener) => {
			assert.equal(opener, ".sidebar-settings-trigger");
			assert.equal(menu, undefined);
			routeOpen = false;
			events.push("close-exact-opener");
		},
		open: async (opener, category) => {
			assert.equal(opener, ".sidebar-settings-trigger");
			assert.equal(category, "appearance");
			routeOpen = true;
			catalogOpened = false;
			events.push("reopen");
		},
	};
	return {
		helpers,
		route,
		events,
		screenshots,
		expressions,
		context,
		get preferences() {
			return preferences;
		},
		original,
		run: () => inspectNativeAppearance({}, helpers, route, "/unused", "appearance"),
	};
}

test("native appearance uses the picker, returned family/style, modal persistence, backdrop and complete UI restoration", async () => {
	const fixture = renderer();
	const evidence = await fixture.run();
	assert.deepEqual(JSON.parse(JSON.stringify(evidence.font.selected)), bold);
	assert.equal(evidence.font.changedStyle, true);
	assert.equal(evidence.font.familyCount, 2);
	assert.equal(evidence.font.modalReopenPersisted, true);
	assert.equal(evidence.originalPreferencesRestored, true);
	assert.deepEqual(fixture.preferences, fixture.original);
	assert.deepEqual(
		evidence.backdrop.states.map((state) => state.requested),
		[true, false],
	);
	assert.equal(fixture.events.filter((event) => event === "ui-native-enumeration").length, 1);
	assert.ok(fixture.events.filter((event) => event === "close-exact-opener").length >= 4);
	assert.ok(fixture.screenshots.includes("appearance-font-styles"));
	assert.ok(fixture.screenshots.includes("appearance-backdrop-on-workbench"));
	assert.ok(evidence.limits.some((limit) => limit.includes("not proof of OS compositor")));
	assert.ok(
		fixture.expressions.every(
			(expression) =>
				!/\blistFonts\s*\(|queryLocalFonts\s*\(|setItem|dispatchEvent|\.click\(|setBackdrop|\.style\s*=/.test(
					expression,
				),
		),
	);
	assert.ok(fixture.events.every((event) => typeof event === "string" || !event.selector.includes("installedFonts")));
	assert.equal(fixture.context.window.__hipiGuiAppearanceOwner, undefined);
});

test("unsupported and reduced-transparency hosts preserve truthful opaque fallback without toggling OS preferences", async () => {
	for (const options of [{ backdrop: "unsupported" }, { reduced: true }]) {
		const fixture = renderer(options);
		const evidence = await fixture.run();
		assert.equal(evidence.backdrop.states.length, 1);
		assert.equal(evidence.backdrop.states[0].status.backdropEnabled, false);
		assert.ok(!fixture.events.some((event) => event.selector === switchSelector));
		assert.deepEqual(fixture.preferences, fixture.original);
	}
});

test("font failures, unloaded faces, lost conversation identity and persistence regressions fail closed and restore preferences", async () => {
	for (const [options, error] of [
		[{ fontError: true }, /enumeration failed: DENIED/],
		[{ persistStyle: false }, /font style persists/],
		[{ loadFace: false }, /rather than silently falling back/],
		[{ failCapture: true }, /Owned screenshot failed/],
		[{ retainOwner: false }, /acceptance and restoration failed/],
	]) {
		const fixture = renderer(options);
		await assert.rejects(fixture.run(), error);
		assert.deepEqual(fixture.preferences, fixture.original);
		assert.ok(fixture.events.every((event) => typeof event === "string" || !event.selector.includes("installedFonts")));
	}
});

test("custom profiles are refused before any UI mutation", async () => {
	const fixture = renderer();
	fixture.preferences.customUiFont = "Private font";
	await assert.rejects(fixture.run(), /synthetic journey requires/);
	assert.deepEqual(fixture.events, []);
});

test("surface collector records bounded local registrations and fixed computed surfaces, not font catalog or conversation text", () => {
	const fixture = renderer();
	const state = nativeAppearanceSnapshot(fixture.context.document, fixture.context.getComputedStyle);
	assert.equal(state.surfaces.settingsSidebar.background, "rgb(255, 255, 255)");
	assert.equal(state.catalog.state, "idle");
	assert.ok(!JSON.stringify(state).includes("retained draft"));
	assert.equal(Object.keys(state.surfaces).length, 8);
});

test("background alpha accepts Chromium computed CSS colors, including percentage alpha", () => {
	for (const [color, alpha] of [
		["transparent", 0],
		["#ffffff", 1],
		["rgb(255, 255, 255)", 1],
		["rgba(0, 0, 0, 0)", 0],
		["color(srgb 0.9 0.9 0.9 / 0.95)", 0.95],
		["rgb(255 255 255 / 95%)", 0.95],
	])
		assert.equal(backgroundAlpha(color), alpha);
	assert.ok(Number.isNaN(backgroundAlpha("unknown")));
});

test("native confirmation alone cannot pass opaque, hidden-owner, unsupported or accessibility regressions", async () => {
	const evidence = await renderer().run();
	const on = evidence.backdrop.states[0];
	const copy = () => JSON.parse(JSON.stringify(on.settings));
	assert.doesNotThrow(() => assertNativeBackdrop(on.settings, on.status, true));
	for (const name of ["root", "body", "app"]) {
		const state = copy();
		state.surfaces[name].background = "rgb(255, 255, 255)";
		assert.throws(() => assertNativeBackdrop(state, on.status, true));
	}
	for (const name of ["route", "settingsSidebar", "settingsMain"]) {
		const state = copy();
		state.surfaces[name].background = "rgba(0, 0, 0, 0)";
		assert.throws(() => assertNativeBackdrop(state, on.status, true), /must stay opaque/);
	}
	const owner = copy();
	owner.surfaces.main.visibility = "hidden";
	assert.throws(() => assertNativeBackdrop(owner, on.status, true), /remain visible behind Settings/);
	assert.throws(
		() => assertNativeBackdrop(copy(), { ...on.status, backdropEnabled: false }, true),
		/Host must confirm/,
	);
	assert.throws(() => assertNativeBackdrop(copy(), { ...on.status, platform: "web" }, true), /native host/);
	const off = evidence.backdrop.states[1];
	assert.throws(
		() => assertNativeBackdrop(off.settings, { ...off.status, backdrop: "unsupported" }, false),
		/actionable switch/,
	);
	assert.throws(
		() => assertNativeBackdrop(off.settings, { ...off.status, reducedTransparency: true }, false),
		/reduced transparency/,
	);
});
