import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { themeVariables } from "../src/app/theme/application.ts";
import { defaultConfig, fonts } from "../src/app/theme/config.ts";

test("platform UI and code faces precede the licensed CJK fallback and terminal generic", () => {
	const platformStacks = {
		system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
		serif: 'Georgia, "Noto Serif SC", "Songti SC", SimSun, serif',
		mono: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
	};
	for (const name of ["system", "serif", "mono"] as const) {
		const stack = fonts[name];
		assert.equal(stack.split('"Hipi Noto Sans SC"').length, 2);
		assert.equal(stack.replace('"Hipi Noto Sans SC", ', ""), platformStacks[name]);
		const families = stack.split(",").map((family) => family.trim());
		const fallback = families.indexOf('"Hipi Noto Sans SC"');
		assert.equal(fallback, families.length - 2);
	}
	assert.doesNotMatch(fonts.system, /system-ui/);
	assert.ok(fonts.system.startsWith("-apple-system, BlinkMacSystemFont"));
	assert.ok(fonts.mono.startsWith('ui-monospace, "SFMono-Regular", "SF Mono", Menlo'));
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
	assert.match(defaultStack, /-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*"Hipi Noto Sans SC",\s*sans-serif/);
	assert.doesNotMatch(defaultStack, /system-ui/);
	assert.match(css, /--font-code:[^;]*"Hipi Noto Sans SC", monospace;/);
});
