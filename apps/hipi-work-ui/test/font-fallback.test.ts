import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { themeVariables } from "../src/app/theme/application.ts";
import { defaultConfig, fonts } from "../src/app/theme/config.ts";

test("CJK fallback precedes generics without changing Latin preference order", () => {
	const originalLatin = {
		system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif',
		serif: 'Georgia, "Noto Serif SC", "Songti SC", SimSun, serif',
		mono: '"SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace',
	};
	for (const name of ["system", "serif", "mono"] as const) {
		const stack = fonts[name];
		assert.equal(stack.split('"Hipi Noto Sans SC"').length, 2);
		assert.equal(stack.replace('"Hipi Noto Sans SC", ', ""), originalLatin[name]);
		const families = stack.split(",").map((family) => family.trim());
		const fallback = families.indexOf('"Hipi Noto Sans SC"');
		const generic =
			/^(system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|sans-serif|serif|monospace|cursive|fantasy|math)$/;
		assert.ok(fallback < families.findIndex((family) => generic.test(family)));
		assert.equal(fallback === 0, name === "system");
	}
	const variables = themeVariables({
		...defaultConfig(),
		uiFont: "serif",
		codeFont: "mono",
		regions: { messages: { font: "mono" }, sidebar: { font: "system" } },
	});
	assert.equal(variables["--font-ui"], fonts.serif);
	assert.equal(variables["--font-code"], fonts.mono);
	assert.equal(variables["--editor-font"], fonts.mono);
	assert.equal(variables["--messages-font"], fonts.mono);
	assert.equal(variables["--sidebar-font"], fonts.system);
});
test("local-only face matches CJK and punctuation, keeping Latin mono and serif choices", () => {
	const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
	const face = css.match(/@font-face\s*\{([^}]+)\}/)?.[1] ?? "";
	assert.match(face, /font-family: "Hipi Noto Sans SC"/);
	assert.match(face, /font-weight: 100 900/);
	assert.match(face, /url\("\/assets\/hipi-noto-sc-aef8c342\.woff2"\)/);
	assert.doesNotMatch(face, /https?:|local\(/);
	const ranges =
		face
			.match(/unicode-range:\s*([^;]+)/)?.[1]
			.split(",")
			.map((value) => {
				const [first, last = first] = value.trim().slice(2).split("-");
				return [Number.parseInt(first, 16), Number.parseInt(last, 16)];
			}) ?? [];
	const matches = (point: number) => ranges.some(([first, last]) => first <= point && point <= last);
	for (const point of [0x20, 0x41, 0x7e, 0xe9]) assert.equal(matches(point), false);
	for (const character of "中文，。龜") assert.equal(matches(character.codePointAt(0) ?? 0), true);
	const defaultStack = css.match(/--font-ui:([^;]+);/)?.[1] ?? "";
	assert.ok(defaultStack.indexOf('"Hipi Noto Sans SC"') < defaultStack.indexOf("sans-serif"));
	assert.match(defaultStack, /"Microsoft YaHei", "Hipi Noto Sans SC",\s*sans-serif/);
	assert.match(css, /--font-code:[^;]*"Hipi Noto Sans SC", monospace;/);
});
