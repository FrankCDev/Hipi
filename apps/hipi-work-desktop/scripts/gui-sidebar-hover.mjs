import assert from "node:assert/strict";
import { capture, click, evaluate, hover, pressKey, until } from "./gui-flow.mjs";
import { nativeEditorKey } from "./gui-work-experience.mjs";

export function assertPreviewBounds(value) {
	assert.ok(
		value &&
			[value.x, value.y, value.width, value.height, value.viewportWidth, value.viewportHeight].every(Number.isFinite),
	);
	assert.ok(
		value.width > 0 &&
			value.height > 0 &&
			value.x >= 0 &&
			value.y >= 0 &&
			value.x + value.width <= value.viewportWidth + 1 &&
			value.y + value.height <= value.viewportHeight + 1,
		"Preview must fit actual viewport",
	);
	assert.equal(value.hit, true, "Preview must remain pointer-reachable");
	assert.equal(value.title, true, "Preview must contain complete exact title");
	assert.equal(value.contentFits, true, "Preview title must fit its card without clipping or horizontal overflow");
}

export async function exerciseSidebarHover(cdp, directory, scope, originalTitle) {
	for (const value of [scope.workspaceId, scope.conversationId]) assert.match(value, /^[A-Za-z0-9_-]{1,128}$/);
	const branch = `.workspace-branch[data-workspace-id="${scope.workspaceId}"]`;
	const link = `${branch} .conversation-link[data-conversation-id="${scope.conversationId}"]`;
	const row = `${branch} .conversation-nav-item`;
	const longTitle =
		"GUI sidebar long title 中文 overflow acceptance with retained conversation identity and complete preview";
	const read = (expression) => evaluate(cdp, expression);
	const check = (expression, label) => until(() => read(expression), label);
	const rename = async (title) => {
		await click(cdp, "header .conversation-actions-trigger");
		await click(cdp, '[role="menuitem"]', "Rename conversation");
		await click(cdp, ".conversation-rename-input");
		await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
		await nativeEditorKey(cdp, "Backspace");
		await cdp.request("Input.insertText", { text: title });
		await click(cdp, ".conversation-rename-save");
		await check(
			`!document.querySelector('.conversation-rename-dialog') && document.querySelector(${JSON.stringify(link)})?.textContent===${JSON.stringify(title)}`,
			"actual rename commits exact title",
		);
	};
	await read(
		`void (window.__hipiSidebarContinuity={panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll'),draft:document.querySelector('.composer textarea').value,ids:[...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId)})`,
	);
	const continuity = async () =>
		assert.equal(
			await read(
				`(()=>{const b=window.__hipiSidebarContinuity;return b.panel===document.querySelector('.conversation-panel')&&b.composer===document.querySelector('.composer textarea')&&b.history===document.querySelector('.message-scroll')&&b.composer.value===b.draft&&JSON.stringify(b.ids)===JSON.stringify([...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId))&&document.querySelectorAll('.workspace-branch').length===2})()`,
			),
			true,
			"Sidebar actions must retain actual conversation, draft, history and workspace identities",
		);
	const filter = async (text) => {
		await click(cdp, `${branch} .recent-actions-trigger`);
		await click(cdp, '[role="menuitemradio"]', text);
		await check(`!document.querySelector('[role="menu"]')`, "Recent filter menu closes");
	};
	try {
		await rename(longTitle);
		await hover(cdp, ".app-toolbar");
		await check("!document.querySelector('.conversation-preview-card')", "prior preview closes");
		await cdp.request("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
		});
		const hoverStart = await read("performance.now()");
		await hover(cdp, link);
		const early = await read(
			`({elapsed:performance.now()-${hoverStart},card:!!document.querySelector('.conversation-preview-card')})`,
		);
		if (early.elapsed < 150)
			assert.equal(early.card, false, "Ordinary title hover must not open its preview immediately");
		await check(
			`document.querySelector(${JSON.stringify(`${link} .sidebar-title`)})?.dataset.overflowing==='true' && document.querySelector(${JSON.stringify(`${link} .sidebar-title`)})?.dataset.hovered==='true'`,
			"actual long title overflows while hovered",
		);
		const motion = await read(
			`getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).animationName`,
		);
		assert.equal(
			motion === "none",
			await read("document.documentElement.dataset.reducedMotion==='on'"),
			"Only the explicit reduced-motion preference may suppress travel under no-preference media",
		);
		if (motion !== "none")
			await check(
				`new DOMMatrixReadOnly(getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).transform).m41 < -1`,
				"long title actually travels after its hover delay",
			);
		await check("!!document.querySelector('.conversation-preview-card')", "delayed conversation preview appears");
		const bounds = await read(
			`(()=>{const c=document.querySelector('.conversation-preview-card'),r=c.getBoundingClientRect(),t=c.querySelector('.preview-title'),tr=t.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,hit:c.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),title:t.textContent===${JSON.stringify(longTitle)},contentFits:tr.x>=r.x&&tr.y>=r.y&&tr.right<=r.right+1&&tr.bottom<=r.bottom+1&&t.scrollWidth<=t.clientWidth+1&&t.scrollHeight<=t.clientHeight+1}})()`,
		);
		assertPreviewBounds(bounds);
		await hover(cdp, ".conversation-preview-card");
		await check("!!document.querySelector('.conversation-preview-card')", "pointer transfers into retained preview");
		await capture(cdp, directory, "sidebar-long-title-preview");
		await hover(cdp, ".app-toolbar");
		await check("!document.querySelector('.conversation-preview-card')", "pointer leave dismisses card");
		await check(
			`getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).transform==='none'`,
			"leaving row resets title travel",
		);
		await cdp.request("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await hover(cdp, link);
		const reduced = await read(
			`document.documentElement.dataset.reducedMotion==='off' ? 'explicit-off' : getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).animationName`,
		);
		assert.ok(reduced === "none" || reduced === "explicit-off");
		await hover(cdp, ".app-toolbar");
		await cdp.request("Emulation.setEmulatedMedia", { features: [] });
		for (const pinned of [true, false]) {
			await hover(cdp, link);
			await click(cdp, `${row} [data-action="pin-conversation-direct"]`);
			await check(
				`document.querySelectorAll('.pinned-conversations .conversation-link').length===${pinned ? 1 : 0} && document.querySelectorAll('.pinned-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]').length===${pinned ? 1 : 0}`,
				"direct pin toggles only shortcut",
			);
			await continuity();
		}
		await hover(cdp, link);
		await click(cdp, `${row} [data-action="archive-conversation-direct"]`);
		await check(
			`!document.querySelector(${JSON.stringify(link)}) && document.activeElement===document.querySelector(${JSON.stringify(`${branch} .project-conversations`)})`,
			"archive removes list row and restores list boundary focus",
		);
		await continuity();
		await filter("Archived conversations");
		await check(`!!document.querySelector(${JSON.stringify(link)})`, "same canonical archived conversation appears");
		await hover(cdp, link);
		await click(cdp, `${row} [data-action="restore-conversation-direct"]`);
		await check(
			`!document.querySelector(${JSON.stringify(link)}) && document.activeElement===document.querySelector(${JSON.stringify(`${branch} .project-conversations`)})`,
			"restore removes archived row and restores boundary focus",
		);
		await filter("Active conversations");
		await check(`!!document.querySelector(${JSON.stringify(link)})`, "original active conversation returns");
		await rename(originalTitle);
		await continuity();
		const project = ".workspace-branch:not(.recent-conversations)";
		await hover(cdp, `${project} .project-open`);
		await click(cdp, `${project} .project-actions-trigger`);
		await pressKey(cdp, "Escape");
		await nativeEditorKey(cdp, "Tab", { modifiers: 8 });
		await check(
			`document.activeElement===document.querySelector('${project} .project-open') && !!document.querySelector('.project-preview-content')`,
			"keyboard focus opens actual project card",
		);
		await nativeEditorKey(cdp, "Tab");
		await check(
			"document.querySelector('.project-preview-content')?.contains(document.activeElement)",
			"Tab enters project card control",
		);
		await nativeEditorKey(cdp, "Tab", { modifiers: 8 });
		await check(
			`document.activeElement===document.querySelector('${project} .project-open') && !!document.querySelector('.project-preview-content')`,
			"Shift Tab returns to project without dismissing card",
		);
		await nativeEditorKey(cdp, "Tab");
		await capture(cdp, directory, "sidebar-project-card-keyboard");
		await pressKey(cdp, "Escape");
		await check(
			`!document.querySelector('.conversation-preview-card') && document.activeElement===document.querySelector('${project} .project-open')`,
			"Escape closes project card and restores origin",
		);
		await continuity();
		return {
			longTitleOverflow: true,
			hoverDelay: early.elapsed < 150 ? "observed_not_immediate" : "not_run_observation_arrived_after_delay",
			titleMotion: motion === "none" ? "disabled_by_preference" : "observed",
			reducedMotion: reduced === "none" ? "observed" : "not_run_explicit_override",
			cardBounds: bounds,
			pointerTransfer: true,
			directPinRoundTrip: true,
			archiveRestoreRoundTrip: true,
			projectKeyboardReturn: true,
			originalTitleRestored: true,
		};
	} finally {
		await cdp.request("Emulation.setEmulatedMedia", { features: [] });
		await read("delete window.__hipiSidebarContinuity");
	}
}
