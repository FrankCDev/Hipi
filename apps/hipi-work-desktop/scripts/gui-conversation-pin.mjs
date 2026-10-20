import assert from "node:assert/strict";
import { capture, click, evaluate, hover, until } from "./gui-flow.mjs";

export function assertPinState(state, scope, pinned) {
	assert.equal(state.workspaces, 2, "Pin cannot create or remove a workspace");
	assert.equal(
		state.canonical.length,
		pinned ? 0 : 1,
		"Pinned conversations must be excluded from project and Recent lists",
	);
	for (const row of state.canonical) {
		assert.equal(row.workspaceId, scope.workspaceId);
		assert.equal(row.conversationId, scope.conversationId);
		assert.equal(row.current, true);
	}
	assert.equal(state.pinned.length, pinned ? 1 : 0);
	for (const row of state.pinned) {
		assert.equal(row.workspaceId, scope.workspaceId);
		assert.equal(row.conversationId, scope.conversationId);
		assert.equal(row.current, true);
	}
}

export async function exerciseConversationPin(cdp, directory, scope, title, reopened) {
	for (const value of Object.values(scope)) assert.match(value, /^[A-Za-z0-9_-]{1,128}$/);
	const read = () =>
		evaluate(
			cdp,
			`(() => {
		const rows = selector => [...document.querySelectorAll(selector)].map(e => ({
			workspaceId:e.dataset.workspaceId,conversationId:e.dataset.conversationId,current:e.getAttribute('aria-current')==='page'
		}));
		return {workspaces:document.querySelectorAll('.workspace-branch').length,
			canonical:rows('.workspace-branch .conversation-link'),pinned:rows('.pinned-conversations .conversation-link')};
	})()`,
		);
	await until(
		async () => {
			const state = await read();
			try {
				assertPinState(state, scope, reopened);
				return true;
			} catch {
				return false;
			}
		},
		reopened
			? "cold restart retains only the exact canonical pinned row"
			: "original canonical conversation has no pin",
	);
	assert.equal(
		await evaluate(
			cdp,
			`(() => {
		const selectors=['.conversation-panel','.message-scroll','.composer textarea'];
		const nodes=selectors.map(s=>document.querySelector(s));
		if(nodes.some(n=>!n?.isConnected))return false;
		window.__hipiPinContinuity={nodes,draft:nodes[2].value,ids:[...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId)};
		return true;
	})()`,
		),
		true,
	);
	try {
		const pinnedRow = `.pinned-conversations [data-pinned-conversation][data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
		const header = `header button[aria-label=${JSON.stringify(`Conversation actions: ${title}`)}]`;
		if (reopened) {
			await capture(cdp, directory, "conversation-pin-reopened");
			await hover(cdp, `${pinnedRow} .conversation-link`);
			await click(cdp, `${pinnedRow} .conversation-actions-trigger`);
		} else await click(cdp, header);
		await click(
			cdp,
			'[role="menuitem"][data-action="pin-conversation"]:not([aria-disabled="true"])',
			reopened ? "Unpin conversation" : "Pin conversation",
		);
		await until(
			async () => {
				const state = await read();
				try {
					assertPinState(state, scope, !reopened);
				} catch {
					return false;
				}
				return evaluate(
					cdp,
					`!document.querySelector('[role="menu"]') && document.activeElement === document.querySelector(${JSON.stringify(reopened ? `.workspace-branch .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]` : header)})`,
				);
			},
			reopened
				? "unpin removes only shortcut and restores exact canonical row focus"
				: "pin persists shortcut and restores exact header opener",
		);
		assert.equal(
			await evaluate(
				cdp,
				`(() => {
			const before=window.__hipiPinContinuity;
			const nodes=['.conversation-panel','.message-scroll','.composer textarea'].map(s=>document.querySelector(s));
			return nodes.every((n,i)=>n===before.nodes[i]&&n.isConnected) && nodes[2].value===before.draft &&
				JSON.stringify([...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId))===JSON.stringify(before.ids);
		})()`,
			),
			true,
			"Pin/unpin must retain actual composer/history DOM and persisted message IDs",
		);
		await capture(cdp, directory, reopened ? "conversation-unpinned" : "conversation-pinned");
		return {
			scope,
			pinned: !reopened,
			coldPinObserved: reopened,
			canonicalIdentityPreserved: true,
			domAndDraftRetained: true,
			exactFocus: true,
		};
	} finally {
		await evaluate(cdp, "delete window.__hipiPinContinuity");
	}
}
