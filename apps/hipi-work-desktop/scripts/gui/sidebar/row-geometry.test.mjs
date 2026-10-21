import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { assertSidebarRowGeometry, sidebarRowContract, sidebarRowGeometry } from "./row-geometry.mjs";

const scope = { workspaceId: "workspace-a", conversationId: "first" };
const box = (y, height = 30, width = 240) => ({ x: 8, y, width, height, right: 8 + width, bottom: y + height });
const row = (y) => ({
	box: box(y),
	font: { family: "Arial", size: 14, weight: "400" },
	background: "color(srgb 0 0 0 / 0.05)",
	hovered: false,
	selected: false,
});
const normal = (expanded = true) => ({
	metadata: {
		viewport: { width: 1400, height: 872 },
		dpr: 2,
		visualViewportScale: 1,
		cssZoom: "1",
		rootFont: 16,
		theme: "light",
		coarsePointer: false,
		navigationMode: "desktop",
		fontsStatus: "loaded",
	},
	projectId: "project-a",
	expanded,
	regionHidden: !expanded,
	region: box(231, expanded ? 61 : 0),
	branch: box(200, expanded ? 92 : 30),
	navigationViewport: box(80, 700),
	parent: { ...row(200), hovered: true },
	parentExposed: true,
	firstChildExposed: expanded,
	rows: expanded
		? [
				{
					...row(231),
					scope,
					current: true,
					selected: true,
					location: "project",
					projectId: "project-a",
					link: row(231),
				},
				{
					...row(262),
					scope: { ...scope, conversationId: "second" },
					current: false,
					location: "project",
					projectId: "project-a",
					link: row(262),
				},
			]
		: [],
	controls: [
		["disclosure", "toolbar", 28],
		["project-new", "compact", 20],
		["project-menu", "compact", 20],
		["search", "toolbar", 28],
		["collapse", "toolbar", 28],
	].map(([name, role, size]) => ({
		name,
		role,
		box: box(200, size, size),
		centerHit: true,
		icons: [box(206, 16, 16)],
	})),
	boundaries: [1],
	pinned: [row(100), row(131), row(162)],
	recent: [0, 1, 2].map((index) => ({ ...row(400 + index * 31), index, link: row(400 + index * 31) })),
	newChat: row(30),
});

test("independent default desktop contract qualifies expanded and collapsed rendered boxes", () => {
	assert.deepEqual(sidebarRowContract, {
		version: 1,
		basis: "desktop-sidebar-source-geometry-audit-2026-10-21",
		unit: "CSS px",
		tolerance: 0,
		rootFont: 16,
		rowFont: 14,
		row: 30,
		gap: 1,
		compact: 20,
		toolbar: 28,
		icon: 16,
		publicHeaderIconWrapper: 16,
	});
	for (const expanded of [true, false]) assertSidebarRowGeometry(normal(expanded), { expanded, scope });
});

test("first child/hover oracle rejects touching, fractional mismatch, wrong target and absent evidence", () => {
	for (const mutate of [
		(v) => {
			v.rows[0].box.y = 230;
		},
		(v) => {
			v.rows[0].box.y = 230.984375;
		},
		(v) => {
			v.rows[0].scope.conversationId = "not-first";
		},
		(v) => {
			v.rows[0].current = false;
		},
		(v) => {
			v.rows[0].selected = false;
		},
		(v) => {
			v.rows[0].projectId = "other-project";
		},
		(v) => {
			v.rows[0].location = "recent";
		},
		(v) => {
			v.rows[1].current = true;
		},
		(v) => {
			v.rows = [];
		},
		(v) => {
			v.parent.hovered = false;
		},
		(v) => {
			v.parentExposed = false;
		},
		(v) => {
			v.firstChildExposed = false;
		},
		(v) => {
			v.region.bottom = 240;
		},
		(v) => {
			v.navigationViewport.bottom = 240;
		},
		(v) => {
			v.parent.background = "transparent";
			v.rows[0].background = "transparent";
		},
		(v) => {
			v.rows[0].background = "red";
		},
		(v) => {
			v.parent.background = v.rows[0].background = "oklab(0 0 0 / 0)";
		},
		(v) => {
			v.parent.background = v.rows[0].background = "color(srgb 0 0 0 / 0)";
		},
		(v) => {
			v.regionHidden = true;
		},
		(v) => {
			v.boundaries = [];
		},
		(v) => {
			v.boundaries = [0];
		},
	]) {
		const value = structuredClone(normal());
		mutate(value);
		assert.throws(() => assertSidebarRowGeometry(value, { expanded: true, scope }));
	}
});

test("geometry cannot self-calibrate to incorrect row, list, control, icon or font dimensions", () => {
	for (const mutate of [
		(v) => {
			v.parent.box.height = 36;
		},
		(v) => {
			v.newChat.box.height = 40;
		},
		(v) => {
			v.pinned[0].box.height = 31;
		},
		(v) => {
			v.pinned[1].box.y = 134;
		},
		(v) => {
			v.pinned = [];
		},
		(v) => {
			v.recent = [];
		},
		(v) => {
			v.recent[0].box.height = 36;
		},
		(v) => {
			v.recent[0].link.box.height = 36;
		},
		(v) => {
			v.recent[1].box.y += 1;
		},
		(v) => {
			v.recent = [v.recent[0], v.recent[2]];
		},
		(v) => {
			v.rows[1].box.height = 36;
		},
		(v) => {
			v.rows[1].link.box.height = 36;
		},
		(v) => {
			v.rows[1].box.y = 265;
		},
		(v) => {
			v.controls[1].box.width = 28;
		},
		(v) => {
			v.controls[0].box.height = 20;
		},
		(v) => {
			v.controls[0].icons[0].width = 17;
		},
		(v) => {
			v.controls[0].icons = [];
		},
		(v) => {
			v.controls[0].centerHit = false;
		},
		(v) => {
			v.controls.pop();
		},
		(v) => {
			v.parent.font.size = 15;
		},
		(v) => {
			v.metadata.rootFont = 18;
		},
		(v) => {
			v.metadata.viewport.width = 767;
		},
		(v) => {
			v.metadata.navigationMode = "overlay";
		},
		(v) => {
			v.metadata.dpr = Infinity;
		},
		(v) => {
			v.metadata.coarsePointer = true;
		},
		(v) => {
			v.metadata.visualViewportScale = 1.25;
		},
		(v) => {
			v.metadata.cssZoom = "1.25";
		},
		(v) => {
			v.metadata.fontsStatus = "loading";
		},
	]) {
		const value = structuredClone(normal());
		mutate(value);
		assert.throws(() => assertSidebarRowGeometry(value, { expanded: true, scope }));
	}
});

test("collapsed boundary rejects residual height, missing collapse and surviving child rows", () => {
	for (const mutate of [
		(v) => {
			v.branch.height = 31;
		},
		(v) => {
			v.region.height = 1;
		},
		(v) => {
			v.regionHidden = false;
		},
		(v) => {
			v.expanded = true;
		},
		(v) => {
			v.rows = normal().rows;
		},
	]) {
		const value = normal(false);
		mutate(value);
		assert.throws(() => assertSidebarRowGeometry(value, { expanded: false, scope }));
	}
});

test("serialized observer measures actual DOM targets and refuses missing/duplicate project targets", () => {
	const dom =
		new JSDOM(`<html data-theme="dark"><body><div class="work-shell" data-navigation-mode="desktop"></div><nav class="navigation-list"></nav>
		<button class="new-conversation-trigger"></button>
		<button class="sidebar-search-trigger"><svg></svg></button><button class="sidebar-collapse"><svg></svg></button>
		<ul><li class="workspace-branch" data-project-id="project-a">
		<div class="project-row"><button class="project-toggle" aria-expanded="true"><svg></svg><svg data-sidebar-icon="disclosure"></svg></button>
		<button class="project-new-conversation"><svg></svg></button><button class="project-actions-trigger"><svg></svg></button></div>
		<section class="project-conversations"><div class="sidebar-preview-row" data-selected="true"><button class="conversation-link" data-workspace-id="workspace-a" data-conversation-id="first" data-sidebar-location="project" data-sidebar-location-project="project-a" aria-current="page"></button></div></section>
		</li><li class="workspace-branch"></li></ul>
		<ul class="pinned-conversations"><li class="sidebar-preview-row"></li><li class="sidebar-preview-row"></li></ul>
	</body></html>`);
	try {
		const { document } = dom.window;
		dom.window.matchMedia = () => ({ matches: false });
		Object.defineProperty(document, "fonts", { value: { status: "loaded" } });
		dom.window.getComputedStyle = () => ({
			fontSize: "14px",
			fontFamily: "Measured font",
			fontWeight: "400",
			backgroundColor: "black",
			zoom: "1",
			colorScheme: "dark",
		});
		for (const [index, node] of [...document.querySelectorAll("*")].entries())
			node.getBoundingClientRect = () => box(index * 31);
		document.elementFromPoint = () => document.querySelector(".project-toggle");
		const before = document.documentElement.outerHTML;
		const read = () =>
			JSON.parse(
				JSON.stringify(runInNewContext(`(${sidebarRowGeometry.toString()})(document,"project-a")`, { document })),
			);
		const value = read();
		assert.equal(document.documentElement.outerHTML, before, "Observer must not mutate DOM");
		assert.deepEqual(value.rows[0].scope, scope);
		assert.equal(value.rows[0].current, true);
		assert.equal(value.rows[0].selected, true);
		assert.equal(value.metadata.theme, "dark");
		assert.equal(value.parent.font.family, "Measured font");
		assert.equal(value.controls[0].icons.length, 1, "Optical disclosure chevron is not falsely qualified as 16px");
		assert.equal(value.controls[0].centerHit, true);
		const child = document.querySelector(".project-conversations .sidebar-preview-row");
		const region = document.querySelector(".project-conversations");
		child.getBoundingClientRect = () => box(300);
		region.getBoundingClientRect = () => box(300, 60);
		document.elementFromPoint = () => child;
		assert.equal(read().firstChildExposed, true);
		const style = dom.window.getComputedStyle(region);
		Object.defineProperty(region, "clientHeight", { value: 10 });
		dom.window.getComputedStyle = (node) => (node === region ? { ...style, overflowY: "hidden" } : style);
		assert.equal(read().firstChildExposed, false, "A center hit cannot hide ancestor clipping");
		const parent = document.querySelector(".project-row");
		document.elementFromPoint = () => parent;
		dom.window.getComputedStyle = () => style;
		assert.equal(read().parentExposed, true);
		dom.window.getComputedStyle = (node) => (node === parent ? { ...style, opacity: "0" } : style);
		assert.equal(read().parentExposed, false, "Transparent parents cannot qualify painted highlights");
		const branch = document.querySelector("[data-project-id]");
		branch.after(branch.cloneNode(true));
		assert.throws(read, /Expected one geometry target/);
		branch.remove();
		document.querySelector("[data-project-id]").remove();
		assert.throws(read, /Expected one geometry target/);
	} finally {
		dom.window.close();
	}
});

test("native geometry uses trusted input and synthetic screenshots before alias baseline, without page repair", async () => {
	const source = await readFile(new URL("./row-geometry.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /dispatchEvent|scrollIntoView|scrollTop\s*=|\.focus\(|\.click\(/);
	assert.match(source, /Input\.dispatchMouseEvent/);
	assert.match(source, /CSS\.getPlatformFontsForNode/);
	assert.match(source, /Page\.getLayoutMetrics/);
	assert.match(source, /await capture\(cdp, directory, screenshot\)/);
	const registry = await readFile(new URL("../../verify-source.mjs", import.meta.url), "utf8");
	assert.match(
		registry,
		/nodeTests\.push\("apps\/hipi-work-desktop\/scripts\/gui\/sidebar\/row-geometry\.test\.mjs"\)/,
	);
	const journey = await readFile(new URL("./journey.mjs", import.meta.url), "utf8");
	assert.ok(journey.indexOf("await exerciseSidebarRowGeometry(") < journey.indexOf("await exerciseAliasSelection("));
	assert.match(
		journey,
		/await click\(cdp, recentRow\);[\s\S]*?const draft = aliasDraft;[\s\S]*?window\.__sidebarAlias=nodes/,
	);
});
