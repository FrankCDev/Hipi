import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, click, evaluate, hover, until } from "../../gui-flow.mjs";

/** Read-only DOM evidence. Retained references never drive application state. */
export function contextMenuState(document, retained) {
	const all = (selector) => [...document.querySelectorAll(selector)];
	const menus = all('[role="menu"]');
	const menu = menus[0];
	const messages = all("[data-message-id]");
	const rows = all(".sidebar-preview-row");
	const triggers = all(".conversation-actions-trigger");
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
		sourceConnected: retained.source?.isConnected === true,
		menuCount: menus.length,
		menuOpen: menu?.dataset.state === "open",
		menuSlot: menu?.dataset.slot ?? null,
		menuVisible: !!menu?.getClientRects().length,
		labels: [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((node) => node.textContent.trim()),
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

export function assertContextContinuity(value, baseline) {
	for (const field of ["route", "selected", "draft", "messages"])
		assert.deepEqual(value[field], baseline[field], `Context menu changed ${field}`);
	for (const field of [
		"samePanel",
		"sameComposer",
		"sameHistory",
		"sameMessages",
		"sameRows",
		"sameTriggers",
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
	assert.deepEqual(value.titles, [expected.title]);
	assert.deepEqual(value.created, [expected.created]);
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
	let failure;
	try {
		for (const [location, scope] of [
			["pinned", seed.pins[1]],
			["recent", seed.alias],
		]) {
			assert.ok(scope, "Context menu fixture needs a noncurrent pin and an unpinned alias");
			assert.notDeepEqual(scope, seed.pins[0]);
			const selector = `.${location === "pinned" ? "pinned" : "recent"}-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
			const trigger = `.${location === "pinned" ? "pinned" : "recent"}-conversations .sidebar-preview-row:has(.conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]) .conversation-actions-trigger`;
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
				const sources=[...document.querySelectorAll(${JSON.stringify(selector)})];
				if(sources.length!==1)throw Error('Context source must be unique');
				const source=sources[0],trigger=source.closest('.sidebar-preview-row').querySelector('.conversation-actions-trigger');
				if(!trigger)throw Error('Missing source ellipsis');
				window.__sidebarContext={source,trigger,panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll'),messages:[...document.querySelectorAll('[data-message-id]')],rows:[...document.querySelectorAll('.sidebar-preview-row')],triggers:[...document.querySelectorAll('.conversation-actions-trigger')]};
				return true;
			})()`,
			);
			const read = () => evaluate(cdp, `(${contextMenuState.toString()})(document,window.__sidebarContext)`);
			const baseline = await read();
			assert.equal(baseline.menuCount, 0, "Reject an already open or stale menu before input");
			assert.deepEqual(baseline.selected, [{ ...seed.pins[0], location: "pinned" }]);
			assert.equal(baseline.draft, seed.draft);
			assert.equal(baseline.messages.length, 2);
			assertContextContinuity(baseline, baseline);
			const english = await evaluate(cdp, "document.documentElement.lang.startsWith('en')");
			const expected = {
				title: conversation.title,
				created: new Date(conversation.createdAt).toISOString(),
				labels: english
					? [
							location === "pinned" ? "Unpin conversation" : "Pin conversation",
							"Rename conversation",
							"Archive conversation",
						]
					: [location === "pinned" ? "取消固定会话" : "固定会话", "重命名会话", "归档会话"],
			};
			let contextLabels;
			for (const entry of ["context", "ellipsis"]) {
				if (entry === "context") {
					const sourcePoint = () =>
						evaluate(
							cdp,
							`(()=>{
						const node=window.__sidebarContext.source;node.scrollIntoView({block:'center'});
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
					for (const type of ["mousePressed", "mouseReleased"])
						await cdp.request("Input.dispatchMouseEvent", { type, ...settledPoint, button: "right", clickCount: 1 });
				} else await click(cdp, trigger);
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
				const opened = await read();
				const observation = { location, scope, entry, opened };
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
			`${JSON.stringify({ evidence, failure }, null, 2)}\n`,
		);
		await evaluate(cdp, "delete window.__sidebarContext");
	}
}
