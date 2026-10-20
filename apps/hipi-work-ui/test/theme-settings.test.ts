import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import {
	contrastRatio,
	defaultAppearance,
	defaultConfig,
	exportAppearanceShare,
	fontSizeBounds,
	parseAppearanceShare,
	parseConfig,
	validateConfig,
} from "../src/app/theme/config.ts";
import { ThemeProvider, useThemeSettings } from "../src/app/theme/provider.tsx";
import {
	previousThemeStorageKey,
	rejectedThemeStorageKey,
	ThemeStore,
	themeStorageKey,
} from "../src/app/theme/store.ts";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
}
const legacy = {
	version: 1,
	locale: "en",
	mode: "dark",
	uiFont: "serif",
	codeFont: "mono",
	regions: {
		messages: { foreground: "#FFFFFF", background: "#202020", font: "serif" },
		sidebar: { font: "mono" },
	},
};
test("v1 migrates all preferences and regions without writing until an explicit update", () => {
	const storage = memoryStorage();
	const original = JSON.stringify(legacy, null, 2);
	storage.setItem(themeStorageKey, original);
	const store = new ThemeStore(storage);
	assert.deepEqual(store.current, { ...defaultConfig(), ...legacy, version: 2 });
	assert.equal(storage.getItem(themeStorageKey), original);
	assert.equal(store.status, "available");
	const result = store.update({ ...store.current, codeFontSize: 16 });
	assert.equal(result.ok, true);
	assert.ok(result.ok && result.status === "available");
	assert.equal(storage.getItem(previousThemeStorageKey), original);
	assert.equal(new ThemeStore(storage).current.codeFontSize, 16);
	assert.deepEqual(new ThemeStore(storage).current.regions, legacy.regions);
	const restarted = new ThemeStore(storage);
	assert.equal(restarted.update({ ...restarted.current, uiFontSize: 15 }).ok, true);
	assert.equal(storage.getItem(previousThemeStorageKey), original);
});
test("a failed migration backup leaves the saved v1 bytes untouched and reports memory-only", () => {
	const storage = memoryStorage();
	const original = JSON.stringify(legacy);
	storage.setItem(themeStorageKey, original);
	const store = new ThemeStore({
		getItem: storage.getItem,
		setItem(key, value) {
			if (key === previousThemeStorageKey) throw new Error("quota");
			storage.setItem(key, value);
		},
	});
	const result = store.update({ ...store.current, mode: "light" });
	assert.ok(result.ok && result.status === "memory");
	assert.equal(store.current.mode, "light");
	assert.equal(storage.getItem(themeStorageKey), original);
	assert.deepEqual(parseConfig(store.export()), { ok: true, value: store.current });
});
test("valid edits persist immediately, invalid edits change neither current nor stored configuration", () => {
	const storage = memoryStorage();
	const store = new ThemeStore(storage);
	const config = {
		...defaultConfig(),
		uiFontSize: 15.5,
		codeFontSize: 16.25,
		customUiFont: "Noto Sans SC",
		reducedMotion: "on",
		appearance: { light: defaultAppearance("light") },
	};
	const result = store.update(config);
	assert.ok(result.ok && result.status === "available");
	assert.deepEqual(JSON.parse(storage.getItem(themeStorageKey) ?? ""), config);
	assert.deepEqual(new ThemeStore(storage).current, config);
	const bytes = storage.getItem(themeStorageKey);
	assert.deepEqual(store.update({ ...config, codeFontSize: -1 }), { ok: false, error: "format" });
	assert.equal(storage.getItem(themeStorageKey), bytes);
	assert.deepEqual(store.current, config);
});
test("legacy preview can cancel without overwriting persisted settings; direct update clears preview", () => {
	const storage = memoryStorage();
	const store = new ThemeStore(storage);
	assert.equal(store.setPreview(legacy).ok, true);
	assert.equal(storage.getItem(themeStorageKey), null);
	store.cancel();
	assert.deepEqual(store.current, defaultConfig());
	store.setPreview(legacy);
	assert.equal(store.save(), "available");
	store.setPreview(defaultConfig());
	store.cancel();
	assert.deepEqual(store.current.regions, legacy.regions);
	store.setPreview({ ...store.current, mode: "light" });
	store.update({ ...defaultConfig(), mode: "dark" });
	store.cancel();
	assert.equal(store.current.mode, "dark");
});
test("invalid originals survive fallback, update and restart for lossless recovery export", () => {
	const storage = memoryStorage();
	const original = '{"version":900,"future":"keep me"}';
	storage.setItem(themeStorageKey, original);
	const store = new ThemeStore(storage);
	assert.equal(store.status, "invalid");
	assert.deepEqual(store.current, defaultConfig());
	assert.equal(storage.getItem(themeStorageKey), original);
	store.update(defaultConfig());
	assert.equal(storage.getItem(rejectedThemeStorageKey), original);
	assert.equal(new ThemeStore(storage).rejectedOriginal, original);
	assert.equal(parseConfig(store.export()).ok, true);
});
test("denied and quota-exhausted storage preserve originals and report usable memory-only edits", () => {
	const denied = {
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("denied");
		},
	};
	const store = new ThemeStore(denied);
	assert.equal(store.status, "memory");
	const result = store.update({ ...defaultConfig(), locale: "en" });
	assert.ok(result.ok && result.status === "memory");
	assert.equal(store.current.locale, "en");
	assert.equal(parseConfig(store.export()).ok, true);
	const storage = memoryStorage();
	storage.setItem(themeStorageKey, "broken");
	const quota = new ThemeStore({
		getItem: storage.getItem,
		setItem() {
			throw new Error("quota");
		},
	});
	assert.equal(quota.save(), "memory");
	assert.equal(storage.getItem(themeStorageKey), "broken");
	assert.equal(quota.rejectedOriginal, "broken");
});
test("strict versioned boundary rejects unknown fields, incomplete colors, low contrast and invalid sizes", () => {
	for (const value of [
		null,
		[],
		{ ...defaultConfig(), version: 3 },
		{ ...defaultConfig(), css: "body{}" },
		{ ...defaultConfig(), uiFont: "url(https://example.com)" },
		{ ...defaultConfig(), contentFont: "url(https://example.com)" },
		{ ...defaultConfig(), contentFont: undefined },
		{ ...defaultConfig(), regions: { sidebar: { background: "#ffffff" } } },
		{ ...defaultConfig(), regions: { editor: { foreground: "#eeeeee", background: "#ffffff" } } },
		{ ...defaultConfig(), regions: { bad: {} } },
		{ ...legacy, css: "keep unsupported settings instead of dropping them" },
		{ ...defaultConfig(), appearance: { light: { foreground: "#000000", background: "#ffffff" } } },
		{ ...defaultConfig(), appearance: { dark: { accent: "red", foreground: "#ffffff", background: "#000000" } } },
		{ ...defaultConfig(), appearance: { light: { accent: "#000000", foreground: "#eeeeee", background: "#ffffff" } } },
		{ ...defaultConfig(), appearance: { other: defaultAppearance("light") } },
		{ ...defaultConfig(), reducedMotion: true },
		{ ...defaultConfig(), uiFontSize: undefined },
	]) {
		assert.equal(validateConfig(value).ok, false, JSON.stringify(value));
	}
	assert.equal(parseConfig("x".repeat(16385)).ok, false);
	assert.equal(parseConfig('{"__proto__":{},"version":1}').ok, false);
	assert.equal(contrastRatio("#000000", "#ffffff"), 21);
	assert.equal(contrastRatio("not a color", "#ffffff"), 0);
});
test("UI and code sizes use distinct supported ranges, accept finite fractional values and retain step-one controls", () => {
	assert.deepEqual(fontSizeBounds, {
		ui: { min: 11, max: 16, step: 1 },
		code: { min: 8, max: 24, step: 1 },
	});
	assert.equal(defaultConfig().uiFontSize, 14);
	assert.equal(defaultConfig().codeFontSize, 12);
	for (const [field, bounds] of [
		["uiFontSize", fontSizeBounds.ui],
		["codeFontSize", fontSizeBounds.code],
	] as const) {
		for (const size of [bounds.min, bounds.max, bounds.min + 0.125, bounds.max - 0.5]) {
			assert.equal(validateConfig({ ...defaultConfig(), [field]: size }).ok, true);
		}
		for (const size of [
			bounds.min - 0.01,
			bounds.max + 0.01,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"14",
			null,
		]) {
			assert.equal(validateConfig({ ...defaultConfig(), [field]: size }).ok, false);
		}
	}
});
test("font families permit installed names but never CSS stacks, escapes, declarations, URLs or control characters", () => {
	for (const family of [
		"Noto Sans CJK SC",
		"思源黑体",
		"M+ 1m",
		"Arial-Narrow",
		"IBM Plex Mono",
		"Segoe UI Variable",
	]) {
		assert.equal(validateConfig({ ...defaultConfig(), customUiFont: family, customCodeFont: family }).ok, true);
		assert.equal(validateConfig({ ...defaultConfig(), customContentFont: family }).ok, true);
	}
	for (const family of [
		"",
		"A".repeat(81),
		'Arial",sans-serif; color:red',
		"Arial, serif",
		"url(https://example.com/font)",
		"var(--font)",
		"Arial\\22",
		"Arial\ncolor:red",
		"Arial\u0000",
		"/*font*/",
		"<script>",
	]) {
		assert.equal(validateConfig({ ...defaultConfig(), customUiFont: family }).ok, false, family);
		assert.equal(validateConfig({ ...defaultConfig(), customCodeFont: family }).ok, false, family);
		assert.equal(validateConfig({ ...defaultConfig(), customContentFont: family }).ok, false, family);
	}
});
test("inherited fields, hidden unsupported fields and property getters do not bypass the data boundary", () => {
	assert.equal(validateConfig(Object.create(defaultConfig())).ok, false);
	const hidden = { ...defaultConfig() };
	Object.defineProperty(hidden, "css", { value: "body{}", enumerable: false });
	assert.equal(validateConfig(hidden).ok, false);
	let getterCalls = 0;
	const accessor = { ...defaultConfig() };
	Object.defineProperty(accessor, "uiFont", {
		get() {
			getterCalls++;
			return "system";
		},
	});
	assert.equal(validateConfig(accessor).ok, false);
	assert.equal(getterCalls, 0);
});
test("share strings round-trip Unicode and legacy regions, reject raw JSON and validate decoded payloads", () => {
	const migrated = validateConfig(legacy);
	assert.ok(migrated.ok);
	const config = { ...migrated.value, customUiFont: "思源黑体" };
	const share = exportAppearanceShare(config);
	assert.match(share, /^hipi-theme:[A-Za-z0-9_-]+$/);
	assert.deepEqual(parseAppearanceShare(`\n${share}\n`), { ok: true, value: config });
	for (const value of ["", JSON.stringify(config), "hipi-theme:", "hipi-theme:!", "hipi-theme:_w", "x".repeat(22001)]) {
		assert.equal(parseAppearanceShare(value).ok, false);
	}
	const malicious = `hipi-theme:${btoa(JSON.stringify({ ...defaultConfig(), customUiFont: "url(font)" })).replace(/=+$/, "")}`;
	assert.equal(parseAppearanceShare(malicious).ok, false);
	assert.throws(() => exportAppearanceShare({ ...defaultConfig(), uiFontSize: -1 }), TypeError);
});
test("caller mutation cannot bypass validation or alter saved state and result snapshots", () => {
	const store = new ThemeStore();
	const config = { ...defaultConfig(), appearance: { light: defaultAppearance("light") } };
	const result = store.update(config);
	config.mode = "dark";
	config.appearance.light.foreground = "#ffffff";
	assert.equal(store.current.mode, "system");
	assert.equal(store.current.appearance.light?.foreground, "#1a1c1f");
	assert.ok(result.ok);
	result.value.locale = "en";
	const copy = store.current;
	copy.locale = "en";
	assert.equal(store.current.locale, "zh-CN");
});
test("provider update reports validation and storage outcomes and exports the committed share string", () => {
	for (const persistent of [true, false]) {
		const storage = memoryStorage();
		vi.stubGlobal("window", {
			get localStorage() {
				if (!persistent) throw new Error("denied");
				return storage;
			},
		});
		try {
			let controller: ReturnType<typeof useThemeSettings> | undefined;
			function Probe() {
				controller = useThemeSettings();
				return null;
			}
			renderToStaticMarkup(createElement(ThemeProvider, null, createElement(Probe)));
			assert.ok(controller);
			const next = { ...defaultConfig(), uiFontSize: 15.5 };
			const result = controller.update(next);
			assert.deepEqual(result, { ok: true, value: next, status: persistent ? "available" : "memory" });
			assert.deepEqual(parseAppearanceShare(controller.export()), { ok: true, value: next });
			assert.deepEqual(controller.update({ ...next, uiFontSize: -1 }), { ok: false, error: "format" });
			assert.deepEqual(parseAppearanceShare(controller.export()), { ok: true, value: next });
			if (persistent) assert.deepEqual(JSON.parse(storage.getItem(themeStorageKey) ?? ""), next);
		} finally {
			vi.unstubAllGlobals();
		}
	}
});
