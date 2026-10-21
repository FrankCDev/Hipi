import assert from "node:assert/strict";
import { evaluate, until } from "../../gui-flow.mjs";

/** Read only: an unmounted virtual row is not a missing conversation. */
export function recentTargetState(document, scope) {
	const viewport = document.querySelector(".navigation-list");
	if (!viewport) return null;
	const rect = viewport.getBoundingClientRect();
	const top = rect.top + viewport.clientTop;
	const bottom = top + viewport.clientHeight;
	const rows = [...document.querySelectorAll(".recent-conversations .conversation-link")];
	const targets = rows.filter(
		(node) => node.dataset.workspaceId === scope.workspaceId && node.dataset.conversationId === scope.conversationId,
	);
	const node = targets.length === 1 ? targets[0] : null;
	const box = node?.getBoundingClientRect();
	const x = box && box.x + box.width / 2;
	const y = box && box.y + box.height / 2;
	return {
		expanded:
			document
				.querySelector('[data-sidebar-section="recent"] .sidebar-section-toggle')
				?.getAttribute("aria-expanded") === "true",
		matches: targets.length,
		mounted: rows.map((row) => ({ workspaceId: row.dataset.workspaceId, conversationId: row.dataset.conversationId })),
		point:
			node?.isConnected &&
			!node.disabled &&
			box.width > 0 &&
			box.height > 0 &&
			y > top &&
			y < bottom &&
			node.contains(document.elementFromPoint(x, y))
				? { x, y }
				: null,
		scrollTop: viewport.scrollTop,
		maxScroll: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
		height: viewport.clientHeight,
		wheelPoint: { x: rect.left + viewport.clientLeft + viewport.clientWidth / 2, y: (top + bottom) / 2 },
	};
}

/** Search the bounded fixture with real wheel input, without selecting or focusing a row. */
export async function revealRecentConversation(cdp, scope, evidence) {
	const observation = {
		step: "native Recent target search",
		scope: { workspaceId: scope.workspaceId, conversationId: scope.conversationId },
		observations: [],
	};
	evidence.push(observation);
	let direction = -1;
	const target = await until(async () => {
		const state = await evaluate(cdp, `(${recentTargetState.toString()})(document,${JSON.stringify(scope)})`);
		observation.observations.push(state);
		assert.ok(state?.expanded, "New chat navigation requires its already-expanded Recent section");
		assert.ok(state.matches <= 1, "Recent target must have exactly one canonical owner");
		if (state.point) return state.point;
		if (state.scrollTop <= 1) direction = 1;
		assert.ok(
			direction < 0 || state.scrollTop < state.maxScroll - 1,
			"Exact Recent target was not reachable after native scrolling through the loaded fixture",
		);
		const deltaY = direction * Math.max(1, Math.floor(state.height / 2));
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...state.wheelPoint });
		await cdp.request("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			...state.wheelPoint,
			deltaX: 0,
			deltaY,
		});
		await evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
		return false;
	}, "exact Recent target becomes visible through native scrolling");
	return target;
}

export async function openRecentConversation(cdp, scope, evidence) {
	const target = await revealRecentConversation(cdp, scope, evidence);
	for (const type of ["mousePressed", "mouseReleased"])
		await cdp.request("Input.dispatchMouseEvent", { type, ...target, button: "left", clickCount: 1 });
	await until(
		() =>
			evaluate(
				cdp,
				`(()=>{
			const selected=[...document.querySelectorAll('.conversation-link[aria-current="page"]')];
			return selected.length===1 && selected[0].dataset.workspaceId===${JSON.stringify(scope.workspaceId)} &&
				selected[0].dataset.conversationId===${JSON.stringify(scope.conversationId)} &&
				selected[0].dataset.sidebarLocation==='recent' && !!document.querySelector('.conversation-panel .composer textarea');
		})()`,
			),
		"exact Recent conversation owns selection and composer",
	);
}
