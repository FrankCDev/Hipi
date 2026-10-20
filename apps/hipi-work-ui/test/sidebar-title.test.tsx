import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { SidebarTitle } from "../src/features/workbench/sidebar-title.tsx";

test("a title exposes its complete text once without changing the parent button's semantics", () => {
	const html = renderToStaticMarkup(
		<button type="button" aria-labelledby="task-title">
			<SidebarTitle text="A full task title with 中文 and العربية" className="conversation-title" id="task-title" />
		</button>,
	);
	assert.equal((html.match(/A full task title with 中文 and العربية/g) ?? []).length, 1);
	assert.equal((html.match(/id="task-title"/g) ?? []).length, 1);
	assert.match(html, /class="conversation-title sidebar-title"/);
	assert.match(html, /data-overflowing="false" data-hovered="false"/);
	assert.doesNotMatch(html, /aria-hidden|aria-label=|title=|tabindex=|role=|<a\b/);
	assert.equal((html.match(/<button\b/g) ?? []).length, 1);
});

test("hover is explicit and initial rendering never invents width from the title's character count", () => {
	const html = renderToStaticMarkup(<SidebarTitle text={"Long content ".repeat(30)} hovered />);
	assert.match(html, /data-hovered="true"/);
	assert.match(html, /data-overflowing="false"/);
	assert.doesNotMatch(html, /--sidebar-title-duration|--sidebar-title-offset/);
});

test("the CSS requires real overflow and pointer hover, preserves the measured curve and never loops", async () => {
	const css = await readFile(new URL("../src/features/workbench/sidebar-title.css", import.meta.url), "utf8");
	assert.match(
		css,
		/\.sidebar-title\[data-overflowing="true"\]\[data-hovered="true"\] \.sidebar-title-content\s*\{\s*animation: sidebar-title-travel/,
	);
	assert.match(css, /cubic-bezier\(0\.49, 0\.6, 0\.7, 1\)/);
	assert.match(css, /var\(--sidebar-title-delay\) both/);
	assert.match(css, /translateX\(var\(--sidebar-title-offset\)\)/);
	assert.doesNotMatch(css, /infinite|focus|will-change|transition:/);
	assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(css, /:root:not\(\[data-reduced-motion="off"\]\)[\s\S]*animation: none/);
	assert.match(css, /:root\[data-reduced-motion="on"\][\s\S]*animation: none/);
});
