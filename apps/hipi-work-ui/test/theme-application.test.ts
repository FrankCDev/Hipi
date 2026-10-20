import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { applyTheme, themeVariables } from "../src/app/theme/application.ts";
import { contrastRatio, defaultAppearance, defaultConfig, fonts } from "../src/app/theme/config.ts";

function target() {
	const properties = new Map<string, string>();
	return {
		properties,
		lang: "en",
		dataset: {} as Record<string, string | undefined>,
		style: {
			getPropertyValue: (key: string) => properties.get(key) ?? "",
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
}
function preference(matches: boolean) {
	const listeners = new Set<() => void>();
	return {
		matches,
		listeners,
		addEventListener(_type: "change", callback: () => void) {
			listeners.add(callback);
		},
		removeEventListener(_type: "change", callback: () => void) {
			listeners.delete(callback);
		},
		change(value: boolean) {
			this.matches = value;
			for (const callback of listeners) callback();
		},
	};
}
test("system theme and motion track their own media preferences, cleanup releases subscriptions and overrides", () => {
	const root = target();
	const media = preference(true);
	const motion = preference(false);
	const cleanup = applyTheme(
		{ ...defaultConfig(), regions: { messages: { foreground: "#ffffff", background: "#000000" } } },
		root,
		media,
		motion,
	);
	assert.equal(root.dataset.theme, "dark");
	assert.equal(root.dataset.reducedMotion, "off");
	assert.equal(root.lang, "zh-CN");
	assert.equal(root.dataset.messagesColors, "custom");
	assert.equal(root.properties.get("--font-ui-size"), "14px");
	assert.equal(root.properties.get("--font-code-size"), "12px");
	media.change(false);
	motion.change(true);
	assert.equal(root.dataset.theme, "light");
	assert.equal(root.dataset.reducedMotion, "on");
	cleanup();
	assert.equal(media.listeners.size, 0);
	assert.equal(motion.listeners.size, 0);
	assert.equal(root.properties.size, 0);
	assert.equal(root.lang, "en");
	assert.equal(root.dataset.messagesColors, undefined);
	assert.equal(root.dataset.reducedMotion, undefined);
});
test("explicit appearance and motion do not subscribe and do not change with OS preferences", () => {
	for (const reducedMotion of ["on", "off"] as const) {
		const root = target();
		const media = preference(false);
		const motion = preference(reducedMotion === "off");
		const cleanup = applyTheme({ ...defaultConfig(), mode: "dark", reducedMotion }, root, media, motion);
		assert.equal(media.listeners.size, 0);
		assert.equal(motion.listeners.size, 0);
		media.change(true);
		motion.change(reducedMotion === "on");
		assert.equal(root.dataset.theme, "dark");
		assert.equal(root.dataset.reducedMotion, reducedMotion);
		cleanup();
	}
	const root = target();
	const cleanup = applyTheme(defaultConfig(), root);
	assert.equal(root.dataset.theme, "light");
	assert.equal(root.dataset.reducedMotion, "off");
	cleanup();
});
test("system mode switches custom palettes and removes stale custom values when the other variant is default", () => {
	const root = target();
	const media = preference(false);
	const light = { accent: "#1144bb", foreground: "#182020", background: "#f2ffff" };
	const cleanup = applyTheme({ ...defaultConfig(), appearance: { light } }, root, media);
	assert.equal(root.properties.get("--surface"), light.background);
	assert.equal(root.properties.get("--text"), light.foreground);
	media.change(true);
	assert.equal(root.properties.get("--surface"), undefined);
	assert.equal(root.properties.get("--text"), undefined);
	assert.equal(root.properties.get("--font-ui-size"), "14px");
	media.change(false);
	assert.equal(root.properties.get("--surface"), light.background);
	cleanup();
	assert.equal(root.properties.size, 0);
});
test("cleanup restores prior inline values, datasets and language rather than deleting another owner's state", () => {
	const root = target();
	root.properties.set("--surface", "#abcdef");
	root.properties.set("--font-ui", "original font");
	root.properties.set("--unrelated", "keep me");
	root.dataset.theme = "existing";
	root.dataset.reducedMotion = "on";
	root.dataset.sidebarColors = "existing";
	const cleanup = applyTheme({ ...defaultConfig(), appearance: { light: defaultAppearance("light") } }, root);
	cleanup();
	assert.deepEqual(Object.fromEntries(root.properties), {
		"--surface": "#abcdef",
		"--font-ui": "original font",
		"--unrelated": "keep me",
	});
	assert.deepEqual(root.dataset, { theme: "existing", reducedMotion: "on", sidebarColors: "existing" });
	assert.equal(root.lang, "en");
});
test("global custom family inherits into regions unless an explicit region font is configured", () => {
	const variables = themeVariables({
		...defaultConfig(),
		uiFont: "serif",
		customUiFont: "思源宋体",
		customCodeFont: "JetBrains Mono",
		uiFontSize: 15.5,
		codeFontSize: 17.25,
		regions: { sidebar: { font: "mono" } },
	});
	assert.equal(variables["--font-ui"], `"思源宋体", ${fonts.serif}`);
	assert.equal(variables["--sidebar-font"], fonts.mono);
	assert.equal(variables["--messages-font"], variables["--font-ui"]);
	assert.equal(variables["--editor-font"], `"JetBrains Mono", ${fonts.mono}`);
	assert.equal(variables["--font-code-size"], "17.25px");
	assert.equal(variables["--font-ui-size"], "15.5px");
	for (const value of Object.values(fonts)) assert.match(value, /(?:sans-serif|serif|monospace)$/);
});
test("content fonts inherit UI by default, select independently and yield to retained region overrides", () => {
	const inherited = themeVariables({ ...defaultConfig(), uiFont: "serif", customUiFont: "Noto Serif SC" });
	assert.equal(inherited["--font-content"], inherited["--font-ui"]);
	assert.equal(inherited["--messages-font"], inherited["--font-content"]);
	const selected = themeVariables({
		...defaultConfig(),
		contentFont: "serif",
		customContentFont: "思源宋体",
	});
	assert.equal(selected["--font-content"], `"思源宋体", ${fonts.serif}`);
	assert.equal(selected["--messages-font"], selected["--font-content"]);
	assert.equal(selected["--sidebar-font"], fonts.system);
	assert.equal(selected["--editor-font"], fonts.mono);
	const overridden = themeVariables({
		...defaultConfig(),
		contentFont: "serif",
		customContentFont: "思源宋体",
		regions: { messages: { font: "mono" } },
	});
	assert.equal(overridden["--font-content"], `"思源宋体", ${fonts.serif}`);
	assert.equal(overridden["--messages-font"], fonts.mono);
});
test("derived custom surfaces, muted text, focus and action labels preserve contrast including threshold pairs", () => {
	for (const mode of ["light", "dark"] as const) {
		for (const colors of [
			defaultAppearance(mode),
			{ accent: "#ffffff", foreground: "#767676", background: "#ffffff" },
			{ accent: "#000000", foreground: "#777777", background: "#000000" },
			{ accent: "#ff00ff", foreground: "#ffffff", background: "#431245" },
		]) {
			const variables = themeVariables({ ...defaultConfig(), mode, appearance: { [mode]: colors } });
			for (const background of [
				"surface",
				"canvas",
				"sidebar",
				"raised",
				"brand-soft",
				"disabled-surface",
				"warning-soft",
			]) {
				for (const foreground of ["text", "muted", "accent-text", "disabled-text", "warning", "danger"]) {
					assert.ok(
						contrastRatio(variables[`--${foreground}`] ?? "", variables[`--${background}`] ?? "") >= 4.5,
						`${mode}: ${foreground}/${background}`,
					);
				}
				assert.ok(contrastRatio(variables["--focus"] ?? "", variables[`--${background}`] ?? "") >= 3);
			}
			for (const action of ["brand", "danger"]) {
				for (const background of [action, `${action}-hover`])
					assert.ok(contrastRatio(variables[`--on-${action}`] ?? "", variables[`--${background}`] ?? "") >= 4.5);
			}
		}
	}
});
test("preset normal text and focus token contrast guard (not a visual or keyboard acceptance test)", () => {
	const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
	for (const selector of [":root", ':root[data-theme="dark"]']) {
		const block = css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
		const tokens = Object.fromEntries(
			[...block.matchAll(/--([\w-]+): (#[\da-f]{6}(?:[\da-f]{2})?);/g)].map((match) => [match[1], match[2]]),
		);
		const backgrounds = ["surface", "canvas", "sidebar", "raised"].map((name) => ({
			name,
			value: tokens[name] ?? "",
		}));
		const brandSoft = tokens["brand-soft"] ?? "";
		if (brandSoft.length === 9) {
			const alpha = Number.parseInt(brandSoft.slice(7), 16) / 255;
			for (const background of backgrounds.slice()) {
				const value = `#${[1, 3, 5]
					.map((offset) => {
						const overlay = Number.parseInt(brandSoft.slice(offset, offset + 2), 16);
						const base = Number.parseInt(background.value.slice(offset, offset + 2), 16);
						return Math.round(overlay * alpha + base * (1 - alpha))
							.toString(16)
							.padStart(2, "0");
					})
					.join("")}`;
				backgrounds.push({ name: `brand-soft on ${background.name}`, value });
			}
		} else backgrounds.push({ name: "brand-soft", value: brandSoft });
		for (const background of backgrounds) {
			for (const foreground of ["text", "muted"])
				assert.ok(
					contrastRatio(tokens[foreground] ?? "", background.value) >= 4.5,
					`${selector}: ${foreground}/${background.name}`,
				);
			assert.ok(contrastRatio(tokens.focus ?? "", background.value) >= 3, `${selector}: focus/${background.name}`);
		}
	}
});
