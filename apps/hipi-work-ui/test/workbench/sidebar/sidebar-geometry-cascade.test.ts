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
import {
	ActionMenuBoundary,
	ActionMenuContextTrigger,
	ActionMenuTrigger,
} from "../../../src/components/ui/action-menu.tsx";
import { SidebarIcon } from "../../../src/features/workbench/sidebar/icon.tsx";

afterEach(() => {
	document.documentElement.removeAttribute("dir");
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-sidebar-colors");
	document.head.replaceChildren();
	document.body.replaceChildren();
});

test("section and project disclosures rotate the right-facing glyph once: inline-end when closed, down when open", async () => {
	const { theme, sidebar } = await styles();
	for (const ordered of [
		[sidebar, theme],
		[theme, sidebar],
	]) {
		mount(optimize(ordered.join("\n"), { minify: true }).code);
		const root = document.querySelector(".sidebar");
		assert.ok(root);
		for (const className of ["sidebar-section-chevron", "project-chevron"]) {
			const wrapper = document.createElement("span");
			wrapper.className = className;
			wrapper.innerHTML = renderToStaticMarkup(createElement(SidebarIcon, { name: "disclosure" }));
			root.append(wrapper);
			const glyph = wrapper.querySelector("svg");
			assert.ok(glyph);
			assert.ok(glyph.classList.contains("lucide-chevron-right"), "rotation assumes the actual right-facing glyph");
			assert.equal(glyph.getAttribute("aria-hidden"), "true");
			for (const direction of ["ltr", "rtl"] as const) {
				document.documentElement.dir = direction;
				for (const expanded of [false, true, false]) {
					wrapper.dataset.expanded = String(expanded);
					const rotation = getComputedStyle(wrapper).transform.match(/^rotate\((-?\d+)(?:deg)?\)$/);
					assert.ok(rotation, "one wrapper rotation, including minified unitless zero");
					assert.equal(Number(rotation[1]), expanded ? 90 : direction === "rtl" ? 180 : 0);
					assert.ok(["", "none"].includes(getComputedStyle(glyph).transform), "no second rotation on the SVG");
				}
			}
			wrapper.remove();
		}
	}
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

test("pointer selection hides rails while hover, keyboard focus and either real menu trigger retain them", async () => {
	const { theme, sidebar } = await styles();
	// jsdom does not synthesize pointer modality or evaluate fine-pointer media.
	// Adapt only those browser inputs; retain emitted selectors/declarations.
	const adapted = sidebar
		.replaceAll(":focus-visible", ".test-keyboard-focus")
		.replaceAll(":focus-within", ".test-focus-within")
		.replaceAll(":hover", ".test-hover");
	const style = document.createElement("style");
	style.textContent = optimize(`${theme}\n${adapted}`, { minify: true }).code;
	document.head.append(style);
	assert.ok(style.sheet);
	function desktopRules(rules: CSSRuleList): string {
		return Array.from(rules, (rule) => {
			if (rule instanceof CSSMediaRule) {
				return /hover:\s*hover/.test(rule.conditionText) ? desktopRules(rule.cssRules) : "";
			}
			return rule.cssText;
		}).join("\n");
	}
	const css = desktopRules(style.sheet.cssRules);
	for (const railClass of ["conversation-hover-actions", "sidebar-row-actions"]) {
		for (const entry of ["ellipsis", "context"] as const) {
			for (const open of [false, true]) {
				mount(css);
				const tree = document.querySelector(".workspace-tree");
				assert.ok(tree);
				const menu = createElement(
					ActionMenuTrigger,
					{ asChild: true },
					createElement("button", { type: "button", className: "conversation-actions-trigger" }, "More"),
				);
				const rowMarkup = createElement(
					"div",
					{ className: "sidebar-preview-row", "data-selected": "true" },
					createElement("button", { type: "button", className: "conversation-link" }, "Selected"),
					createElement("div", { className: railClass }, menu),
				);
				tree.innerHTML = renderToStaticMarkup(
					createElement(ActionMenuBoundary, {
						state: { entry, open, onOpenChange: () => {} },
						// biome-ignore lint/correctness/noChildrenProp: createElement must satisfy this component's required children prop in a .ts test.
						children: createElement(ActionMenuContextTrigger, { asChild: true }, rowMarkup),
					}),
				);
				const row = tree.querySelector<HTMLElement>(".sidebar-preview-row");
				const title = tree.querySelector<HTMLButtonElement>(".conversation-link");
				const rail = tree.querySelector<HTMLElement>(`.${railClass}`);
				const trigger = tree.querySelector<HTMLButtonElement>(".conversation-actions-trigger");
				assert.ok(row && title && rail && trigger);
				assert.equal(getComputedStyle(rail).gap, "var(--sidebar-content-gap)");
				assert.equal(row.dataset.state, open && entry === "context" ? "open" : "closed");
				assert.equal(trigger.getAttribute("aria-expanded"), String(open && entry === "ellipsis"));
				title.focus();
				row.classList.add("test-focus-within");
				assert.equal(document.activeElement, title);
				assert.equal(getComputedStyle(rail).opacity, open ? "1" : "0", "pointer focus alone is not keyboard focus");
				assert.equal(getComputedStyle(rail).width, open ? "auto" : "0px");
				row.classList.add("test-hover");
				assert.equal(getComputedStyle(rail).opacity, "1");
				row.classList.remove("test-hover");
				title.classList.add("test-keyboard-focus");
				assert.equal(getComputedStyle(rail).opacity, "1");
				title.classList.remove("test-keyboard-focus");
				trigger.classList.add("test-keyboard-focus");
				assert.equal(getComputedStyle(rail).opacity, "1", "tabbing into an action keeps its parent visible");
				trigger.classList.remove("test-keyboard-focus");
				trigger.dataset.state = "open";
				assert.equal(getComputedStyle(rail).opacity, open ? "1" : "0", "unrelated tooltip state cannot pin actions");
				assert.equal(row.dataset.selected, "true");
			}
		}
	}
});

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

test("selection preserves navigation title weight and keyboard outlines stay inside controls", async () => {
	const { theme, sidebar } = await styles();
	for (const ordered of [
		[sidebar, theme],
		[theme, sidebar],
	]) {
		mount(optimize(ordered.join("\n").replaceAll(":focus-visible", ".test-keyboard-focus"), { minify: true }).code);
		const title = document.querySelector<HTMLElement>("#project");
		assert.ok(title?.parentElement);
		for (const selected of [false, true]) {
			title.parentElement.dataset.selected = String(selected);
			assert.equal(getComputedStyle(title).fontWeight, "var(--sidebar-label-weight)");
			assert.equal(getComputedStyle(title).lineHeight, "var(--sidebar-label-line-height)");
		}
		title.classList.add("test-keyboard-focus");
		assert.equal(getComputedStyle(title).outlineOffset, "calc(-1 * var(--sidebar-focus-width))");
		assert.equal(computed(".new-conversation-trigger").fontWeight, "var(--sidebar-label-weight)");
		assert.equal(computed(".nav-section-heading").fontWeight, "500");
	}
});

test("expanded project separates its hovered header from the selected first session without changing other list gaps", async () => {
	const { theme, sidebar } = await styles();
	for (const ordered of [
		[sidebar, theme],
		[theme, sidebar],
	]) {
		mount(optimize(ordered.join("\n"), { minify: true }).code);
		const branch = document.querySelector<HTMLElement>(".workspace-branch");
		const header = branch?.querySelector<HTMLElement>(".project-row");
		const content = branch?.querySelector<HTMLElement>(".project-conversations");
		const selected = content?.querySelector<HTMLElement>(".sidebar-preview-row");
		assert.ok(branch && header && content && selected);
		header.classList.add("sidebar-preview-row");
		header.dataset.state = "open";
		selected.dataset.selected = "true";
		assert.equal(header.nextElementSibling, content);
		assert.equal(content.querySelector(".conversation-list")?.firstElementChild?.firstElementChild, selected);
		assert.equal(computed(".workspace-branch").display, "flex");
		assert.equal(computed(".workspace-branch").flexDirection, "column");
		assert.equal(computed(".workspace-branch").gap, "var(--sidebar-row-gap)");
		assert.equal(computed(".sidebar").getPropertyValue("--sidebar-row-gap"), "1px");
		assert.equal(computed(".project-conversations").marginTop, "0px");
		assert.equal(computed(".conversation-list").gap, "var(--sidebar-row-gap)");
		assert.equal(Number.parseFloat(computed(".recent-virtual-list").gap), 0);
		assert.notEqual(computed(".recent-conversations").display, "flex");
		content.hidden = true;
		assert.equal(getComputedStyle(content).display, "none");
		// A hidden flex item contributes neither a box nor a gap; no margin or
		// padding survives collapse. jsdom checks the cascade, not rendered pixels.
		content.hidden = false;
		assert.notEqual(getComputedStyle(content).display, "none");
	}
});

test("counterfactual reproduces the touching project header and first-session containers", async () => {
	const { theme, sidebar } = await styles();
	const missingBranchGap = sidebar.replace(
		/\.sidebar \.workspace-tree > \.workspace-branch:not\(\.recent-conversations\) \{[^}]*\}/,
		"",
	);
	assert.notEqual(missingBranchGap, sidebar);
	mount(optimize(`${missingBranchGap}\n${theme}`, { minify: true }).code);
	assert.notEqual(computed(".workspace-branch").display, "flex");
	assert.notEqual(computed(".workspace-branch").gap, "var(--sidebar-row-gap)");
	assert.equal(computed(".project-conversations").marginTop, "0px");
	assert.equal(computed(".conversation-list").marginTop, "0px");
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
