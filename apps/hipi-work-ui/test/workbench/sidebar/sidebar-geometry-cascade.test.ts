// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test } from "vitest";
import { themeVariables } from "../../../src/app/theme/application.ts";
import { defaultConfig } from "../../../src/app/theme/config.ts";
import { SidebarIcon } from "../../../src/features/workbench/sidebar/icon.tsx";

afterEach(() => {
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-sidebar-colors");
	document.head.replaceChildren();
	document.body.replaceChildren();
});

async function styles() {
	const themeUrl = new NodeURL("../../../src/theme.css", import.meta.url);
	const sidebarUrl = new NodeURL("../../../src/features/workbench/sidebar/layout.css", import.meta.url);
	const sharedTokens = await readFile(new NodeURL("../../../src/components/ui/tokens.css", import.meta.url), "utf8");
	// Compile the real semantic dependencies with Tailwind so unused-token pruning
	// cannot leave the test passing with an unresolved spacing foundation.
	const theme = await compile(`${await readFile(themeUrl, "utf8")}\n${sharedTokens}`, {
		base: fileURLToPath(new NodeURL(".", themeUrl)),
		onDependency: () => {},
	});
	const sidebar = await readFile(sidebarUrl, "utf8");
	return { theme: theme.build([]), sidebar };
}

function mount(css: string) {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.replaceChildren(style);
	document.body.innerHTML = `<aside class="sidebar">
		<div class="sidebar-brand-row"><button class="sidebar-search-trigger">Search</button></div>
		<div class="workspace-create"><button class="new-conversation-trigger">新聊天</button></div>
		<div class="navigation-list">
			<div class="sidebar-order-section"><div class="nav-section-heading">项目</div>
				<section class="sidebar-section-content"><div><ul class="workspace-tree">
					<li class="workspace-branch"><div class="project-row"><button class="project-toggle"><span class="project-icon"></span></button></div><div class="project-conversations"><ul class="conversation-list">
						<li><div class="sidebar-preview-row"><button class="conversation-link" id="project">项目会话</button><button class="project-new-conversation">New</button></div></li>
					</ul></div></li>
				</ul></div></section>
			</div>
			<div class="sidebar-order-section"><ul class="workspace-tree"><li class="recent-conversations">
				<div class="nav-section-heading">最近</div>
				<div class="project-conversations"><ul class="conversation-list recent-virtual-list">
					<li><div class="sidebar-preview-row"><button class="conversation-link" id="recent">Recent conversation</button></div></li>
				</ul></div>
			</li></ul></div>
		</div>
	</aside>`;
}

function computed(selector: string) {
	const element = document.querySelector(selector);
	assert.ok(element);
	return getComputedStyle(element);
}

test("sidebar geometry wins over later legacy theme rules in either emitted stylesheet order", async () => {
	const { theme, sidebar } = await styles();
	for (const ordered of [
		[sidebar, theme],
		[theme, sidebar],
	]) {
		mount(optimize(ordered.join("\n"), { minify: true }).code);
		for (const id of ["#project", "#recent"]) {
			const row = computed(id);
			assert.equal(row.paddingTop, "0px");
			assert.equal(row.paddingBottom, "0px");
			assert.equal(row.height, "auto");
		}
		assert.equal(Number.parseFloat(computed(".new-conversation-trigger").paddingTop), 0);
		assert.equal(computed(".new-conversation-trigger").gap, "var(--sidebar-content-gap)");
		assert.equal(computed(".nav-section-heading").marginTop, "0px");
		assert.equal(computed(".conversation-list").marginTop, "0px");
		assert.equal(computed(".recent-virtual-list").display, "block");
		assert.equal(Number.parseFloat(computed(".recent-virtual-list").gap), 0);
		assert.equal(computed(".sidebar-order-section + .sidebar-order-section").marginTop, "var(--sidebar-section-gap)");
	}
});

test("sidebar dimensions remain token-driven and font-adaptive rather than repeated per-control values", async () => {
	const { theme, sidebar } = await styles();
	mount(optimize(`${sidebar}\n${theme}`, { minify: true }).code);
	const root = document.querySelector<HTMLElement>(".sidebar");
	assert.ok(root);
	root.style.setProperty("--font-ui-size", "20px");
	root.style.setProperty("--sidebar-content-gap", "12px");
	root.style.setProperty("--sidebar-section-gap", "24px");
	assert.equal(computed(".sidebar").getPropertyValue("--sidebar-content-gap"), "12px");
	assert.equal(computed(".new-conversation-trigger").gap, "var(--sidebar-content-gap)");
	for (const selector of ["#project", "#recent", ".new-conversation-trigger", ".nav-section-heading"])
		assert.equal(computed(selector).minHeight, "var(--sidebar-row-height)");
	assert.match(computed(".sidebar").getPropertyValue("--sidebar-row-height"), /max\(.*var\(--font-ui-size\)/);
	// jsdom validates the cascade/reference, not browser var() layout resolution or pixels.
});

test("counterfactual reproduces the nested conversation padding regression", async () => {
	const { theme, sidebar } = await styles();
	const weaker = sidebar.replaceAll(
		".sidebar .workspace-tree .conversation-link",
		".workspace-tree .conversation-link",
	);
	mount(optimize(`${weaker}\n${theme}`, { minify: true }).code);
	assert.equal(computed("#recent").paddingTop, "7px");
	assert.equal(computed("#recent").paddingBottom, "7px");
});

test("shared spacing roles distinguish compact actions from toolbar targets and respect custom colors", async () => {
	const { theme, sidebar } = await styles();
	mount(optimize(`${sidebar}\n${theme}`, { minify: true }).code);
	assert.equal(computed(".sidebar").getPropertyValue("--sidebar-action-size"), "var(--ui-control-compact-size)");
	assert.equal(computed(".project-new-conversation").width, "var(--sidebar-action-size)");
	assert.equal(computed(".sidebar-search-trigger").width, "var(--sidebar-toolbar-size)");
	assert.equal(computed(".project-toggle").height, "var(--sidebar-toolbar-size)");
	assert.equal(computed(".project-icon").insetInlineStart, "var(--sidebar-disclosure-inset)");
	assert.match(
		computed(".project-toggle").marginInlineEnd,
		/var\(--sidebar-leading-slot\).*var\(--sidebar-toolbar-size\).*var\(--sidebar-disclosure-inset\)/,
	);
	// jsdom does not resolve declarations inside @layer; assert the emitted
	// foundation exists rather than treating an unresolved var() as pixel proof.
	assert.match(theme, /--spacing:\s*0?\.25rem/);
	assert.equal(computed(":root").getPropertyValue("--ui-hover-opacity"), "5%");
	document.documentElement.dataset.theme = "dark";
	assert.equal(computed(":root").getPropertyValue("--ui-hover-opacity"), "8%");
	assert.equal(computed(":root").getPropertyValue("--ui-hover-foreground"), "#fff");
	document.documentElement.dataset.sidebarColors = "custom";
	assert.equal(computed(".sidebar").getPropertyValue("--region-foreground"), "var(--sidebar-foreground)");
	assert.match(
		computed(".sidebar").getPropertyValue("--sidebar-row-hover-surface"),
		/var\(--region-foreground,\s*var\(--ui-hover-foreground\)\)/,
	);
	const config = defaultConfig();
	config.appearance.dark = { foreground: "#ffffcc", background: "#112233", accent: "#bbccff" };
	assert.equal(themeVariables(config, "dark")["--ui-hover-foreground"], "#ffffcc");
});

test("public navigation icons share a lightweight CSS role while disclosure keeps its smaller optical slot", async () => {
	const { theme, sidebar } = await styles();
	mount(optimize(`${sidebar}\n${theme}`, { minify: true }).code);
	const root = document.querySelector(".sidebar");
	assert.ok(root);
	for (const name of ["newChat", "folder", "panel", "search", "more", "disclosure"] as const) {
		root.insertAdjacentHTML("beforeend", renderToStaticMarkup(createElement(SidebarIcon, { name })));
		const selector = `[data-sidebar-icon="${name}"]`;
		assert.equal(document.querySelector(selector)?.getAttribute("aria-hidden"), "true");
		assert.equal(computed(selector).strokeWidth, "var(--ui-icon-stroke-width)");
		assert.equal(computed(":root").getPropertyValue("--ui-icon-stroke-width"), "1.6");
		assert.equal(computed(selector).width, name === "disclosure" ? "calc(var(--spacing) * 3)" : "var(--ui-icon-size)");
	}
});
