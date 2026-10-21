import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, evaluate, hover, until } from "../../gui-flow.mjs";
import { revealRecentConversation } from "./new-chat-navigation.mjs";

/** Read only: never scroll or replace the retained native input target. */
export function retainedTargetPoint(document, node) {
	if (!node?.isConnected) return null;
	const rect = node.getBoundingClientRect();
	const x = rect.x + rect.width / 2;
	const y = rect.y + rect.height / 2;
	return rect.width > 0 && rect.height > 0 && node.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
}

/** Read-only DOM evidence. Retained references never drive application state. */
export function contextMenuState(document, retained) {
	const all = (selector) => [...document.querySelectorAll(selector)];
	const menus = all('[role="menu"]');
	const menu = menus[0];
	const preview = menu?.querySelector(".sidebar-menu-preview");
	const sourceRow = retained.source?.closest(".sidebar-preview-row");
	const rail = sourceRow?.querySelector(".conversation-hover-actions");
	const railStyle = rail && document.defaultView.getComputedStyle(rail);
	const railWidth = railStyle ? Number.parseFloat(railStyle.width) : NaN;
	const railOpacity = railStyle ? Number.parseFloat(railStyle.opacity) : NaN;
	const menuRect = menu?.getBoundingClientRect();
	const triggerRect = retained.trigger?.getBoundingClientRect?.();
	let intrinsicMenuWidth = 0;
	let itemsFit = !!menu;
	if (menu) {
		const measure = document.createElement("canvas").getContext("2d");
		if (!measure) throw new Error("Menu width probe needs independent text metrics");
		const number = (value) => Number.parseFloat(value) || 0;
		for (const item of menu.querySelectorAll('[role="menuitem"]')) {
			const style = document.defaultView.getComputedStyle(item);
			const label = item.textContent.trim();
			measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const icons = [...item.children];
			const content = measure.measureText(label).width + number(style.letterSpacing) * label.length;
			const leading = icons.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
			intrinsicMenuWidth = Math.max(
				intrinsicMenuWidth,
				content +
					leading +
					number(style.columnGap) * icons.length +
					number(style.paddingLeft) +
					number(style.paddingRight) +
					number(style.borderLeftWidth) +
					number(style.borderRightWidth),
			);
		}
		const style = document.defaultView.getComputedStyle(menu);
		intrinsicMenuWidth +=
			number(style.paddingLeft) +
			number(style.paddingRight) +
			number(style.borderLeftWidth) +
			number(style.borderRightWidth);
		let previousBottom = menuRect.top;
		for (const item of menu.querySelectorAll('[role="menuitem"], [role="separator"]')) {
			const rect = item.getBoundingClientRect();
			itemsFit &&=
				rect.width > 0 &&
				rect.height > 0 &&
				rect.top >= previousBottom - 0.5 &&
				rect.left >= menuRect.left &&
				rect.right <= menuRect.right + 0.5 &&
				rect.bottom <= menuRect.bottom + 0.5 &&
				item.scrollWidth <= item.clientWidth + 1;
			previousBottom = rect.bottom;
		}
	}
	const messages = all("[data-message-id]");
	const rows = all(".sidebar-preview-row");
	const triggers = all(".conversation-actions-trigger");
	const staticRows = rows.filter((node) => !node.closest("[data-window-row]"));
	const staticTriggers = triggers.filter((node) => !node.closest("[data-window-row]"));
	// Reading computed style flushes the hover style before inspecting its CSS transitions.
	const rowBackground = sourceRow && document.defaultView.getComputedStyle(sourceRow).backgroundColor;
	if (sourceRow && typeof sourceRow.getAnimations !== "function")
		throw new Error("Context surface probe requires Element.getAnimations");
	const rowAnimations = sourceRow?.getAnimations().map((animation) => ({
		pending: animation.pending,
		playState: animation.playState,
	}));
	return {
		route: document.defaultView.location.href,
		selected: all('.conversation-link[aria-current="page"]').map((node) => ({
			workspaceId: node.dataset.workspaceId,
			conversationId: node.dataset.conversationId,
			location: node.dataset.sidebarLocation,
		})),
		draft: document.querySelector(".composer textarea")?.value,
		messages: messages.map((node) => ({ id: node.dataset.messageId, text: node.textContent })),
		samePanel: retained.panel?.isConnected && retained.panel === document.querySelector(".conversation-panel"),
		sameComposer: retained.composer?.isConnected && retained.composer === document.querySelector(".composer textarea"),
		sameHistory: retained.history?.isConnected && retained.history === document.querySelector(".message-scroll"),
		sameMessages:
			messages.length === retained.messages.length && messages.every((node, i) => node === retained.messages[i]),
		sameRows: rows.length === retained.rows.length && rows.every((node, i) => node === retained.rows[i]),
		sameTriggers:
			triggers.length === retained.triggers.length && triggers.every((node, i) => node === retained.triggers[i]),
		// The virtual window may change while scrolling. Its actual interaction owner may not.
		sameStaticRows:
			staticRows.length === retained.staticRows.length &&
			staticRows.every((node, i) => node === retained.staticRows[i]),
		sameStaticTriggers:
			staticTriggers.length === retained.staticTriggers.length &&
			staticTriggers.every((node, i) => node === retained.staticTriggers[i]),
		sameSourceRow: retained.sourceRow?.isConnected === true && sourceRow === retained.sourceRow,
		sameSourceTrigger:
			retained.trigger?.isConnected === true &&
			sourceRow?.querySelector(".conversation-actions-trigger") === retained.trigger,
		uniqueSource:
			all(retained.sourceSelector).length === 1 && document.querySelector(retained.sourceSelector) === retained.source,
		virtualRows: rows.flatMap((node) => {
			const item = node.closest("[data-window-row]");
			return item ? [{ workspaceId: item.dataset.workspaceId, conversationId: item.dataset.conversationId }] : [];
		}),
		sourceConnected: retained.source?.isConnected === true,
		menuCount: menus.length,
		menuOpen: menu?.dataset.state === "open",
		menuSlot: menu?.dataset.slot ?? null,
		menuVisible: !!menu?.getClientRects().length,
		menuWidth: menuRect?.width ?? 0,
		menuLeft: menuRect?.left ?? 0,
		menuRight: menuRect?.right ?? 0,
		menuTop: menuRect?.top ?? 0,
		menuBottom: menuRect?.bottom ?? 0,
		menuSide: menu?.dataset.side,
		triggerRect: triggerRect && {
			left: triggerRect.left,
			right: triggerRect.right,
			top: triggerRect.top,
			bottom: triggerRect.bottom,
		},
		intrinsicMenuWidth,
		itemsFit,
		menuHeader: !!preview,
		rowBackground,
		rowAnimations,
		sourceHovered: sourceRow?.matches(":hover") === true,
		triggerDataState: retained.trigger?.getAttribute("data-state") ?? null,
		triggerDataSlot: retained.trigger?.getAttribute("data-slot") ?? null,
		railComputedWidth: Number.isFinite(railWidth) ? railWidth : null,
		railComputedOpacity: Number.isFinite(railOpacity) ? railOpacity : null,
		railVisible:
			!!rail?.getClientRects().length &&
			rail.getBoundingClientRect().width > 0 &&
			document.defaultView.getComputedStyle(rail).opacity === "1",
		labels: [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((node) => node.textContent.trim()),
		structure: [...(menu?.querySelectorAll('[role="menuitem"], [role="separator"]') ?? [])].map((node) =>
			node.getAttribute("role"),
		),
		itemsReady:
			!!menu &&
			[...menu.querySelectorAll('[role="menuitem"]')].every((node) => node.getAttribute("aria-disabled") !== "true"),
		titles: [...(menu?.querySelectorAll(".preview-title") ?? [])].map((node) => node.textContent),
		created: [...(menu?.querySelectorAll(".preview-created") ?? [])].map((node) => node.getAttribute("datetime")),
		contextOwners: rows.filter((node) => node.dataset.state === "open").length,
		ellipsisOwners: triggers.filter((node) => node.getAttribute("aria-expanded") === "true").length,
		sourceContextOpen: retained.source?.closest(".sidebar-preview-row")?.dataset.state === "open",
		sourceEllipsisOpen: retained.trigger?.getAttribute("aria-expanded") === "true",
		previewCount: all(".conversation-preview-card").length,
		dialogCount: all('[role="dialog"]:not(.conversation-preview-card)').length,
		focusInMenu: !!menu?.contains(document.activeElement),
		focusOnSource: document.activeElement === retained.source,
		focusOnTrigger: document.activeElement === retained.trigger,
		previousMenuConnected: retained.previousMenu?.isConnected === true,
		freshMenu: !!menu && menu !== retained.previousMenu,
	};
}

/** A matching color alone is not settlement: delayed, pending and paused transitions must fail. */
export function contextRowSurfaceSettled(value) {
	return (
		typeof value.rowBackground === "string" &&
		value.rowBackground.length > 0 &&
		Array.isArray(value.rowAnimations) &&
		value.rowAnimations.every(
			(animation) => animation.pending === false && ["finished", "idle"].includes(animation.playState),
		)
	);
}

export function contextHoverReady(value) {
	return (
		value.sourceConnected === true &&
		value.sourceHovered === true &&
		value.railVisible === true &&
		value.menuCount === 0 &&
		value.contextOwners === 0 &&
		value.ellipsisOwners === 0 &&
		contextRowSurfaceSettled(value)
	);
}

export function assertContextContinuity(value, baseline) {
	for (const field of ["route", "selected", "draft", "messages"])
		assert.deepEqual(value[field], baseline[field], `Context menu changed ${field}`);
	for (const field of [
		"samePanel",
		"sameComposer",
		"sameHistory",
		"sameMessages",
		"sameStaticRows",
		"sameStaticTriggers",
		"sameSourceRow",
		"sameSourceTrigger",
		"uniqueSource",
		"sourceConnected",
	])
		assert.equal(value[field], true, `Context menu lost retained owner: ${field}`);
	assert.equal(value.dialogCount, 0, "No action or dialog may execute during this probe");
}

export function assertContextMenuOpen(value, baseline, expected, entry) {
	assertContextContinuity(value, baseline);
	assert.ok(entry === "context" || entry === "ellipsis");
	assert.equal(value.menuCount, 1, "Exactly one menu, including stale or hidden menus");
	assert.equal(value.menuOpen, true);
	assert.equal(value.menuVisible, true);
	assert.ok(
		value.menuWidth >= (entry === "context" ? 180 : 160) - 1 &&
			value.menuWidth <= expected.viewportWidth - 12 + 1 &&
			value.menuLeft >= 5 &&
			value.menuRight <= expected.viewportWidth - 5,
		"Content-driven menu must retain its entry minimum and viewport collision bounds",
	);
	assert.equal(value.menuHeader, false, "Actions must not duplicate the standalone hover preview");
	assert.equal(value.itemsFit, true, "Menu items must remain visible without horizontal clipping");
	const preferredWidth = Math.min(
		expected.viewportWidth - 16,
		Math.max(entry === "context" ? 180 : 160, value.intrinsicMenuWidth),
	);
	assert.ok(
		Math.abs(value.menuWidth - preferredWidth) <= 2,
		"Menu width must follow independently measured content, not a fixed preview width",
	);
	assert.deepEqual(value.structure, ["menuitem", "menuitem", "separator", "menuitem"]);
	if (entry === "ellipsis") {
		assert.ok(["bottom", "top"].includes(value.menuSide), "Ellipsis anchors vertically to its trigger");
		const edge =
			value.menuSide === "bottom" ? value.menuTop - value.triggerRect.bottom : value.triggerRect.top - value.menuBottom;
		assert.ok(edge >= 0 && edge <= 3, "Dropdown keeps the reference trigger offset, including its surface margin");
		const left = Math.max(6, Math.min(value.triggerRect.left, expected.viewportWidth - value.menuWidth - 6));
		assert.ok(Math.abs(value.menuLeft - left) <= 2, "Dropdown starts at its own trigger, subject to collision shift");
	}
	assert.equal(value.sourceHovered, false, "Measure persistent menu state after leaving the row");
	assert.equal(contextRowSurfaceSettled(value), true, "Menu-open row surface must finish transitioning");
	assert.equal(value.rowBackground, expected.hoverSurface, "Menu-open row must retain the hover surface");
	assert.equal(value.railVisible, true, "Menu-open row must retain its action rail");
	assert.equal(value.menuSlot, `${entry === "context" ? "context" : "dropdown"}-menu-content`);
	assert.equal(value.previewCount, 0, "Hover preview must not coexist with the menu");
	assert.equal(value.contextOwners, entry === "context" ? 1 : 0);
	assert.equal(value.ellipsisOwners, entry === "ellipsis" ? 1 : 0);
	assert.equal(value.sourceContextOpen, entry === "context");
	assert.equal(value.sourceEllipsisOpen, entry === "ellipsis");
	assert.equal(value.focusInMenu, true, "Native menu must own focus");
	assert.equal(value.previousMenuConnected, false, "Previous entry menu must be unmounted");
	assert.equal(value.freshMenu, true, "Opening cannot reuse stale menu evidence");
	assert.equal(value.itemsReady, true, "Pin status must resolve from the runtime");
	assert.deepEqual(value.labels, expected.labels);
	assert.deepEqual(value.titles, []);
	assert.deepEqual(value.created, []);
}

export function assertContextMenuClosed(value, baseline, entry) {
	assertContextContinuity(value, baseline);
	assert.equal(value.menuCount, 0, "Escape must remove all menus, not merely hide them");
	assert.equal(value.contextOwners, 0);
	assert.equal(value.ellipsisOwners, 0);
	assert.equal(value.previousMenuConnected, false);
	assert.equal(value.previewCount, 0, "Escape must not reopen a hover preview");
	assert.equal(
		entry === "context" ? value.focusOnSource : value.focusOnTrigger,
		true,
		"Escape lost its exact source focus",
	);
}

async function pressEscape(cdp) {
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

/** Run only in the real sandboxed Electron runner, after its selected pin/history/draft baseline. */
export async function exerciseSidebarContextMenus({ cdp, seed, directory }) {
	const evidence = [];
	const revealEvidence = [];
	let failure;
	let lastObservation;
	try {
		for (const [location, scope] of [
			["pinned", seed.pins[1]],
			["recent", seed.alias],
		]) {
			assert.ok(scope, "Context menu fixture needs a noncurrent pin and an unpinned alias");
			assert.notDeepEqual(scope, seed.pins[0]);
			const selector = `.${location === "pinned" ? "pinned" : "recent"}-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
			const conversation = seed.snapshot.conversations.find(
				({ conversation: item }) =>
					item.workspaceId === scope.workspaceId && item.conversationId === scope.conversationId,
			)?.conversation;
			assert.ok(conversation && Number.isFinite(conversation.createdAt));
			await hover(cdp, ".app-toolbar");
			await until(() => evaluate(cdp, "!document.querySelector('.conversation-preview-card')"), "prior preview closes");
			await evaluate(
				cdp,
				`(()=>{
				const rows=[...document.querySelectorAll('.sidebar-preview-row')],triggers=[...document.querySelectorAll('.conversation-actions-trigger')];
				window.__sidebarContext={panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll'),messages:[...document.querySelectorAll('[data-message-id]')],rows,triggers,staticRows:rows.filter(node=>!node.closest('[data-window-row]')),staticTriggers:triggers.filter(node=>!node.closest('[data-window-row]'))};
				return true;
			})()`,
			);
			if (location === "recent") await revealRecentConversation(cdp, scope, revealEvidence);
			await evaluate(
				cdp,
				`(()=>{
				const sources=[...document.querySelectorAll(${JSON.stringify(selector)})];
				if(sources.length!==1)throw Error('Context source must be unique');
				const source=sources[0],trigger=source.closest('.sidebar-preview-row').querySelector('.conversation-actions-trigger');
				if(!trigger)throw Error('Missing source ellipsis');
				Object.assign(window.__sidebarContext,{source,sourceSelector:${JSON.stringify(selector)},sourceRow:source.closest('.sidebar-preview-row'),trigger});
				return true;
			})()`,
			);
			const read = async () => {
				const value = await evaluate(cdp, `(${contextMenuState.toString()})(document,window.__sidebarContext)`);
				lastObservation = { location, scope, ...value };
				return value;
			};
			const baseline = await read();
			assert.equal(baseline.menuCount, 0, "Reject an already open or stale menu before input");
			assert.deepEqual(baseline.selected, [{ ...seed.pins[0], location: "pinned" }]);
			assert.equal(baseline.draft, seed.draft);
			assert.equal(baseline.messages.length, 2);
			assertContextContinuity(baseline, baseline);
			const english = await evaluate(cdp, "document.documentElement.lang.startsWith('en')");
			const expected = {
				viewportWidth: await evaluate(cdp, "innerWidth"),
				hoverSurface: "",
				labels: english
					? [
							"Rename conversation",
							location === "pinned" ? "Unpin conversation" : "Pin conversation",
							"Archive conversation",
						]
					: ["重命名会话", location === "pinned" ? "取消固定会话" : "固定会话", "归档会话"],
			};
			let contextLabels;
			let hoverSample;
			for (const entry of ["context", "ellipsis"]) {
				if (entry === "context") {
					const sourcePoint = () =>
						evaluate(
							cdp,
							`(()=>{
						const node=window.__sidebarContext.source;
						const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
						return r.width>0&&r.height>0&&node.contains(document.elementFromPoint(x,y))?{x,y}:null;
					})()`,
						);
					const point = await until(sourcePoint, "unobstructed noncurrent context source");
					await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
					await evaluate(
						cdp,
						"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
					);
					const settledPoint = await until(sourcePoint, "context source after hover actions reveal");
					// Two frames reveal layout, but do not finish the row's 120ms background transition.
					hoverSample = await until(async () => {
						const value = await read();
						assertContextContinuity(value, baseline);
						return contextHoverReady(value) && value;
					}, "native hovered source surface finishes transitioning");
					expected.hoverSurface = hoverSample.rowBackground;
					for (const type of ["mousePressed", "mouseReleased"])
						await cdp.request("Input.dispatchMouseEvent", { type, ...settledPoint, button: "right", clickCount: 1 });
				} else {
					const pointFor = (target) =>
						evaluate(cdp, `(${retainedTargetPoint.toString()})(document,window.__sidebarContext.${target})`);
					const sourcePoint = await until(() => pointFor("source"), "retained source remains visible after Escape");
					await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...sourcePoint });
					const triggerPoint = await until(() => pointFor("trigger"), "unobstructed exact retained ellipsis");
					assertContextContinuity(await read(), baseline);
					await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...triggerPoint });
					const settledPoint = await until(() => pointFor("trigger"), "retained ellipsis after native hover");
					assertContextContinuity(await read(), baseline);
					for (const type of ["mousePressed", "mouseReleased"])
						await cdp.request("Input.dispatchMouseEvent", { type, ...settledPoint, button: "left", clickCount: 1 });
				}
				await until(async () => {
					const value = await read();
					return (
						value.menuCount > 0 &&
						value.menuOpen &&
						value.menuVisible &&
						value.focusInMenu &&
						value.itemsReady &&
						value.previewCount === 0
					);
				}, `${entry} runtime menu ready`);
				await hover(cdp, '[role="menu"]');
				await until(async () => {
					const value = await read();
					return (
						!value.sourceHovered &&
						value.railVisible &&
						contextRowSurfaceSettled(value) &&
						value.menuWidth >= (entry === "context" ? 180 : 160) - 1
					);
				}, `${entry} menu geometry and retained rail settle`);
				const opened = await read();
				const observation = { location, scope, entry, hoverSample, opened };
				evidence.push(observation);
				assertContextMenuOpen(opened, baseline, expected, entry);
				if (entry === "context") contextLabels = opened.labels;
				else assert.deepEqual(opened.labels, contextLabels, "Both native entries expose exactly the same actions");
				await capture(cdp, directory, `sidebar-${location}-${entry}-menu`);
				await evaluate(cdp, "window.__sidebarContext.previousMenu=document.querySelector('[role=menu]');true");
				await pressEscape(cdp);
				await until(async () => {
					const value = await read();
					return value.menuCount === 0 && (entry === "context" ? value.focusOnSource : value.focusOnTrigger);
				}, `${entry} Escape restores exact retained source`);
				const closed = await read();
				observation.closed = closed;
				assertContextMenuClosed(closed, baseline, entry);
			}
		}
		return {
			nativeInput: true,
			evidence,
			revealEvidence,
			keyboardContextMenu: {
				verified: false,
				reason: "Shift+F10 requires platform-specific native validation; no synthetic fallback is used.",
			},
		};
	} catch (error) {
		failure = error.message;
		throw error;
	} finally {
		await writeFile(
			join(directory, "sidebar-context-menus.json"),
			`${JSON.stringify({ evidence, revealEvidence, failure, lastObservation }, null, 2)}\n`,
		);
		await evaluate(cdp, "delete window.__sidebarContext");
	}
}
