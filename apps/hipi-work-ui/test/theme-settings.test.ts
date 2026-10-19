import assert from "node:assert/strict";
import { test } from "node:test";
import { contrastRatio, defaultConfig, parseConfig, validateConfig } from "../src/app/theme/config.ts";
import { ThemeStore, themeStorageKey } from "../src/app/theme/store.ts";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
}
test("versioned settings persist on save, preview cancels without touching saved bytes", () => {
	const storage = memoryStorage();
	const store = new ThemeStore(storage);
	const custom = {
		...defaultConfig(),
		locale: "en",
		mode: "dark",
		regions: { messages: { foreground: "#FFFFFF", background: "#202020", font: "serif" } },
	};
	assert.equal(store.setPreview(custom).ok, true);
	assert.equal(storage.getItem(themeStorageKey), null);
	store.cancel();
	assert.deepEqual(store.current, defaultConfig());
	store.setPreview(custom);
	assert.equal(store.save(), "available");
	assert.deepEqual(new ThemeStore(storage).current, custom);
	store.setPreview(defaultConfig());
	store.cancel();
	assert.deepEqual(store.current, custom);
});
test("invalid originals survive fallback, save and restart for lossless export", () => {
	const storage = memoryStorage();
	const original = '{"version":900,"future":"keep me"}';
	storage.setItem(themeStorageKey, original);
	const store = new ThemeStore(storage);
	assert.equal(store.status, "invalid");
	assert.deepEqual(store.current, defaultConfig());
	assert.equal(storage.getItem(themeStorageKey), original);
	store.save();
	assert.equal(new ThemeStore(storage).rejectedOriginal, original);
	assert.equal(parseConfig(store.export()).ok, true);
});
test("denied and quota-exhausted storage degrade to usable memory without losing original", () => {
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
	store.setPreview({ ...defaultConfig(), locale: "en" });
	assert.equal(store.save(), "memory");
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
});
test("strict boundary rejects executable content, unknown keys, unknown versions, incomplete colors and low contrast", () => {
	for (const value of [
		null,
		[],
		{ ...defaultConfig(), version: 2 },
		{ ...defaultConfig(), css: "body{}" },
		{ ...defaultConfig(), uiFont: "url(https://example.com)" },
		{ ...defaultConfig(), regions: { sidebar: { background: "#ffffff" } } },
		{ ...defaultConfig(), regions: { editor: { foreground: "#eeeeee", background: "#ffffff" } } },
		{ ...defaultConfig(), regions: { bad: {} } },
	]) {
		assert.equal(validateConfig(value).ok, false);
	}
	assert.equal(parseConfig("x".repeat(16385)).ok, false);
	assert.equal(parseConfig('{"__proto__":{},"version":1}').ok, false);
	assert.equal(contrastRatio("#000000", "#ffffff"), 21);
	assert.equal(
		validateConfig({ ...defaultConfig(), regions: { sidebar: { foreground: "#000000", background: "#ffffff" } } }).ok,
		true,
	);
});
test("caller mutation cannot bypass validation or alter saved state", () => {
	const store = new ThemeStore();
	const config = defaultConfig();
	store.setPreview(config);
	config.mode = "dark";
	assert.equal(store.current.mode, "system");
	const copy = store.current;
	copy.locale = "en";
	assert.equal(store.current.locale, "zh-CN");
});
