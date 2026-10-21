import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, evaluate, hover, until } from "../../gui-flow.mjs";

// Independently audited desktop source geometry, not values read from the CSS under test.
// This qualifies boxes in CSS pixels, not proprietary glyph artwork or screenshot parity.
export const sidebarRowContract = Object.freeze({
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
	// Public header glyph variants are not proven equivalent to the reference artwork.
	publicHeaderIconWrapper: 16,
});

/** Serializable read-only measurement. No scrolling, focusing or page event injection. */
export function sidebarRowGeometry(document, projectId) {
	const view = document.defaultView;
	const unique = (root, selector) => {
		const nodes = root.querySelectorAll(selector);
		if (nodes.length !== 1) throw Error(`Expected one geometry target: ${selector}; found ${nodes.length}`);
		return nodes[0];
	};
	const box = (node) => {
		const r = node.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
	};
	const measure = (node) => {
		const style = view.getComputedStyle(node);
		return {
			box: box(node),
			font: { family: style.fontFamily, size: Number.parseFloat(style.fontSize), weight: style.fontWeight },
			background: style.backgroundColor,
			hovered: node.matches(":hover"),
			selected: node.getAttribute("data-selected") === "true",
		};
	};
	const branch = unique(document, `.workspace-branch[data-project-id="${projectId}"]`);
	const parent = unique(branch, ".project-row");
	const region = unique(branch, ".project-conversations");
	const disclosure = unique(branch, ".project-toggle");
	const links = [...region.querySelectorAll(".conversation-link")];
	const rows = links.map((link) => ({
		...measure(link.closest(".sidebar-preview-row")),
		scope: { workspaceId: link.dataset.workspaceId, conversationId: link.dataset.conversationId },
		current: link.getAttribute("aria-current") === "page",
		location: link.dataset.sidebarLocation,
		projectId: link.dataset.sidebarLocationProject,
		link: measure(link),
	}));
	const controls = [
		["disclosure", disclosure, "toolbar"],
		["project-new", unique(branch, ".project-new-conversation"), "compact"],
		["project-menu", unique(branch, ".project-actions-trigger"), "compact"],
		["search", unique(document, ".sidebar-search-trigger"), "toolbar"],
		["collapse", unique(document, ".sidebar-collapse"), "toolbar"],
	].map(([name, node, role]) => ({
		name,
		role,
		...measure(node),
		centerHit: node.contains(
			document.elementFromPoint(box(node).x + box(node).width / 2, box(node).y + box(node).height / 2),
		),
		// Disclosure's public chevron has an intentionally different optical box.
		icons: [...node.querySelectorAll("svg:not([data-sidebar-icon='disclosure'])")].map(box),
	}));
	const siblings = [...branch.parentElement.children].filter((node) => node.matches(".workspace-branch"));
	const boundaries = siblings.slice(1).map((node, index) => box(node).y - box(siblings[index]).bottom);
	const pinned = [...document.querySelectorAll(".pinned-conversations .sidebar-preview-row")].map(measure);
	const recent = [...document.querySelectorAll(".recent-conversations [data-window-row]")].map((node) => ({
		index: Number(node.dataset.index),
		...measure(unique(node, ".sidebar-preview-row")),
		link: measure(unique(node, ".conversation-link")),
	}));
	const root = document.documentElement;
	const exposed = (node) => {
		if (!node) return false;
		const r = box(node);
		if (!node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) return false;
		for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
			const style = view.getComputedStyle(ancestor);
			if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
			if (ancestor !== node) {
				const clip = box(ancestor);
				const left = clip.x + ancestor.clientLeft;
				const top = clip.y + ancestor.clientTop;
				if (
					["hidden", "clip", "auto", "scroll"].includes(style.overflowX) &&
					(r.x < left || r.right > left + ancestor.clientWidth)
				)
					return false;
				if (
					["hidden", "clip", "auto", "scroll"].includes(style.overflowY) &&
					(r.y < top || r.bottom > top + ancestor.clientHeight)
				)
					return false;
			}
		}
		return true;
	};
	return {
		metadata: {
			viewport: { width: view.innerWidth, height: view.innerHeight },
			dpr: view.devicePixelRatio,
			visualViewportScale: view.visualViewport?.scale ?? null,
			cssZoom: view.getComputedStyle(root).zoom,
			rootFont: Number.parseFloat(view.getComputedStyle(root).fontSize),
			theme: root.dataset.theme ?? null,
			colorScheme: view.getComputedStyle(root).colorScheme,
			coarsePointer: view.matchMedia("(any-pointer: coarse)").matches,
			navigationMode: unique(document, ".work-shell").dataset.navigationMode,
			fontsStatus: document.fonts.status,
		},
		projectId,
		expanded: disclosure.getAttribute("aria-expanded") === "true",
		regionHidden: region.hidden,
		region: box(region),
		branch: box(branch),
		navigationViewport: box(unique(document, ".navigation-list")),
		parent: measure(parent),
		parentExposed: exposed(parent),
		firstChildExposed: exposed(links[0]?.closest(".sidebar-preview-row")),
		rows,
		controls,
		boundaries,
		pinned,
		recent,
		newChat: measure(unique(document, ".new-conversation-trigger")),
	};
}

export function assertSidebarRowGeometry(value, { expanded, scope }) {
	const c = sidebarRowContract;
	const exact = (actual, expected, label) => assert.equal(actual, expected, `${label} (${c.unit})`);
	assert.equal(value.expanded, expanded);
	assert.equal(value.regionHidden, !expanded);
	assert.equal(value.metadata.coarsePointer, false, "Default desktop fixture must use fine-pointer geometry");
	exact(value.metadata.rootFont, c.rootFont, "Default root font");
	assert.equal(value.metadata.fontsStatus, "loaded");
	assert.ok(Number.isFinite(value.metadata.dpr) && value.metadata.dpr > 0 && value.metadata.viewport.width >= 768);
	assert.equal(value.metadata.navigationMode, "desktop");
	assert.equal(value.metadata.visualViewportScale, 1, "Fixture must not use visual viewport zoom");
	assert.ok(["1", "normal"].includes(value.metadata.cssZoom), "Fixture must not use CSS zoom");
	exact(value.parent.font.size, c.rowFont, "Default navigation font");
	exact(value.parent.box.height, c.row, "Project row height");
	assert.ok(
		value.parent.box.y >= value.navigationViewport.y &&
			value.parent.box.bottom <= value.navigationViewport.bottom &&
			value.parent.box.x >= value.navigationViewport.x &&
			value.parent.box.right <= value.navigationViewport.right,
		"Hovered parent must be entirely visible in its scroll viewport",
	);
	exact(value.newChat.box.height, c.row, "New chat row height");
	assert.equal(value.parent.hovered, true, "Actual pointer must hover the parent");
	assert.equal(value.parentExposed, true, "Hovered parent must be painted and unobstructed");
	assert.ok(value.boundaries.length > 0, "Adjacent project boundary must exist");
	for (const gap of value.boundaries) exact(gap, c.gap, "Adjacent project branch gap");
	assert.ok(value.pinned.length >= 2, "Fixture must expose multiple pinned rows");
	for (const [index, row] of value.pinned.entries()) {
		exact(row.box.height, c.row, "Pinned row height");
		if (index) exact(row.box.y - value.pinned[index - 1].box.bottom, c.gap, "Pinned list gap");
	}
	assert.ok(value.recent.length >= 2, "Fixture must expose multiple rendered Recent rows");
	let recentGaps = 0;
	for (const [index, row] of value.recent.entries()) {
		assert.ok(Number.isInteger(row.index));
		exact(row.box.height, c.row, "Recent row height");
		exact(row.link.box.height, c.row, "Recent link height");
		exact(row.link.font.size, c.rowFont, "Recent link font");
		// A virtualizer may retain a focused row outside its contiguous viewport range.
		const previous = value.recent[index - 1];
		if (previous && row.index === previous.index + 1) {
			exact(row.box.y - previous.box.bottom, c.gap, "Recent virtual row gap");
			recentGaps++;
		}
	}
	assert.ok(recentGaps > 0, "At least one actual adjacent Recent pair must be measured");
	assert.deepEqual(
		value.controls.map(({ name }) => name),
		["disclosure", "project-new", "project-menu", "search", "collapse"],
	);
	for (const control of value.controls) {
		assert.equal(control.centerHit, true, `${control.name} hitbox must be unobstructed`);
		exact(control.box.width, c[control.role], `${control.name} hitbox width`);
		exact(control.box.height, c[control.role], `${control.name} hitbox height`);
		assert.ok(control.icons.length > 0, `${control.name} requires an actual icon box`);
		for (const icon of control.icons) {
			const header = ["search", "collapse"].includes(control.name);
			const size = header ? c.publicHeaderIconWrapper : c.icon;
			const label = header
				? `${control.name} public wrapper invariant (not reference glyph equivalence)`
				: `${control.name} icon`;
			exact(icon.width, size, `${label} width`);
			exact(icon.height, size, `${label} height`);
		}
	}
	if (expanded) {
		assert.ok(value.rows.length > 0, "Expanded first child must exist");
		const first = value.rows[0];
		assert.ok(
			first.box.y >= value.navigationViewport.y &&
				first.box.bottom <= value.navigationViewport.bottom &&
				first.box.x >= value.navigationViewport.x &&
				first.box.right <= value.navigationViewport.right,
			"Selected first child must be entirely visible",
		);
		assert.equal(value.firstChildExposed, true, "Selected child must be painted and unobstructed");
		assert.ok(
			first.box.y >= value.region.y && first.box.bottom <= value.region.bottom,
			"Child region must not clip the selected first row",
		);
		assert.deepEqual(first.scope, scope, "Selected target must still be the exact first child");
		assert.equal(first.current, true);
		assert.equal(first.selected, true);
		assert.equal(first.location, "project");
		assert.equal(first.projectId, value.projectId);
		assert.equal(value.rows.filter((row) => row.current).length, 1);
		exact(first.box.y - value.parent.box.bottom, c.gap, "Hovered parent to selected first child gap");
		assert.equal(
			first.background,
			value.parent.background,
			"Selected and hovered row surfaces must share their semantic color",
		);
		assert.ok(
			!["transparent", "rgba(0, 0, 0, 0)"].includes(first.background) &&
				!/\/\s*(?:0(?:\.0*)?|\.0+)%?\s*\)$/.test(first.background),
			"Both highlights must actually be painted",
		);
		for (const [index, row] of value.rows.entries()) {
			exact(row.box.height, c.row, "Project child row height");
			exact(row.link.box.height, c.row, "Project child link height");
			exact(row.link.font.size, c.rowFont, "Project child link font");
			if (index) exact(row.box.y - value.rows[index - 1].box.bottom, c.gap, "Project child list gap");
		}
	} else {
		assert.equal(value.rows.length, 0, "Collapsed child list must be unmounted");
		exact(value.region.height, 0, "Hidden child region height");
		exact(value.branch.height, c.row, "Collapsed branch must not retain a trailing child gap");
	}
}

/** Trusted CDP input, not DOM events or OS mouse injection. Never repairs scroll/focus. */
async function pointerClick(cdp, selector) {
	await hover(cdp, selector);
	const point = await evaluate(
		cdp,
		`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
	);
	for (const type of ["mousePressed", "mouseReleased"])
		await cdp.request("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
}

export async function exerciseSidebarRowGeometry({ cdp, seed, directory }) {
	const selector = `.workspace-branch[data-project-id="${seed.aliasProjectId}"]`;
	const toggle = `${selector} .project-toggle`;
	const firstLink = `${selector} .conversation-list > li:first-child .conversation-link`;
	const read = () =>
		evaluate(cdp, `(${sidebarRowGeometry.toString()})(document,${JSON.stringify(seed.aliasProjectId)})`);
	const evidence = {
		contract: sidebarRowContract,
		input: "CDP Input.dispatchMouseEvent",
		platform: process.platform,
		states: [],
		referenceScreenshotParity: "not qualified; reference viewport, DPR, zoom and fonts are unknown",
	};
	let originallyExpanded;
	try {
		await evaluate(cdp, "document.fonts.ready.then(()=>true)");
		originallyExpanded = (await read()).expanded;
		if (!originallyExpanded) await pointerClick(cdp, toggle);
		const scope = await until(async () => (await read()).rows[0]?.scope, "project first child exists for geometry");
		assert.ok(
			seed.snapshot.conversations.some(
				({ conversation }) =>
					conversation.workspaceId === scope.workspaceId && conversation.conversationId === scope.conversationId,
			),
			"Geometry target must belong to the seeded canonical catalog",
		);
		await pointerClick(cdp, firstLink);
		await until(async () => (await read()).rows[0]?.current, "actual first project child selected");
		await cdp.request("DOM.enable");
		await cdp.request("CSS.enable");
		const { root } = await cdp.request("DOM.getDocument");
		evidence.fonts = [];
		for (const target of [`${selector} .project-name`, firstLink]) {
			const { nodeId } = await cdp.request("DOM.querySelector", { nodeId: root.nodeId, selector: target });
			assert.ok(nodeId, "Font evidence requires the actual rendered target");
			const { fonts } = await cdp.request("CSS.getPlatformFontsForNode", { nodeId });
			assert.ok(
				fonts.some((font) => font.glyphCount > 0),
				"Platform font evidence must contain rendered glyphs",
			);
			evidence.fonts.push({ target, fonts });
		}
		evidence.layoutMetrics = await cdp.request("Page.getLayoutMetrics");
		assert.equal(
			evidence.layoutMetrics.cssVisualViewport?.zoom,
			1,
			"Default native fixture page zoom must be measured at 100%",
		);
		for (const expanded of [true, false]) {
			if (!expanded) await pointerClick(cdp, toggle);
			await hover(cdp, `${selector} .project-open`);
			await until(async () => {
				const value = await read();
				return value.expanded === expanded && value.parent.hovered && (expanded || value.region.height === 0);
			}, "project geometry state committed");
			let previous;
			const value = await until(async () => {
				const current = await read();
				const serialized = JSON.stringify(current);
				const settled = serialized === previous;
				previous = serialized;
				return settled ? current : null;
			}, "rendered geometry and highlight surfaces settle");
			const screenshot = `sidebar-row-geometry-${expanded ? "expanded" : "collapsed"}`;
			evidence.states.push({ expanded, scope, screenshot: `${screenshot}.png`, value });
			await capture(cdp, directory, screenshot);
			assertSidebarRowGeometry(value, { expanded, scope });
		}
		// The following alias journey explicitly selects its own canonical Recent alias
		// before typing/capturing panel owners. This probe never enters or changes drafts.
		if (originallyExpanded) await pointerClick(cdp, toggle);
		await until(async () => (await read()).expanded === originallyExpanded, "original project disclosure restored");
		await hover(cdp, ".app-toolbar");
		return { states: evidence.states.length, artifact: "sidebar-row-geometry.json" };
	} catch (error) {
		evidence.failure = error.message;
		throw error;
	} finally {
		await writeFile(join(directory, "sidebar-row-geometry.json"), `${JSON.stringify(evidence, null, 2)}\n`);
	}
}
