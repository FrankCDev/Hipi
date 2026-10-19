import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyTheme, themeVariables } from "../src/app/theme/application.ts";
import { contrastRatio, defaultConfig, fonts } from "../src/app/theme/config.ts";

test("system updates track OS changes and release media listener plus regional overrides on cancel", () => {
	const properties = new Map<string, string>();
	const root = {
		lang: "en",
		dataset: {} as Record<string, string | undefined>,
		style: {
			setProperty(key: string, value: string | null) {
				properties.set(key, value ?? "");
			},
			removeProperty(key: string) {
				const previous = properties.get(key) ?? "";
				properties.delete(key);
				return previous;
			},
		},
	};
	const listeners = new Set<() => void>();
	const media = {
		matches: true,
		addEventListener(_type: "change", callback: () => void) {
			listeners.add(callback);
		},
		removeEventListener(_type: "change", callback: () => void) {
			listeners.delete(callback);
		},
	};
	const cleanup = applyTheme(
		{ ...defaultConfig(), regions: { messages: { foreground: "#ffffff", background: "#000000" } } },
		root,
		media,
	);
	assert.equal(root.dataset.theme, "dark");
	assert.equal(root.lang, "zh-CN");
	assert.equal(root.dataset.messagesColors, "custom");
	media.matches = false;
	for (const callback of listeners) callback();
	assert.equal(root.dataset.theme, "light");
	cleanup();
	assert.equal(listeners.size, 0);
	assert.equal(properties.size, 0);
	assert.equal(root.lang, "en");
	assert.equal(root.dataset.messagesColors, undefined);
	const explicit = applyTheme({ ...defaultConfig(), mode: "dark" }, root, media);
	assert.equal(root.dataset.theme, "dark");
	for (const callback of listeners) callback();
	assert.equal(root.dataset.theme, "dark");
	explicit();
});
test("region font wins over global font; editor defaults to code font; all choices have cross-platform fallbacks", () => {
	const variables = themeVariables({ ...defaultConfig(), uiFont: "serif", regions: { sidebar: { font: "mono" } } });
	assert.equal(variables["--sidebar-font"], fonts.mono);
	assert.equal(variables["--messages-font"], fonts.serif);
	assert.equal(variables["--editor-font"], fonts.mono);
	for (const value of Object.values(fonts)) assert.match(value, /(?:sans-serif|serif|monospace)$/);
});
test("preset normal text and focus token contrast guard (not a visual or keyboard acceptance test)", () => {
	const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
	for (const selector of [":root", ':root[data-theme="dark"]']) {
		const block = css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
		const tokens = Object.fromEntries(
			[...block.matchAll(/--([\w-]+): (#[\da-f]{6});/g)].map((match) => [match[1], match[2]]),
		);
		for (const background of ["surface", "canvas", "sidebar", "raised", "brand-soft"]) {
			for (const foreground of ["text", "muted"])
				assert.ok(
					contrastRatio(tokens[foreground] ?? "", tokens[background] ?? "") >= 4.5,
					`${selector}: ${foreground}/${background}`,
				);
			assert.ok(contrastRatio(tokens.focus ?? "", tokens[background] ?? "") >= 3, `${selector}: focus/${background}`);
		}
	}
});
