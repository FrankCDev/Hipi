import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import sql from "shiki/langs/sql.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import { bundledCodeThemes, type CodeThemeChoice, codeThemePairs } from "../../../../app/theme/code-theme-catalog.ts";
import { MAX_RICH_TEXT_UNITS } from "./policy.ts";

export const CODE_HIGHLIGHT_INTERVAL_MS = 120;
const languages: Readonly<Record<string, string>> = {
	bash: "bash",
	sh: "bash",
	shell: "bash",
	css: "css",
	html: "html",
	javascript: "javascript",
	js: "javascript",
	jsx: "jsx",
	json: "json",
	markdown: "markdown",
	md: "markdown",
	python: "python",
	py: "python",
	sql: "sql",
	tsx: "tsx",
	typescript: "typescript",
	ts: "typescript",
	yaml: "yaml",
	yml: "yaml",
};
export type CodeToken = { offset: number; content: string; light?: string; dark?: string };
export type CodeHighlight = { source: string; language: string; theme?: CodeThemeChoice; tokens: readonly CodeToken[] };

// App-lifetime finite grammar/theme cache only. No message source cache, remote loaders,
// workers, WASM, dynamic imports, HTML rendering, or CSP exceptions.
let highlighter: HighlighterCore | undefined;
export function highlightCode(
	source: string,
	language: string,
	theme: CodeThemeChoice = "adaptive",
): CodeHighlight | undefined {
	const name = language.toLowerCase();
	const supported = Object.hasOwn(languages, name) ? languages[name] : undefined;
	if (!supported || source.length > MAX_RICH_TEXT_UNITS) return undefined;
	try {
		highlighter ??= createHighlighterCoreSync({
			engine: createJavaScriptRegexEngine(),
			langs: [bash, css, html, javascript, json, jsx, markdown, python, sql, tsx, typescript, yaml],
			themes: bundledCodeThemes,
		});
		const lines = highlighter.codeToTokensWithThemes(source, {
			lang: supported,
			themes: codeThemePairs[theme],
		});
		return {
			source,
			language,
			theme,
			tokens: lines.flatMap((line) =>
				line.map((token) => ({
					offset: token.offset,
					content: token.content,
					light: /^#[\da-f]{6,8}$/iu.test(token.variants.light?.color ?? "") ? token.variants.light?.color : undefined,
					dark: /^#[\da-f]{6,8}$/iu.test(token.variants.dark?.color ?? "") ? token.variants.dark?.color : undefined,
				})),
			),
		};
	} catch {
		// Unsupported grammar features or a failed enhancement never obscure selectable source.
		return undefined;
	}
}

/** Coalesce highlight work independently of readable code, with selection/viewport backpressure. */
export class CodeHighlightProjection {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private source = "";
	private language = "";
	private theme: CodeThemeChoice = "adaptive";
	private pending = false;
	private disposed = false;
	private readonly publish: (value: CodeHighlight | undefined) => void;
	private readonly blocked: () => boolean;
	private readonly highlight: typeof highlightCode;

	constructor(publish: (value: CodeHighlight | undefined) => void, blocked: () => boolean, highlight = highlightCode) {
		this.publish = publish;
		this.blocked = blocked;
		this.highlight = highlight;
	}

	update(source: string, language: string, theme: CodeThemeChoice = "adaptive") {
		if (this.disposed) return;
		this.source = source;
		this.language = language;
		this.theme = theme;
		this.pending = true;
		this.resume();
	}

	resume() {
		if (this.disposed || !this.pending || this.timer !== undefined || this.blocked()) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed || this.blocked()) return;
			this.pending = false;
			this.publish(this.highlight(this.source, this.language, this.theme));
		}, CODE_HIGHLIGHT_INTERVAL_MS);
	}

	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
	}
}
