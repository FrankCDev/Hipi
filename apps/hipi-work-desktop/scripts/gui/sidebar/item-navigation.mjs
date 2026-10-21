import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { click, evaluate, hover, until } from "../../gui-flow.mjs";
import { nativeKeyEvents, sidebarTraversalKeyEvents } from "./native-key.mjs";

/** Independent supported-row observer, not the production opt-in marker selector. */
export function sidebarKeyboardState(document) {
	const visible = (node) =>
		node.isConnected &&
		!node.closest('[hidden],[inert],[aria-hidden="true"]') &&
		!node.matches(':disabled,[aria-disabled="true"],[aria-haspopup]:not([aria-haspopup="false"])') &&
		node.getClientRects().length > 0 &&
		document.defaultView.getComputedStyle(node).visibility !== "hidden";
	const rows = [...document.querySelectorAll(".sidebar .project-open,.sidebar .conversation-link")]
		.filter(visible)
		.map((node) => {
			const chat = node.classList.contains("conversation-link");
			const workspaceId = chat ? node.dataset.workspaceId : node.closest(".workspace-branch").dataset.workspaceId;
			const identity = chat
				? {
						kind: "conversation",
						workspaceId,
						conversationId: node.dataset.conversationId,
						location: node.dataset.sidebarLocation,
						projectId: node.dataset.sidebarLocationProject ?? null,
					}
				: { kind: "project", workspaceId, projectId: node.closest(".workspace-branch").dataset.projectId ?? null };
			const attr = (name, value) => `[${name}="${document.defaultView.CSS.escape(value)}"]`;
			const selector = chat
				? ".sidebar .conversation-link" +
					attr("data-workspace-id", workspaceId) +
					attr("data-conversation-id", identity.conversationId) +
					attr("data-sidebar-location", identity.location) +
					(identity.projectId ? attr("data-sidebar-location-project", identity.projectId) : "")
				: ".sidebar .workspace-branch" +
					attr("data-workspace-id", workspaceId) +
					(identity.projectId ? attr("data-project-id", identity.projectId) : "") +
					" .project-open";
			return { identity, selector, current: node.getAttribute("aria-current") === "page" };
		});
	return {
		rows,
		selected: rows.filter((row) => row.current).map((row) => row.identity),
		surface: document.querySelector(".conversation-panel .composer textarea")
			? "conversation"
			: document.querySelector(".prepared-task-input")
				? "project"
				: null,
		draft: document.querySelector(".composer textarea")?.value ?? null,
		messages: [...document.querySelectorAll("[data-message-id]")].map((node) => ({
			id: node.dataset.messageId,
			text: node.textContent,
		})),
		menuCount: document.querySelectorAll('[role="menu"]').length,
		focusInMenu: !!document.querySelector('[role="menu"]')?.contains(document.activeElement),
	};
}

/** Captures trusted renderer delivery only. It never dispatches or cancels input. */
export function observeSidebarKeyboard(window) {
	const events = [];
	const listener = (event) => {
		if (!["[", "]", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
		events.push({
			key: event.key,
			repeat: event.repeat,
			trusted: event.isTrusted,
			alt: event.altKey,
			ctrl: event.ctrlKey,
			meta: event.metaKey,
			shift: event.shiftKey,
		});
	};
	window.addEventListener("keydown", listener, true);
	return { events, stop: () => window.removeEventListener("keydown", listener, true) };
}

export function assertSidebarKeyboardDelivery(events, key, repeats, platform) {
	assert.deepEqual(
		events,
		Array.from({ length: repeats + 1 }, (_, index) => ({
			key,
			repeat: index > 0,
			trusted: true,
			alt: true,
			ctrl: platform !== "darwin",
			meta: platform === "darwin",
			shift: false,
		})),
		"Every requested renderer keydown must arrive with exact modifiers and repeat state",
	);
}
export function assertSidebarKeyboardSelection(value, expected) {
	assert.deepEqual(value.selected, [expected], "Exactly one canonical sidebar location must own selection");
	assert.equal(value.surface, expected.kind, "The selected destination must render its matching surface");
}
export function assertSidebarKeyboardRestored(value, baseline) {
	for (const field of ["selected", "surface", "draft", "messages"])
		assert.deepEqual(value[field], baseline[field], `Keyboard navigation lost ${field}`);
}

/** Setup only: scrolling a mounted row can mount later rows before the tested chord. */
export async function prepareSidebarKeyboardBoundary({ read, select, boundary, limit }) {
	assert.ok(boundary === "first" || boundary === "last");
	assert.ok(Number.isSafeInteger(limit) && limit > 0);
	for (let attempt = 0; attempt < limit; attempt++) {
		const before = await read();
		const target = boundary === "first" ? before.rows[0] : before.rows.at(-1);
		assert.ok(target, "Boundary setup requires a mounted row");
		await select(target);
		const settled = await read();
		const terminal = boundary === "first" ? settled.rows[0] : settled.rows.at(-1);
		if (JSON.stringify(terminal?.identity) !== JSON.stringify(target.identity)) continue;
		assertSidebarKeyboardSelection(settled, target.identity);
		return { target, before: settled, setupSelections: attempt + 1 };
	}
	throw new Error("Keyboard boundary setup did not stabilize within the bounded fixture; no boundary chord was tested");
}

/** Called before the existing same-node continuity baseline, since routes intentionally change. */
export async function exerciseSidebarKeyboard({ cdp, seed, directory }) {
	const evidence = [];
	const limits = {
		physicalOsAccelerators: {
			qualified: false,
			reason: "CDP trusted renderer input does not prove physical OS accelerator routing or keyboard layout behavior.",
		},
		physicalIme: {
			qualified: false,
			reason: "No physical IME composition is exercised; no synthetic composition evidence is substituted.",
		},
		virtualUnmountedRows: {
			qualified: false,
			reason: "This bounded fixture covers mounted rows only, not virtual loading.",
		},
	};
	let failure;
	limits.intermediatePaneScope = {
		qualified: false,
		reason:
			"Intermediate destinations prove exact sidebar identity and surface type/history count, not an independent pane scope identifier. Origin restoration compares exact persisted message IDs, text and draft.",
	};
	let rendererTraversalQualified = false;
	const read = () => evaluate(cdp, `(${sidebarKeyboardState.toString()})(document)`);
	const settle = () =>
		evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
	const clearHover = async () => {
		await hover(cdp, ".app-toolbar");
		await until(
			() => evaluate(cdp, '!document.querySelector(".conversation-preview-card")'),
			"keyboard hover overlay closes",
		);
	};
	const chord = async (key, repeats = 0) => {
		const start = await evaluate(cdp, "window.__sidebarKeyboard.events.length");
		for (const event of sidebarTraversalKeyEvents(key, repeats)) await cdp.request("Input.dispatchKeyEvent", event);
		await settle();
		const events = await evaluate(cdp, `window.__sidebarKeyboard.events.slice(${start})`);
		assertSidebarKeyboardDelivery(events, key, repeats, process.platform);
		return events;
	};
	const waitSelected = (identity) =>
		until(async () => {
			const state = await read();
			const expectedHistory =
				identity.kind === "conversation" &&
				identity.workspaceId === seed.pins[0].workspaceId &&
				identity.conversationId === seed.pins[0].conversationId
					? 2
					: 0;
			return (
				JSON.stringify(state.selected) === JSON.stringify([identity]) &&
				state.surface === identity.kind &&
				state.messages.length === expectedHistory &&
				state
			);
		}, "exact keyboard destination");
	await evaluate(cdp, `void(window.__sidebarKeyboard=(${observeSidebarKeyboard.toString()})(window))`);
	try {
		await clearHover();
		const baseline = await read();
		const origin = baseline.rows.find((row) => row.current);
		assert.ok(origin);
		assert.deepEqual(origin.identity, { kind: "conversation", ...seed.pins[0], location: "pinned", projectId: null });
		assert.equal(baseline.draft, seed.draft);
		assert.equal(baseline.messages.length, 2);
		const waitRestored = async () => {
			await until(async () => {
				const state = await read();
				return (
					JSON.stringify(state.selected) === JSON.stringify(baseline.selected) &&
					state.draft === baseline.draft &&
					JSON.stringify(state.messages) === JSON.stringify(baseline.messages) &&
					state
				);
			}, "keyboard origin restores draft and exact persisted history");
			assertSidebarKeyboardRestored(await read(), baseline);
		};
		const restore = async () => {
			await click(cdp, origin.selector);
			await clearHover();
			await waitRestored();
		};
		for (const [next, previous] of [
			["]", "["],
			["ArrowRight", "ArrowLeft"],
		]) {
			await restore();
			// Native click focuses the actual editor and resets any prior sequence.
			await click(cdp, ".composer textarea");
			const before = await read();
			const index = before.rows.findIndex((row) => row.current);
			const destination = before.rows[index + 1];
			assert.ok(destination, "Fixture needs an adjacent item after the seed pin");
			const forward = await chord(next);
			assertSidebarKeyboardSelection(await waitSelected(destination.identity), destination.identity);
			const backward = await chord(previous);
			assertSidebarKeyboardSelection(await waitSelected(origin.identity), origin.identity);
			await waitRestored();
			evidence.push({
				case: "primary or alternate round trip from composer",
				next,
				previous,
				forward,
				backward,
				destination: destination.identity,
			});
		}
		await restore();
		const projectRows = (await read()).rows;
		const projectIndex = projectRows.findIndex((row) => row.identity.kind === "project");
		assert.ok(projectIndex > 0, "Fixture must expose a real project after another eligible row");
		await click(cdp, projectRows[projectIndex - 1].selector);
		await clearHover();
		await waitSelected(projectRows[projectIndex - 1].identity);
		const intoProject = await chord("ArrowRight");
		assertSidebarKeyboardSelection(
			await waitSelected(projectRows[projectIndex].identity),
			projectRows[projectIndex].identity,
		);
		const outOfProject = await chord("ArrowLeft");
		assertSidebarKeyboardSelection(
			await waitSelected(projectRows[projectIndex - 1].identity),
			projectRows[projectIndex - 1].identity,
		);
		evidence.push({
			case: "project and conversation share traversal order",
			intoProject,
			outOfProject,
			project: projectRows[projectIndex].identity,
		});
		// Rapid repeated keydowns are delivered without intermediate keyup or polling.
		await restore();
		await click(cdp, ".composer textarea");
		const repeated = await read();
		const start = repeated.rows.findIndex((row) => row.current);
		assert.ok(repeated.rows[start + 2]);
		const repeatEvents = await chord("ArrowRight", 1);
		assertSidebarKeyboardSelection(
			await waitSelected(repeated.rows[start + 2].identity),
			repeated.rows[start + 2].identity,
		);
		evidence.push({
			case: "continuous CDP repeat",
			events: repeatEvents,
			destination: repeated.rows[start + 2].identity,
		});
		for (const [boundary, key] of [
			["first", "["],
			["last", "]"],
		]) {
			await restore();
			const { target, before, setupSelections } = await prepareSidebarKeyboardBoundary({
				read,
				select: async (row) => {
					await click(cdp, row.selector);
					await clearHover();
					await waitSelected(row.identity);
					await settle();
				},
				boundary,
				limit: seed.snapshot.conversations.length * 2 + seed.workspaceIds.length,
			});
			const events = await chord(key);
			assertSidebarKeyboardRestored(await read(), before);
			evidence.push({
				case: `${boundary} mounted boundary does not wrap`,
				setupSelections,
				events,
				identity: target.identity,
			});
		}
		await restore();
		const menuScope = seed.pins[1];
		const menuTrigger = `.pinned-conversations .sidebar-preview-row:has(.conversation-link[data-workspace-id="${menuScope.workspaceId}"][data-conversation-id="${menuScope.conversationId}"]) .conversation-actions-trigger`;
		await click(cdp, menuTrigger);
		await until(async () => {
			const state = await read();
			return state.menuCount === 1 && state.focusInMenu;
		}, "menu owns keyboard input");
		const menuEvents = await chord("ArrowRight");
		const blocked = await read();
		assertSidebarKeyboardRestored(blocked, baseline);
		assert.equal(blocked.menuCount, 1);
		assert.equal(blocked.focusInMenu, true);
		for (const event of nativeKeyEvents("Escape")) await cdp.request("Input.dispatchKeyEvent", event);
		await until(async () => (await read()).menuCount === 0, "keyboard menu closes normally");
		evidence.push({ case: "menu owns shortcut without route or draft change", events: menuEvents });
		await restore();
		rendererTraversalQualified = true;
		return { rendererTraversalQualified, evidence, limits };
	} catch (error) {
		failure = error.message;
		throw error;
	} finally {
		await writeFile(
			join(directory, "sidebar-keyboard-navigation.json"),
			`${JSON.stringify({ rendererTraversalQualified, evidence, limits, failure }, null, 2)}\n`,
		);
		await evaluate(cdp, "window.__sidebarKeyboard?.stop();delete window.__sidebarKeyboard");
	}
}
