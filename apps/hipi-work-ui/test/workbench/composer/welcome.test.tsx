import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { WorkbenchWelcome } from "../../../src/features/workbench/workbench-welcome.tsx";

const preferences = vi.hoisted(() => ({ locale: "en" }));
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => preferences }));

test("project home composes a localized question with the real selector and keeps context outside the task form", () => {
	for (const locale of ["en", "zh-CN"]) {
		preferences.locale = locale;
		const html = renderToStaticMarkup(
			<WorkbenchWelcome
				workspaceName="Project A"
				projectSelector={<button type="button">Project A</button>}
				context={<button type="button">Local folder</button>}
				action={
					<form>
						<textarea aria-label="Draft" />
					</form>
				}
			/>,
		);
		assert.match(html, /data-project-ready="true"/);
		assert.match(html, /<h1[^>]*><span>.*<button type="button">Project A<\/button>.*<\/span><\/h1>/);
		assert.match(
			html,
			locale === "en"
				? /What should we work on in <button type="button">Project A<\/button>\?/
				: /我们应该在<button type="button">Project A<\/button>中做些什么？/,
		);
		assert.ok(html.indexOf("welcome-context") < html.indexOf("<form>"));
		assert.match(html, /class="welcome-composer"><form>/);
		assert.doesNotMatch(html.match(/<form>.*<\/form>/)?.[0] ?? "", /Local folder/);
	}
});

test("project trigger preserves a baseline-aligned wrapping box rather than fragmented inline text", () => {
	const css = readFileSync(
		new URL("../../../src/features/workbench/composer/home-layout.css", import.meta.url),
		"utf8",
	);
	const rule = css.match(/\.welcome-hero h1 button \{([^}]+)\}/)?.[1];
	assert.ok(rule);
	assert.match(rule, /display: inline-block;/);
	assert.match(rule, /vertical-align: baseline;/);
	assert.match(rule, /max-width: 100%;/);
	assert.match(rule, /white-space: normal;/);
	assert.match(rule, /overflow-wrap: break-word;/);
});

test("composer inset belongs to its child, not the equal-flex home split", () => {
	const css = readFileSync(
		new URL("../../../src/features/workbench/composer/home-layout.css", import.meta.url),
		"utf8",
	);
	const outer = css.match(/\.work-conversation-frame > \.welcome \{([^}]+)\}/)?.[1];
	assert.ok(outer);
	assert.match(outer, /padding: 24px var\(--home-inline-padding\) 0;/);
	assert.match(outer, /--home-composer-top-padding: 6px;/);
	assert.match(outer, /--home-composer-bottom-padding: 16px;/);
	assert.match(
		css,
		/\.welcome-composer \{\s*padding-block: var\(--home-composer-top-padding\) var\(--home-composer-bottom-padding\);/,
	);
	for (const region of ["welcome-hero", "welcome-action"]) {
		assert.match(css.match(new RegExp(`\\.welcome \\.${region} \\{([^}]+)\\}`))?.[1] ?? "", /flex: 1 0 0;/);
	}
});

test("projectless home has no invented project or file authorization control", () => {
	preferences.locale = "en";
	const html = renderToStaticMarkup(<WorkbenchWelcome action={<textarea aria-label="Draft" />} />);
	assert.match(html, /data-project-ready="false"/);
	assert.match(html, /What would you like to work on\?/);
	assert.doesNotMatch(html, /<button|welcome-context/);
});

test("pending and failed selected projects retain the hero geometry without a projectless heading", () => {
	preferences.locale = "en";
	for (const projectState of ["pending", "error"] as const) {
		const html = renderToStaticMarkup(
			<WorkbenchWelcome
				projectState={projectState}
				action={
					<button type="submit" disabled>
						Send
					</button>
				}
			/>,
		);
		assert.match(html, /class="welcome-hero"><div class="welcome-heading-placeholder" aria-hidden="true"><\/div>/);
		assert.doesNotMatch(html, /What would you like|What should we work/);
		assert.match(html, /<button type="submit" disabled="">Send<\/button>/);
	}
});
