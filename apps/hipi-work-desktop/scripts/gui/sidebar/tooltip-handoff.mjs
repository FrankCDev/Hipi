import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, evaluate, hover, until } from "../../gui-flow.mjs";
import { nativeKeyEvents } from "./native-key.mjs";

export function sidebarTooltipOwners(document) {
	const owners = {
		home: document.querySelector(".prepared-task-input"),
		composer: document.querySelector(".composer textarea"),
		panel: document.querySelector(".conversation-panel"),
	};
	if (!owners.home?.isConnected && !(owners.composer?.isConnected && owners.panel?.isConnected))
		throw Error("Tooltip journey requires an actual mounted content owner");
	return owners;
}

export function sidebarTooltipOwnersRetained(document, owners) {
	return (
		(owners.home?.isConnected || (owners.composer?.isConnected && owners.panel?.isConnected)) === true &&
		owners.home === document.querySelector(".prepared-task-input") &&
		owners.composer === document.querySelector(".composer textarea") &&
		owners.panel === document.querySelector(".conversation-panel")
	);
}

/** Read-only state; browser focus-visible and actual tooltip ownership are evidence. */
export function sidebarTooltipState(document) {
	const control = (selector) => {
		const nodes = document.querySelectorAll(selector);
		if (nodes.length !== 1) throw Error(`Expected one tooltip control: ${selector}`);
		const node = nodes[0],
			rect = node.getBoundingClientRect();
		return {
			label: node.getAttribute("aria-label"),
			focused: document.activeElement === node,
			focusVisible: node.matches(":focus-visible"),
			hovered: node.matches(":hover"),
			box: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom },
			expanded: node.getAttribute("aria-expanded"),
			tooltipState: node.getAttribute("data-tooltip-state"),
		};
	};
	return {
		viewport: { width: document.defaultView.innerWidth, height: document.defaultView.innerHeight },
		collapse: control(".sidebar-collapse"),
		toggle: control(".navigation-toggle"),
		tooltips: [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((node) => ({
			label: node.querySelector(":scope > span:not([role])")?.textContent ?? node.textContent,
			state: node.getAttribute("data-state"),
			box: (() => {
				const r = node.getBoundingClientRect();
				return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
			})(),
		})),
	};
}

/** Bounded read-only chronology for keyboard handoff, including browser scroll
 * that can retire a public tooltip without changing focused element identity. */
export function observeTooltipLifecycle(document, read) {
	const view = document.defaultView;
	const started = view.performance.now();
	const events = [];
	let dropped = 0;
	const describe = (node) => {
		const element = node === document ? document.scrollingElement : node;
		return {
			tag: node?.nodeName ?? null,
			class: element?.getAttribute?.("class") ?? null,
			scrollLeft: element?.scrollLeft ?? null,
			scrollTop: element?.scrollTop ?? null,
			containsCollapse: !!node?.contains?.(document.querySelector(".sidebar-collapse")),
			containsToggle: !!node?.contains?.(document.querySelector(".navigation-toggle")),
		};
	};
	const append = (entry) => {
		if (events.length >= 256) {
			dropped++;
			return;
		}
		events.push({ elapsed: view.performance.now() - started, ...entry, state: read(document) });
	};
	const input = (event) =>
		append({
			type: event.type,
			trusted: event.isTrusted,
			key: event.key ?? null,
			target: describe(event.target),
			relatedTarget: describe(event.relatedTarget),
		});
	const types = ["focusin", "focusout", "keydown", "keyup", "scroll"];
	for (const type of types) document.addEventListener(type, input, true);
	const relevant = '.sidebar-collapse,.navigation-toggle,[data-slot="tooltip-content"]';
	const mutations = (records) => {
		for (const record of records) {
			if (record.type === "attributes" && record.target.matches(relevant))
				append({
					type: "attribute",
					target: describe(record.target),
					attribute: record.attributeName,
					oldValue: record.oldValue,
					value: record.target.getAttribute(record.attributeName),
				});
			if (record.type === "childList")
				for (const [change, nodes] of [
					["added", record.addedNodes],
					["removed", record.removedNodes],
				])
					for (const node of nodes)
						if (node.matches?.(relevant) || node.querySelector?.(relevant))
							append({ type: "content", change, target: describe(node) });
		}
	};
	const observer = new view.MutationObserver(mutations);
	observer.observe(document.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeOldValue: true,
		attributeFilter: ["data-tooltip-state", "data-state", "aria-expanded"],
	});
	append({ type: "start" });
	return {
		stop: () => {
			mutations(observer.takeRecords());
			observer.disconnect();
			for (const type of types) document.removeEventListener(type, input, true);
			return { events, dropped, final: read(document), surface: describe(document.querySelector(".sidebar-surface")) };
		},
	};
}

/** The last move goes beyond both measured boxes AND the previous leave point's
 * padded grace hull. Separate input frames let the public tooltip subscribe to
 * its normal document pointer tracking; no timing/closing rule is replaced. */
export function tooltipExitPath(state, owner) {
	assert.ok(
		Number.isFinite(state.viewport?.width) &&
			state.viewport.width > 0 &&
			Number.isFinite(state.viewport?.height) &&
			state.viewport.height > 0,
		"Pointer exit needs the actual viewport",
	);
	const trigger = state[owner]?.box;
	const tips = state.tooltips.filter((tip) => tip.state !== "closed" && tip.label === state[owner]?.label);
	assert.equal(tips.length, 1, "Pointer exit needs the actual open tooltip owner");
	const boxes = [trigger, tips[0].box];
	for (const box of boxes)
		assert.ok(
			box && Object.values(box).every(Number.isFinite) && box.right > box.x && box.bottom > box.y,
			"Pointer exit needs nonempty measured rectangles",
		);
	const union = {
		x: Math.min(...boxes.map((box) => box.x)),
		y: Math.min(...boxes.map((box) => box.y)),
		right: Math.max(...boxes.map((box) => box.right)),
		bottom: Math.max(...boxes.map((box) => box.bottom)),
	};
	const start = { x: Math.round((trigger.x + trigger.right) / 2), y: Math.round((trigger.y + trigger.bottom) / 2) };
	const directions = [
		{ axis: "x", sign: 1, edge: union.right, room: state.viewport.width - union.right },
		{ axis: "x", sign: -1, edge: union.x, room: union.x },
		{ axis: "y", sign: 1, edge: union.bottom, room: state.viewport.height - union.bottom },
		{ axis: "y", sign: -1, edge: union.y, room: union.y },
	].sort((a, b) => b.room - a.room);
	const direction = directions[0];
	assert.ok(direction.room > 32, "Measured tooltip must have room for a continuous outside path");
	const roundOutside = direction.sign > 0 ? Math.ceil : Math.floor;
	const outside = { ...start, [direction.axis]: roundOutside(direction.edge + direction.sign * 12) };
	return [
		...[1 / 3, 2 / 3, 1].map((fraction) => ({
			x: start.x + (outside.x - start.x) * fraction,
			y: start.y + (outside.y - start.y) * fraction,
		})),
		{ ...outside, [direction.axis]: roundOutside(direction.edge + direction.sign * 28) },
	];
}

export function observeTooltipPointer(document) {
	const events = [];
	let pointer = null;
	const observe = (event) => {
		pointer = { x: event.clientX, y: event.clientY };
		if (events.length < 128)
			events.push({
				type: event.type,
				trusted: event.isTrusted,
				...pointer,
				target: event.target?.getAttribute?.("class") ?? null,
			});
	};
	const types = ["pointermove", "pointerout", "pointerleave"];
	for (const type of types) document.addEventListener(type, observe, true);
	return {
		stop: () => {
			for (const type of types) document.removeEventListener(type, observe, true);
			return { pointer, events };
		},
	};
}

export function assertTooltipPointerExit(entry) {
	assert.deepEqual(entry.input.pointer, entry.path.at(-1), "Actual final pointer must match the measured outside path");
	assert.ok(
		entry.input.events.filter((event) => event.type === "pointermove").length >= 2 &&
			entry.input.events.every((event) => event.trusted),
		"Continuous exit requires multiple trusted pointer moves",
	);
	assert.equal(entry.final.toggle.focused, true, "Pointer exit must retain the restored trigger focus");
	assert.equal(entry.final.toggle.focusVisible, false, "Pointer exit must not change input modality");
	assert.equal(entry.final.toggle.hovered, false, "Final pointer must leave the trigger");
	assert.equal(entry.final.tooltips.length, 0, "Continuous pointer exit must actually close the hint");
}

async function leaveTooltip(cdp, read, evidence) {
	const entry = { before: await read(), steps: [] };
	evidence.pointerExit = entry;
	entry.path = tooltipExitPath(entry.before, "toggle");
	await evaluate(cdp, `void(window.__sidebarTooltipPointer=(${observeTooltipPointer.toString()})(document))`);
	try {
		for (const point of entry.path) {
			await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
			await evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
			entry.steps.push({ point, state: await read() });
		}
		await until(async () => (await read()).tooltips.length === 0, "fresh hover closes after pointer leaves");
	} finally {
		entry.final = await read();
		entry.input = await evaluate(cdp, "window.__sidebarTooltipPointer.stop()");
		await evaluate(cdp, "delete window.__sidebarTooltipPointer");
	}
	assertTooltipPointerExit(entry);
}

/** Frame observer only. CDP owns input; this does not synthesize page events. */
export function startSidebarTooltipTrace(document, observe) {
	const view = document.defaultView;
	const frames = [],
		events = [];
	let firstCollapsed,
		frame,
		pointer = null,
		stopped = false;
	const input = (event) => {
		if (event.type.startsWith("pointer")) pointer = { x: event.clientX, y: event.clientY };
		if (event.type !== "pointermove") events.push({ type: event.type, trusted: event.isTrusted });
	};
	for (const type of ["pointermove", "pointerdown", "keydown"]) document.addEventListener(type, input, true);
	const sample = (time) => {
		if (stopped) return;
		const state = observe(document);
		if (state.toggle.expanded === "false") firstCollapsed ??= time;
		if (firstCollapsed !== undefined) {
			frames.push({ elapsed: time - firstCollapsed, pointer, ...state });
			if (time - firstCollapsed >= 700) return;
		}
		frame = view.requestAnimationFrame(sample);
	};
	frame = view.requestAnimationFrame(sample);
	return {
		frames,
		stop: () => {
			stopped = true;
			view.cancelAnimationFrame(frame);
			for (const type of ["pointermove", "pointerdown", "keydown"]) document.removeEventListener(type, input, true);
			return { frames, events };
		},
	};
}

export function assertPointerTooltipHandoff(trace) {
	assert.ok(
		trace.frames.length >= 2 && trace.frames.at(-1).elapsed >= 700,
		"Observe beyond tooltip delay and sidebar motion",
	);
	assert.ok(
		trace.events.some((event) => event.type === "pointerdown" && event.trusted),
		"Pointer activation must be trusted renderer input",
	);
	for (const frame of trace.frames) {
		assert.equal(frame.toggle.expanded, "false");
		assert.equal(frame.toggle.focused, true, "Collapsed trigger must receive actual focus");
		assert.equal(frame.toggle.focusVisible, false, "Pointer-origin handoff must not become keyboard-visible focus");
		assert.equal(frame.toggle.hovered, false);
		const { pointer, toggle } = frame;
		assert.ok(
			pointer &&
				(pointer.x < toggle.box.x ||
					pointer.x > toggle.box.right ||
					pointer.y < toggle.box.y ||
					pointer.y > toggle.box.bottom),
			"Pointer must be outside the newly focused trigger",
		);
		// Before the collapse commit no frames qualify. After it, an already-closing
		// old hint may finish its exit, but no old/new open hint may appear. By300ms
		// (the sidebar transition duration) even closing content must be absent.
		assert.ok(
			frame.tooltips.every((tip) => tip.state === "closed" && tip.label === frame.collapse.label),
			"Pointer handoff must not open a stale or newly focused tooltip",
		);
		if (frame.elapsed >= 300)
			assert.equal(frame.tooltips.length, 0, "Closing hint must retire before the settled observation window");
	}
}

export function assertOwnedTooltip(state, owner, keyboard = false) {
	const target = state[owner];
	assert.ok(target?.label, "Tooltip must have its actual accessible owner");
	if (keyboard) {
		assert.equal(target.focused, true);
		assert.equal(target.focusVisible, true, "Keyboard hint must follow actual browser focus-visible");
	} else assert.equal(target.hovered, true);
	assert.deepEqual(
		state.tooltips.filter((tip) => tip.state !== "closed").map((tip) => tip.label),
		[target.label],
	);
}

export async function exerciseSidebarTooltipHandoff({ cdp, directory }) {
	const evidence = { input: "trusted CDP renderer input, not OS injection", states: [] };
	const read = () => evaluate(cdp, `(${sidebarTooltipState.toString()})(document)`);
	const key = async (value, modifiers = 0) => {
		for (const event of nativeKeyEvents(value, modifiers)) await cdp.request("Input.dispatchKeyEvent", event);
	};
	const waitHint = async (owner, keyboard = false) => {
		evidence.pendingHint = { owner, keyboard };
		const state = await until(async () => {
			const state = await read();
			return state.tooltips.some((tip) => tip.state !== "closed" && tip.label === state[owner].label) ? state : null;
		}, `${owner} tooltip appears through actual input`);
		assertOwnedTooltip(state, owner, keyboard);
		evidence.states.push({ owner, keyboard, state });
		delete evidence.pendingHint;
	};
	try {
		assert.equal((await read()).toggle.expanded, "true", "Tooltip journey starts with expanded desktop sidebar");
		await until(
			() =>
				evaluate(
					cdp,
					"!!document.querySelector('.prepared-task-input')?.isConnected || (!!document.querySelector('.composer textarea')?.isConnected && !!document.querySelector('.conversation-panel')?.isConnected)",
				),
			"mounted content owner before tooltip journey",
		);
		await evaluate(cdp, `void(window.__sidebarTooltipOwners=(${sidebarTooltipOwners.toString()})(document))`);
		await hover(cdp, ".sidebar-collapse");
		await waitHint("collapse");
		await evaluate(
			cdp,
			`void(window.__sidebarTooltipTrace=(${startSidebarTooltipTrace.toString()})(document,${sidebarTooltipState.toString()}))`,
		);
		const point = await evaluate(
			cdp,
			"(()=>{const r=document.querySelector('.sidebar-collapse').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
		);
		for (const type of ["mousePressed", "mouseReleased"])
			await cdp.request("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
		await hover(cdp, ".app-toolbar");
		await until(
			() => evaluate(cdp, "window.__sidebarTooltipTrace.frames.at(-1)?.elapsed>=700"),
			"pointer handoff remains quiet beyond tooltip and motion delays",
		);
		evidence.trace = await evaluate(cdp, "window.__sidebarTooltipTrace.stop()");
		await capture(cdp, directory, "sidebar-tooltip-pointer-handoff");
		assertPointerTooltipHandoff(evidence.trace);
		await hover(cdp, ".navigation-toggle");
		await waitHint("toggle");
		await capture(cdp, directory, "sidebar-tooltip-fresh-hover");
		await leaveTooltip(cdp, read, evidence);
		await evaluate(
			cdp,
			`void(window.__sidebarTooltipLifecycle=(${observeTooltipLifecycle.toString()})(document,${sidebarTooltipState.toString()}))`,
		);
		// Leave pointer-restored focus, then return with actual keyboard traversal.
		await key("Tab");
		await key("Tab", 8);
		await waitHint("toggle", true);
		await key("Enter");
		await until(async () => (await read()).toggle.expanded === "true", "keyboard activation expands sidebar");
		await waitHint("collapse", true);
		await capture(cdp, directory, "sidebar-tooltip-keyboard-handoff");
		await key("Escape");
		await hover(cdp, ".app-toolbar");
		await until(
			async () => (await read()).tooltips.length === 0,
			"keyboard hint dismissed without changing focus ownership",
		);
		assert.equal(
			await evaluate(cdp, `(${sidebarTooltipOwnersRetained.toString()})(document,window.__sidebarTooltipOwners)`),
			true,
			"Sidebar tooltip interactions must retain content owners",
		);
		return { pointerFrames: evidence.trace.frames.length, artifact: "sidebar-tooltip-handoff.json" };
	} catch (error) {
		evidence.failure = error.message;
		throw error;
	} finally {
		evidence.final = await read();
		evidence.lifecycle = await evaluate(cdp, "window.__sidebarTooltipLifecycle?.stop()");
		if (!evidence.trace) evidence.trace = await evaluate(cdp, "window.__sidebarTooltipTrace?.stop()");
		await writeFile(join(directory, "sidebar-tooltip-handoff.json"), `${JSON.stringify(evidence, null, 2)}\n`);
		await evaluate(
			cdp,
			"delete window.__sidebarTooltipTrace;delete window.__sidebarTooltipOwners;delete window.__sidebarTooltipLifecycle",
		);
	}
}
