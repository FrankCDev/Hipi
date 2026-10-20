import assert from "node:assert/strict";
import { FILE_LIMITS } from "@hipi/work-runtime/files";
import { getSharedHighlighter, parseDiffFromFile } from "@pierre/diffs";
import { test, vi } from "vitest";
import { codeThemeChoices, codeThemePairs } from "../src/app/theme/code-theme-catalog.ts";
import { matchesEditorBinding } from "../src/features/files/editor-keybindings.ts";
import { BoundedTextDocument, fitsEditorBytes } from "../src/features/files/pierre-document.ts";
import { fileLanguage, PIERRE_THEME, pierreTheme } from "../src/features/files/pierre-theme.ts";

test("Pierre document rejects oversized resolved and positional transactions before history mutation", () => {
	const document = new BoundedTextDocument("file.txt", "kept", "text");
	const results: boolean[] = [];
	document.setLimitListener((value) => results.push(value));
	document.applyEdits([{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } }, newText: "!" }]);
	assert.equal(document.getText(), "kept!");
	const version = document.version;
	const undoCount = document.history.undoStack.length;
	document.applyResolvedEdits([{ start: 0, end: 5, text: "中".repeat(FILE_LIMITS.bytes / 3 + 1) }]);
	document.applyEdits([
		{
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
			newText: "x".repeat(FILE_LIMITS.bytes + 1),
		},
	]);
	assert.equal(document.getText(), "kept!");
	assert.equal(document.version, version);
	assert.equal(document.history.undoStack.length, undoCount);
	document.undo();
	assert.equal(document.getText(), "kept");
	document.redo();
	assert.equal(document.getText(), "kept!");
	assert.deepEqual(results, [false, true, true]);
});
test("transaction byte limit handles multiple edits and preserves supplied line endings", () => {
	assert.equal(fitsEditorBytes("😀".repeat(FILE_LIMITS.bytes / 4)), true);
	assert.equal(fitsEditorBytes(`${"😀".repeat(FILE_LIMITS.bytes / 4)}x`), false);
	const document = new BoundedTextDocument("file.txt", "a\r\nb", "text", 0, undefined, "\r\n");
	document.applyResolvedEdits([
		{ start: 0, end: 1, text: "文\n" },
		{ start: 3, end: 4, text: "😀" },
	]);
	assert.equal(document.getText(), "文\n\r\n😀");
	document.undo();
	assert.equal(document.getText(), "a\r\nb");
});
test("only finite bundled file languages are selected; unknown files use text", () => {
	assert.equal(fileLanguage("nested/file.ts"), "typescript");
	assert.equal(fileLanguage("data.json"), "json");
	assert.equal(fileLanguage("file.unknown"), "text");
	assert.equal(fileLanguage("scripthttps://example.invalid"), "text");
	for (const name of ["__proto__", "constructor", "toString", "file.__proto__", "file.constructor"])
		assert.equal(fileLanguage(name), "text");
});
test("configurable save and find shortcuts are exact on macOS and other platforms", () => {
	const event = { key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
	assert.equal(matchesEditorBinding(event, "Mod-s", false), true);
	assert.equal(matchesEditorBinding(event, "Mod-s", true), false);
	assert.equal(matchesEditorBinding({ ...event, key: "k", shiftKey: true }, "Ctrl-Shift-k", false), true);
	assert.equal(matchesEditorBinding({ ...event, altKey: true }, "Mod-s", false), false);
});
test("official Pierre highlighter uses registered local grammars and semantic theme without network", async () => {
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
	try {
		const highlighter = await getSharedHighlighter({
			preferredHighlighter: "shiki-js",
			themes: [PIERRE_THEME],
			langs: ["css", "html", "javascript", "json", "python", "shellscript", "typescript", "yaml", "text"],
		});
		const tokens = highlighter.codeToTokens("const x: number = 1", { lang: "typescript", theme: PIERRE_THEME });
		assert.equal(
			tokens.tokens
				.flat()
				.map((token) => token.content)
				.join(""),
			"const x: number = 1",
		);
		assert.ok(tokens.tokens.flat().some((token) => token.color?.includes("var(--diffs-")));
		assert.equal(pierreTheme("adaptive"), PIERRE_THEME);
		for (const choice of codeThemeChoices.filter((item) => item !== "adaptive")) {
			assert.deepEqual(pierreTheme(choice), codeThemePairs[choice]);
			for (const theme of Object.values(codeThemePairs[choice])) {
				const themed = await getSharedHighlighter({
					preferredHighlighter: "shiki-js",
					themes: [theme],
					langs: ["typescript"],
				});
				const result = themed.codeToTokens("const value = 1", { lang: "typescript", theme });
				assert.ok(result.tokens.flat().some((token) => token.color?.startsWith("#")));
			}
		}
		assert.equal(network.mock.calls.length, 0);
	} finally {
		network.mockRestore();
	}
});
test("official comparison retains exact baseline/current bytes", () => {
	const diff = parseDiffFromFile(
		{ name: "file.txt", contents: "initial\nline\n", lang: "text" },
		{ name: "file.txt", contents: "current\nline\n", lang: "text" },
	);
	assert.equal(diff.deletionLines.join(""), "initial\nline\n");
	assert.equal(diff.additionLines.join(""), "current\nline\n");
	assert.equal(diff.lang, "text");
});
