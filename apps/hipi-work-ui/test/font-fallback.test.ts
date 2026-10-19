import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { themeVariables } from "../src/app/theme/application.ts";
import { defaultConfig, fonts } from "../src/app/theme/config.ts";

test("theme and regional choices precede one CJK fallback", () => {
	for (const stack of Object.values(fonts)) {
		assert.equal(stack.split('"Hipi Noto Sans SC"').length, 2);
		assert.match(stack, /"Hipi Noto Sans SC", (sans-serif|serif|monospace)$/);
		assert.ok(stack.indexOf('"Hipi Noto Sans SC"') > 0);
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
	assert.match(css, /--font-code:[^;]*"Hipi Noto Sans SC", monospace;/);
});
