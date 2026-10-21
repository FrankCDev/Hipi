import assert from "node:assert/strict";
import { capture, click, evaluate, pressKey, until } from "./gui-flow.mjs";
import { nativeEditorKey } from "./gui-work-experience.mjs";

export function assertSearchHit(hits, scope, messageId, phrase) {
	assert.equal(hits.length, 1, "Unique body query must resolve exactly one actual result");
	const hit = hits[0];
	assert.equal(hit.workspaceId, scope.workspaceId);
	assert.equal(hit.conversationId, scope.conversationId);
	assert.equal(hit.messageId, messageId);
	assert.equal(hit.kind, "message", "A title result cannot prove content search");
	assert.equal(hit.selected, true);
	assert.equal(hit.highlight, phrase);
}

export function searchBlockVisible(document, messageId, phrase) {
	const rows = [...document.querySelectorAll("[data-message-id]")].filter((row) => row.dataset.messageId === messageId);
	if (rows.length !== 1) return false;
	const body = rows[0].querySelector('[data-message-document-complete="true"]');
	const blocks = body?.querySelectorAll("[data-search-match][data-markdown-source-start][data-markdown-source-end]");
	if (blocks?.length !== 1 || !blocks[0].textContent.includes(phrase)) return false;
	const block = blocks[0];
	const start = Number(block.dataset.markdownSourceStart),
		end = Number(block.dataset.markdownSourceEnd);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return false;
	const rect = block.getBoundingClientRect(),
		host = document.querySelector(".message-scroll")?.getBoundingClientRect();
	return (
		!!host &&
		rect.width > 0 &&
		rect.height > 0 &&
		rect.top >= host.top - 1 &&
		rect.top < host.bottom &&
		rect.left >= host.left - 1 &&
		rect.right <= host.right + 1
	);
}

export async function exerciseConversationSearch(cdp, directory, scope) {
	for (const id of [scope.workspaceId, scope.conversationId]) assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
	const phrase = "中文流式验证",
		draft = "Native search retains this unsent draft";
	const input = '.conversation-search-input input[role="combobox"]';
	const read = (expression) => evaluate(cdp, expression);
	const check = (expression, label) => until(() => read(expression), label);
	const messageId = await read(
		`(()=>{const rows=[...document.querySelectorAll('[data-message-id]')].filter(e=>e.querySelector('.message-user')&&e.textContent.includes(${JSON.stringify(phrase)}));return rows.length===1?rows[0].dataset.messageId:null})()`,
	);
	assert.match(messageId ?? "", /^[A-Za-z0-9_-]{1,128}$/, "Exact existing user message identity is required");
	assert.equal(await read("document.querySelector('.composer textarea').value"), "");
	await click(cdp, ".composer textarea");
	await cdp.request("Input.insertText", { text: draft });
	assert.equal(await read("document.querySelector('.composer textarea').value"), draft);
	await read(
		`void (window.__hipiSearchContinuity={projectIds:[...document.querySelectorAll('.workspace-branch[data-workspace-id]')].map(e=>e.dataset.workspaceId),opener:document.querySelector('.sidebar-search-trigger'),sidebar:document.querySelector('.sidebar'),main:document.querySelector('.main-shell'),panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll'),ids:[...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId)})`,
	);
	const continuity = async (history = true) =>
		assert.equal(
			await read(
				`(()=>{const b=window.__hipiSearchContinuity;return b.sidebar===document.querySelector('.sidebar')&&b.main===document.querySelector('.main-shell')&&b.panel===document.querySelector('.conversation-panel')&&b.composer===document.querySelector('.composer textarea')&&b.history===document.querySelector('.message-scroll')&&b.composer.value===${JSON.stringify(draft)}&&JSON.stringify(b.projectIds)===JSON.stringify([...document.querySelectorAll('.workspace-branch[data-workspace-id]')].map(e=>e.dataset.workspaceId))&&${history ? "JSON.stringify(b.ids)===JSON.stringify([...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId))" : "true"}})()`,
			),
			true,
			"Search must retain app owners, unsent draft and canonical history",
		);
	const query = async () => {
		await click(cdp, ".sidebar-search-trigger");
		await check(
			`!!document.querySelector('.conversation-search-dialog[role="dialog"]')&&document.activeElement===document.querySelector(${JSON.stringify(input)})`,
			"search modal focuses actual query input",
		);
		await cdp.request("Input.insertText", { text: phrase });
		await check(
			`document.querySelector(${JSON.stringify(input)}).value===${JSON.stringify(phrase)}`,
			"native query text committed",
		);
		const hits = await until(async () => {
			const values = await read(
				`([...document.querySelectorAll('.conversation-search-result')].map(e=>({workspaceId:e.dataset.workspaceId,conversationId:e.dataset.conversationId,messageId:e.dataset.messageId,kind:e.dataset.matchKind,selected:e.getAttribute('aria-selected')==='true',highlight:[...e.querySelectorAll('mark[data-search-match]')].map(m=>m.textContent).join('')})))`,
			);
			try {
				assertSearchHit(values, scope, messageId, phrase);
				return values;
			} catch {
				return false;
			}
		}, "authoritative unique message-content search result");
		assertSearchHit(hits, scope, messageId, phrase);
		await continuity();
	};
	try {
		await query();
		await capture(cdp, directory, "conversation-content-search");
		await pressKey(cdp, "Escape");
		await check(
			"!document.querySelector('.conversation-search-dialog')&&document.activeElement===window.__hipiSearchContinuity.opener",
			"Search Escape restores exact opener",
		);
		await continuity();
		await query();
		await nativeEditorKey(cdp, "Enter");
		await check(
			`!document.querySelector('.conversation-search-dialog')&&document.querySelector('.message-scroll')?.dataset.readingMode==='search'&&document.querySelector('.recent-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]')?.getAttribute('aria-current')==='page'`,
			"actual result activation retains canonical conversation in anchored search mode",
		);
		await check(
			`(${searchBlockVisible.toString()})(document, ${JSON.stringify(messageId)}, ${JSON.stringify(phrase)})`,
			"exact message source block contains the match and is positioned in the viewport",
		);
		await continuity(false);
		await capture(cdp, directory, "conversation-content-search-anchor");
		await click(cdp, ".jump-latest");
		await check(
			"document.querySelector('.message-scroll')?.dataset.readingMode==='live'&&!document.querySelector('[data-message-document-complete] [data-search-match]')",
			"Jump to latest exits anchored reading mode",
		);
		await until(async () => {
			try {
				await continuity();
				return true;
			} catch {
				return false;
			}
		}, "live history restores unchanged canonical message IDs");
		await click(cdp, ".composer textarea");
		await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
		await nativeEditorKey(cdp, "Backspace");
		assert.equal(await read("document.querySelector('.composer textarea').value"), "");
		return {
			scope,
			messageId,
			contentMatch: true,
			escapeFocus: true,
			draftAndOwnersRetained: true,
			anchoredOriginalMatch: true,
			jumpLatest: true,
			noNewWorkspacesOrMessages: true,
			deepOldHistory: "not_run_baseline_has_one_turn",
		};
	} finally {
		await read("delete window.__hipiSearchContinuity");
	}
}
