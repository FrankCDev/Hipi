import assert from "node:assert/strict";
import { test } from "node:test";
import { codeThemeChoices } from "../../../../src/app/theme/code-theme-catalog.ts";
import {
	CODE_HIGHLIGHT_INTERVAL_MS,
	CodeHighlightProjection,
	highlightCode,
} from "../../../../src/features/workbench/conversation/markdown/syntax-highlight.ts";

test("bundled Shiki tokenizes supported languages without network, HTML rendering or changing source", () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("Highlighting must not fetch");
	};
	try {
		for (const [language, source] of [
			["ts", "const x: string = '<script>unsafe</script>';\n\n// comment\n"],
			["python", "def greet(name):\n    return f'Hello {name}'\n"],
			["json", '{"source":"<img src=https://bad.test>"}\r\n'],
		]) {
			assert.ok(source && language);
			const result = highlightCode(source, language);
			assert.ok(result);
			assert.equal(result.source, source);
			let offset = 0;
			let rebuilt = "";
			for (const token of result.tokens) {
				rebuilt += source.slice(offset, token.offset) + token.content;
				offset = token.offset + token.content.length;
				assert.ok(token.light === undefined || /^#[\da-f]{6,8}$/iu.test(token.light));
				assert.ok(token.dark === undefined || /^#[\da-f]{6,8}$/iu.test(token.dark));
			}
			rebuilt += source.slice(offset);
			assert.equal(rebuilt, source);
		}
		assert.equal(highlightCode("unknown", "https://bad.test/grammar"), undefined);
		assert.equal(highlightCode("unknown", "__proto__"), undefined);
		const palettes = codeThemeChoices.map((theme) => {
			const result = highlightCode("const text = 'value'; // note", "ts", theme);
			assert.ok(result);
			assert.equal(result.theme, theme);
			return result.tokens.map((token) => [token.light, token.dark]);
		});
		assert.notDeepEqual(palettes[1], palettes[2]);
		assert.notDeepEqual(palettes[2], palettes[3]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("highlighting coalesces latest source at120ms, waits offscreen/selected and stops after disposal", (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let blocked = false;
	const seen: string[] = [];
	const calls: string[] = [];
	const themes: string[] = [];
	const projection = new CodeHighlightProjection(
		(value) => seen.push(value?.source ?? "plain"),
		() => blocked,
		(source, language, theme) => {
			calls.push(source);
			themes.push(theme ?? "adaptive");
			return { source, language, tokens: [] };
		},
	);
	for (let index = 1; index <= 100; index++) projection.update(`value${index}`, "ts");
	assert.equal(calls.length, 0);
	context.mock.timers.tick(CODE_HIGHLIGHT_INTERVAL_MS);
	assert.deepEqual(calls, ["value100"]);
	projection.update("selected", "ts");
	blocked = true;
	context.mock.timers.tick(CODE_HIGHLIGHT_INTERVAL_MS);
	assert.deepEqual(calls, ["value100"]);
	projection.update("latest", "ts", "solarized");
	blocked = false;
	projection.resume();
	context.mock.timers.tick(CODE_HIGHLIGHT_INTERVAL_MS);
	assert.deepEqual(seen, ["value100", "latest"]);
	assert.deepEqual(themes, ["adaptive", "solarized"]);
	projection.update("disposed", "ts");
	projection.dispose();
	context.mock.timers.tick(CODE_HIGHLIGHT_INTERVAL_MS);
	assert.deepEqual(seen, ["value100", "latest"]);
});
