import { registerCustomCSSVariableTheme, registerCustomLanguage, registerCustomTheme } from "@pierre/diffs";
import css from "shiki/langs/css.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import python from "shiki/langs/python.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import { bundledCodeThemes, type CodeThemeChoice, codeThemePairs } from "../../app/theme/code-theme-catalog.ts";

const grammars = { css, html, javascript, json, python, shellscript, typescript, yaml };
for (const [language, grammar] of Object.entries(grammars))
	registerCustomLanguage(language, () => Promise.resolve({ default: grammar }));
for (const theme of bundledCodeThemes) if (theme.name) registerCustomTheme(theme.name, () => Promise.resolve(theme));

/** Finite, bundled grammars. Unknown names never initiate a grammar fetch. */
export function fileLanguage(name: string) {
	const extension = name.split(".").at(-1)?.toLowerCase();
	const languages: Record<string, keyof typeof grammars> = {
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		ts: "typescript",
		tsx: "typescript",
		json: "json",
		css: "css",
		html: "html",
		htm: "html",
		py: "python",
		sh: "shellscript",
		bash: "shellscript",
		yaml: "yaml",
		yml: "yaml",
	};
	return extension && Object.hasOwn(languages, extension) ? (languages[extension] ?? "text") : "text";
}

export const PIERRE_THEME = "hipi-semantic";
export function pierreTheme(choice: CodeThemeChoice) {
	return choice === "adaptive" ? PIERRE_THEME : codeThemePairs[choice];
}
registerCustomCSSVariableTheme(PIERRE_THEME, {
	foreground: "var(--text)",
	background: "var(--surface)",
	"token-constant": "var(--accent-text)",
	"token-string": "var(--warning)",
	"token-comment": "var(--muted)",
	"token-keyword": "var(--accent-text)",
	"token-parameter": "var(--text)",
	"token-function": "var(--accent-text)",
	"token-string-expression": "var(--warning)",
	"token-punctuation": "var(--muted)",
	"token-link": "var(--accent-text)",
});

/** Original semantic adapter CSS, never file content or user-provided CSS. */
export const PIERRE_CSS = `
:host {
	color-scheme: inherit;
	--diffs-font-family: var(--font-mono, monospace);
	--diffs-header-font-family: var(--font-ui, sans-serif);
	--diffs-font-size: var(--font-code-size, 13px);
	--diffs-line-height: calc(var(--font-code-size, 13px) * 1.55);
	--diffs-bg: var(--surface);
	--diffs-fg: var(--text);
	--diffs-fg-number-override: var(--muted);
	--diffs-addition-color-override: var(--accent-text);
	--diffs-deletion-color-override: var(--danger);
	--diffs-modified-color-override: var(--brand);
	--diffs-bg-buffer-override: var(--surface);
}
[data-content][contenteditable="true"]:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
`;
