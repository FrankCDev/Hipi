import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluate, until } from "../../gui-flow.mjs";
import { virtualizationRoleEntry } from "./virtualization-manifest.mjs";

const keyOf = ({ workspaceId, conversationId }) => JSON.stringify([workspaceId, conversationId]);
const rowSelector = (scope) =>
	`.recent-conversations [data-window-row][data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;

/** Pure DOM observation. Geometry and retained references never drive product state. */
export function virtualRecentState(document) {
	const view = document.defaultView;
	const retained = view.__virtualRecentOwners;
	const viewport = document.querySelector(".navigation-list");
	const list = document.querySelector(".recent-virtual-list");
	const region = document.querySelector(".recent-conversations [data-sidebar-query]");
	if (!viewport || !list || !region || !retained) return null;
	const v = viewport.getBoundingClientRect(),
		l = list.getBoundingClientRect();
	const top = v.top + viewport.clientTop,
		bottom = top + viewport.clientHeight;
	const rows = [...list.querySelectorAll("[data-window-row]")].map((node) => {
		const rect = node.getBoundingClientRect(),
			link = node.querySelector(".conversation-link");
		return {
			workspaceId: node.dataset.workspaceId,
			conversationId: node.dataset.conversationId,
			index: Number(node.dataset.index),
			title: link?.textContent,
			top: rect.top,
			bottom: rect.bottom,
			height: rect.height,
			connected: node.isConnected,
			links: node.querySelectorAll(".conversation-link").length,
			visible: rect.bottom > top && rect.top < bottom,
		};
	});
	const selected = [...document.querySelectorAll('.conversation-link[aria-current="page"]')].map((node) => ({
		workspaceId: node.dataset.workspaceId,
		conversationId: node.dataset.conversationId,
	}));
	const menu = document.querySelector('[role="menu"]');
	return {
		at: view.performance.now(),
		rows,
		selected,
		replay: retained.replay === true,
		focusRequired: retained.focusRequired === true,
		query: region.dataset.sidebarQuery,
		viewport: {
			top,
			bottom,
			height: viewport.clientHeight,
			left: v.left + viewport.clientLeft,
			width: viewport.clientWidth,
			gutter: viewport.offsetWidth - viewport.clientWidth - 2 * viewport.clientLeft,
			right: v.right,
			scrollTop: viewport.scrollTop,
			scrollHeight: viewport.scrollHeight,
		},
		list: {
			top: l.top,
			bottom: l.bottom,
			height: l.height,
			rowsBottom: list.querySelector(".recent-window-sentinel:last-child")?.getBoundingClientRect().top,
		},
		fetching: region.dataset.sidebarFetching === "true",
		revision: region.dataset.sidebarUpdatedAt,
		samePanel: retained.panel?.isConnected && retained.panel === document.querySelector(".conversation-panel"),
		sameComposer: retained.composer?.isConnected && retained.composer === document.querySelector(".composer textarea"),
		sameHistory: retained.history?.isConnected && retained.history === document.querySelector(".message-scroll"),
		sameIde: retained.ide === document.querySelector(".file-workbench"),
		draft: document.querySelector(".composer textarea")?.value,
		messages: [...document.querySelectorAll("[data-message-id]")].map((node) => node.dataset.messageId),
		sourceConnected: !retained.source || retained.source.isConnected,
		sourceCopies: retained.source
			? [...list.querySelectorAll(".conversation-actions-trigger")].filter((node) => node === retained.source).length
			: 0,
		focusOnSource: !!retained.source && document.activeElement === retained.source,
		focusInMenu: !!menu?.contains(document.activeElement),
		menuCount: document.querySelectorAll('[role="menu"]').length,
		menuTitle: menu?.querySelector(".preview-title")?.textContent ?? null,
		sourceExpanded: retained.source?.getAttribute("aria-expanded") === "true",
		activeConnected: document.activeElement?.isConnected === true,
		activeIsBody: document.activeElement === document.body,
	};
}

export function assertVirtualRecentFrame(state, seed) {
	assert.ok(state, "Virtual Recent must be mounted");
	for (const field of ["samePanel", "sameComposer", "sameHistory", "sameIde", "sourceConnected"])
		assert.equal(state[field], true, `Virtual scrolling lost ${field}`);
	assert.deepEqual(state.selected, [seed.active], "Scrolling cannot select another canonical conversation");
	assert.equal(state.draft, seed.draft);
	assert.deepEqual(state.messages, [], "Scrolling must never submit a turn");
	if (state.focusRequired) assert.equal(state.focusOnSource, true, "A raw scrolling frame lost real source focus");
	assert.ok(state.rows.length > 0, "Virtual list cannot become a blank spacer");
	const keys = state.rows.map(keyOf);
	assert.equal(new Set(keys).size, keys.length, "Hidden duplicates cannot stand in for interaction owners");
	const minHeight = Math.min(...state.rows.map((row) => row.height));
	assert.ok(minHeight > 0 && Number.isFinite(minHeight));
	const limit = Math.ceil(state.viewport.height / minHeight) + 16;
	assert.ok(
		state.rows.length <= limit,
		`Rendered DOM ${state.rows.length} exceeds visible rows + overscan/protected-owner bound ${limit}`,
	);
	for (const row of state.rows) {
		assert.equal(row.connected, true);
		assert.equal(row.links, 1);
		assert.ok(Number.isSafeInteger(row.index) && row.index >= 0 && row.index < seed.recent.length);
		assert.deepEqual(
			{ workspaceId: row.workspaceId, conversationId: row.conversationId, title: row.title },
			seed.recent[row.index],
			"Virtual ordinal must retain its authoritative canonical entry",
		);
	}
	assert.ok(Number.isFinite(state.list.rowsBottom));
	assert.ok(state.list.rowsBottom >= state.list.top && state.list.rowsBottom <= state.list.bottom);
	const start = Math.max(state.viewport.top, state.list.top),
		end = Math.min(state.viewport.bottom, state.list.rowsBottom);
	if (end > start + 2) {
		let covered = start;
		for (const row of state.rows.filter((row) => row.visible).sort((a, b) => a.top - b.top)) {
			if (row.bottom <= covered) continue;
			assert.ok(row.top <= covered + 2, `Blank virtual gap at ${covered} before row ${row.index}`);
			covered = Math.max(covered, row.bottom);
		}
		assert.ok(covered >= end - 2, "Visible list extent must end in real rows, not blank spacers");
	}
	return { rendered: state.rows.length, limit, minHeight };
}

export function assertRetainedVirtualExtent(state, baseline, seed) {
	assertVirtualRecentFrame(state, seed);
	assert.equal(state.fetching, false, "Revisiting loaded rows must not fetch evicted metadata");
	assert.equal(state.revision, baseline.revision, "Loaded extent replay cannot silently replace its metadata query");
	assert.ok(
		Math.abs(state.list.height - baseline.list.height) <= 1,
		"Loaded extent cannot shrink at a 250-row metadata wall",
	);
	assert.ok(
		state.list.height >= seed.recent.length * baseline.minHeight,
		"All revealed real rows must retain scroll extent",
	);
}

/** Raw rAF observer: no settling, readiness polling, layout mutation or synthetic input. */
export function startVirtualRecentTrace(document, sample) {
	const view = document.defaultView;
	const trace = { frames: [], inputs: [], truncated: false };
	let frame;
	const record = (event) =>
		trace.inputs.push({ type: event.type, trusted: event.isTrusted, at: view.performance.now() });
	const types = ["wheel", "pointerdown", "pointermove", "pointerup", "keydown"];
	for (const type of types) document.addEventListener(type, record, true);
	const tick = () => {
		trace.frames.push(sample(document));
		if (trace.frames.length === 12000) {
			trace.truncated = true;
			return;
		}
		frame = view.requestAnimationFrame(tick);
	};
	frame = view.requestAnimationFrame(tick);
	return {
		stop() {
			view.cancelAnimationFrame(frame);
			for (const type of types) document.removeEventListener(type, record, true);
			return trace;
		},
	};
}

async function frames(cdp) {
	await evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
}
async function nativeKey(cdp, key, modifiers = 0) {
	const code = { Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34 }[key];
	assert.ok(code);
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", { type, key, code: key, modifiers, windowsVirtualKeyCode: code });
}
async function nativeClick(cdp, selector) {
	const point = await until(
		() =>
			evaluate(
				cdp,
				`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];if(nodes.length!==1)return null;const node=nodes[0],r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width>0&&r.height>0&&!node.disabled&&node.contains(document.elementFromPoint(x,y))?{x,y}:null})()`,
			),
		"visible unique native target",
	);
	for (const type of ["mousePressed", "mouseReleased"])
		await cdp.request("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
}

/** Call only from the owned, sandboxed packaged lifecycle; not an allowance to launch it. */
export async function exerciseSidebarVirtualization({ cdp, directory, seed, reopened }) {
	const evidence = {
		nativeInput: true,
		checkpoints: [],
		thumb: { status: "not_run" },
		notValidated: ["native hide/minimize with unsaved rename", "massive insertion refresh"],
	};
	let failure, trace, baseline, pendingError;
	const deadline = Date.now() + 180000;
	let interactions = 0;
	const bounded = () => {
		assert.ok(
			Date.now() < deadline && ++interactions <= 700,
			"Native large-list probe exceeded its 180s/700-interaction bound",
		);
	};
	const read = () => evaluate(cdp, `(${virtualRecentState.toString()})(document)`);
	const stable = async () => {
		await frames(cdp);
		return until(
			async () => {
				const value = await read();
				return value &&
					value.query === JSON.stringify(["sidebar-window", { kind: "project_recent" }, "active"]) &&
					!value.fetching &&
					value.revision !== "0"
					? value
					: null;
			},
			"committed global Recent metadata",
			Math.max(1, Math.min(15000, deadline - Date.now())),
		);
	};
	const wheel = async (deltaY) => {
		bounded();
		const value = await read();
		await cdp.request("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: value.viewport.left + value.viewport.width / 2,
			y: value.viewport.top + value.viewport.height / 2,
			deltaX: 0,
			deltaY,
		});
		return stable();
	};
	try {
		await until(() => evaluate(cdp, "!!document.querySelector('.navigation-list')"), "native sidebar mounted");
		if (!reopened) {
			const entry = virtualizationRoleEntry(seed);
			await evaluate(
				cdp,
				`localStorage.setItem(${JSON.stringify(`hipi.work.local.v1.${seed.handshake.storeId}.value.default-chat-workspace`)},${JSON.stringify(JSON.stringify(entry))});location.reload();true`,
			);
		}
		await nativeClick(
			cdp,
			`.pinned-conversations .conversation-link[data-workspace-id="${seed.active.workspaceId}"][data-conversation-id="${seed.active.conversationId}"]`,
		);
		await until(
			() =>
				evaluate(
					cdp,
					"!!document.querySelector('.composer textarea:not(:disabled)') && !!document.querySelector('.message-scroll')",
				),
			"empty active control conversation",
		);
		await nativeClick(cdp, ".composer textarea");
		const draft = await evaluate(cdp, "document.querySelector('.composer textarea').value");
		assert.ok(draft === "" || draft === seed.draft, "Unexpected draft in owned fixture");
		if (!draft) await cdp.request("Input.insertText", { text: seed.draft });
		await evaluate(
			cdp,
			"window.__virtualRecentOwners={panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll'),ide:document.querySelector('.file-workbench')};true",
		);
		await stable();
		await evaluate(
			cdp,
			`void(window.__virtualRecentTrace=(${startVirtualRecentTrace.toString()})(document,${virtualRecentState.toString()}))`,
		);
		const seen = new Set();
		const revealed = new Set();
		let state = await read();
		for (;;) {
			assertVirtualRecentFrame(state, seed);
			for (const row of state.rows) {
				seen.add(keyOf(row));
				if (row.visible) revealed.add(keyOf(row));
			}
			if (
				seen.size === seed.recent.length &&
				revealed.size === seed.recent.length &&
				state.rows.some((row) => row.index === seed.recent.length - 1 && row.visible)
			)
				break;
			assert.ok(seen.size <= seed.recent.length);
			const before = state.viewport.scrollTop;
			state = await wheel(Math.max(120, state.viewport.height * 0.7));
			// Non-last sections intentionally require the actual Show more control.
			if (
				state.viewport.scrollTop === before &&
				(await evaluate(cdp, "!!document.querySelector('.recent-window-sentinel:last-child button')"))
			) {
				bounded();
				await nativeClick(cdp, ".recent-window-sentinel:last-child button");
				state = await stable();
			}
		}
		const measured = assertVirtualRecentFrame(state, seed);
		baseline = { revision: state.revision, list: state.list, minHeight: measured.minHeight };
		assertRetainedVirtualExtent(state, baseline, seed);
		await evaluate(cdp, "window.__virtualRecentOwners.replay=true");
		evidence.loaded = {
			canonicalEntries: seen.size,
			revealedEntries: revealed.size,
			first: seed.recent[0],
			last: seed.recent.at(-1),
			height: state.list.height,
			minHeight: measured.minHeight,
			revision: state.revision,
		};
		evidence.checkpoints.push({ phase: "all_loaded", state });
		// Return through actual wheel input without a cursor fetch or metadata eviction.
		while (state.viewport.scrollTop > 1) {
			state = await wheel(-state.viewport.height * 0.7);
			assertRetainedVirtualExtent(state, baseline, seed);
		}
		assert.ok(
			state.rows.some((row) => row.index === 0 && row.visible),
			"Wheel scrollback must restore the first canonical row",
		);
		evidence.checkpoints.push({ phase: "wheel_head", state });
		if (state.viewport.gutter < 3)
			evidence.thumb = {
				status: "unavailable",
				reason: "Host exposes an overlay scrollbar without a measurable native gutter; no preference changed",
			};
		else {
			const v = state.viewport;
			// Native thumb geometry is platform-owned. Probe the top gutter, then
			// qualify the drag only through measured middle/end/head displacement.
			const x = v.left + v.width + v.gutter / 2,
				y = v.top + 8;
			const positions = [];
			bounded();
			await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
			await cdp.request("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x,
				y,
				button: "left",
				buttons: 1,
				clickCount: 1,
			});
			try {
				for (const [phase, fraction] of [
					["middle", 0.5],
					["end", 1],
					["back", 0],
				]) {
					bounded();
					await cdp.request("Input.dispatchMouseEvent", {
						type: "mouseMoved",
						x,
						y: v.top + (v.height - 1) * fraction,
						buttons: 1,
					});
					await frames(cdp);
					const moved = await read();
					assertRetainedVirtualExtent(moved, baseline, seed);
					const maximum = moved.viewport.scrollHeight - moved.viewport.height;
					if (phase === "middle")
						assert.ok(
							moved.viewport.scrollTop > maximum * 0.25 && moved.viewport.scrollTop < maximum * 0.75,
							"Native thumb must reach the middle of the loaded extent",
						);
					else if (phase === "end") {
						assert.ok(moved.viewport.scrollTop >= maximum - 2, "Native thumb must reach the loaded end");
						assert.ok(moved.rows.some((row) => row.index === seed.recent.length - 1 && row.visible));
					} else {
						assert.ok(moved.viewport.scrollTop <= 1, "Native thumb must return to the loaded head");
						assert.ok(moved.rows.some((row) => row.index === 0 && row.visible));
					}
					positions.push({ phase, scrollTop: moved.viewport.scrollTop, maximum });
					evidence.checkpoints.push({ phase: `thumb_${phase}`, state: moved });
				}
			} finally {
				await cdp.request("Input.dispatchMouseEvent", {
					type: "mouseReleased",
					x,
					y: v.top,
					button: "left",
					buttons: 0,
					clickCount: 1,
				});
			}
			state = await stable();
			evidence.thumb = { status: "observed", positions, gutter: v.gutter };
		}
		// Focus a real current-window action without selecting its conversation.
		state = await stable();
		const source = state.rows.find(
			(row) =>
				row.visible &&
				row.index < seed.recent.length - 1 &&
				row.top >= state.viewport.top &&
				row.bottom <= state.viewport.bottom,
		);
		assert.ok(source);
		const selector = `${rowSelector(source)} .conversation-actions-trigger`;
		// Native menu entry/escape acquires exact real source focus without selecting a conversation.
		const sourcePoint = await evaluate(
			cdp,
			`(()=>{const node=document.querySelector(${JSON.stringify(`${rowSelector(source)} .conversation-link`)}),r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
		);
		bounded();
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...sourcePoint });
		await frames(cdp);
		await evaluate(cdp, `window.__virtualRecentOwners.source=document.querySelector(${JSON.stringify(selector)});true`);
		bounded();
		await nativeClick(cdp, selector);
		await until(async () => (await read()).focusInMenu, "source menu acquires native focus");
		bounded();
		await nativeKey(cdp, "Escape");
		await until(async () => {
			const value = await read();
			return value.menuCount === 0 && value.focusOnSource;
		}, "source menu returns exact focus");
		state = await stable();
		const focusStart = state.viewport.scrollTop;
		await evaluate(cdp, "window.__virtualRecentOwners.focusRequired=true");
		for (let n = 0; n < 4; n++) {
			state = await wheel(state.viewport.height * (focusStart > state.viewport.scrollHeight / 2 ? -1 : 1));
			assertRetainedVirtualExtent(state, baseline, seed);
			assert.equal(state.focusOnSource, true, "Virtual range movement must not blur the actual focused source");
			assert.equal(state.sourceCopies, 1);
		}
		assert.ok(
			Math.abs(state.viewport.scrollTop - focusStart) > state.viewport.height,
			"Focus retention requires actual offscreen range movement",
		);
		assert.equal(
			state.rows.find((row) => keyOf(row) === keyOf(source))?.visible,
			false,
			"The identical focused row must remain mounted outside the viewport",
		);
		evidence.checkpoints.push({ phase: "focused_offscreen_source", state });
		await evaluate(cdp, "window.__virtualRecentOwners.focusRequired=false");
		bounded();
		await nativeKey(cdp, "Tab");
		await frames(cdp);
		const next = seed.recent[source.index + 1];
		assert.equal(
			await evaluate(
				cdp,
				`document.activeElement===document.querySelector(${JSON.stringify(`${rowSelector(next)} .conversation-link`)})`,
			),
			true,
			"Native Tab must reach the real adjacent canonical row, not a hidden clone",
		);
		bounded();
		await nativeKey(cdp, "Tab", 8);
		assert.equal((await read()).focusOnSource, true, "Shift Tab must return to the identical real source");
		state = await stable();
		for (let n = 0; n < 3; n++) state = await wheel(state.viewport.height);
		assert.equal(state.focusOnSource, true);
		assert.equal(state.rows.find((row) => keyOf(row) === keyOf(source))?.visible, false);
		bounded();
		await nativeKey(cdp, "Enter");
		await until(async () => (await read()).focusInMenu, "native keyboard menu focus");
		const opened = await read();
		assert.equal(opened.menuCount, 1);
		assert.equal(opened.menuTitle, source.title);
		assert.equal(opened.sourceExpanded, true);
		assert.equal(opened.sourceCopies, 1);
		assert.equal(
			opened.rows.find((row) => keyOf(row) === keyOf(source))?.visible,
			false,
			"Opening the menu must retain its actual offscreen source",
		);
		const menuWheel = await wheel(360);
		assertRetainedVirtualExtent(menuWheel, baseline, seed);
		assert.equal(menuWheel.focusInMenu, true);
		assert.equal(menuWheel.sourceExpanded, true);
		assert.equal(menuWheel.sourceCopies, 1);
		assert.equal(menuWheel.rows.find((row) => keyOf(row) === keyOf(source))?.visible, false);
		evidence.menu = {
			source: seed.recent[source.index],
			retained: true,
			offscreenSource: true,
			scrollDuringMenu:
				menuWheel.viewport.scrollTop !== opened.viewport.scrollTop ? "observed" : "blocked_by_modal_menu",
			opened,
			afterWheel: menuWheel,
		};
		bounded();
		await nativeKey(cdp, "Escape");
		await until(async () => {
			const value = await read();
			return value.menuCount === 0 && value.focusOnSource;
		}, "Escape restores exact real menu source");
		state = await read();
		// Escape may natively reveal the source. Ensure PageUp still performs real scrolling.
		if (state.viewport.scrollTop <= 1) state = await wheel(state.viewport.height * 2);
		assert.ok(state.viewport.scrollTop > 1, "PageUp requires a displaced starting viewport");
		let pageUpInputs = 0;
		for (let n = 0; state.viewport.scrollTop > 1; n++) {
			assert.ok(n < 100, "Native PageUp failed to return to the loaded head");
			bounded();
			await nativeKey(cdp, "PageUp");
			pageUpInputs++;
			state = await stable();
			assertRetainedVirtualExtent(state, baseline, seed);
			assert.equal(state.focusOnSource, true, "Keyboard scrolling must preserve the focused real source");
		}
		assert.ok(state.rows.some((row) => row.index === 0 && row.visible));
		evidence.checkpoints.push({ phase: "keyboard_head", state });
		evidence.keyboardScrollback = true;
		evidence.pageUpInputs = pageUpInputs;
		evidence.wheelScrollback = true;
	} catch (error) {
		failure = error.message;
		pendingError = error;
	} finally {
		try {
			trace = await evaluate(cdp, "window.__virtualRecentTrace?.stop()");
			if (trace && !failure) {
				assert.equal(trace.truncated, false);
				assert.ok(trace.frames.length > 0);
				assert.ok(trace.inputs.some((input) => input.type === "wheel"));
				assert.ok(trace.inputs.some((input) => input.type === "keydown"));
				assert.ok(
					trace.inputs.every((input) => input.trusted),
					"Only real trusted native input qualifies",
				);
				for (const frame of trace.frames) {
					if (frame?.replay) assertRetainedVirtualExtent(frame, baseline, seed);
					else assertVirtualRecentFrame(frame, seed);
				}
				evidence.rawFrames = trace.frames.length;
				evidence.peakRenderedRows = Math.max(...trace.frames.map((frame) => frame.rows.length));
			}
		} catch (error) {
			failure ??= error.message;
			pendingError ??= error;
		} finally {
			await writeFile(
				join(directory, `sidebar-virtualization-${reopened ? "reopened" : "first"}.json`),
				`${JSON.stringify({ evidence, interactions, failure, trace }, null, 2)}\n`,
			);
			await evaluate(cdp, "delete window.__virtualRecentTrace;delete window.__virtualRecentOwners");
		}
	}
	if (pendingError) throw pendingError;
	return evidence;
}

export function assertSidebarVirtualizationAcceptance({ first, reopened }) {
	for (const value of [first, reopened]) {
		assert.equal(value.nativeInput, true);
		assert.equal(value.loaded.canonicalEntries, 600, "The fixed fixture must reveal all 600 canonical Recent entries");
		assert.equal(value.loaded.revealedEntries, value.loaded.canonicalEntries);
		assert.ok(value.rawFrames > 0 && value.peakRenderedRows < 100);
		assert.equal(value.wheelScrollback, true);
		assert.equal(value.keyboardScrollback, true);
		assert.ok(value.pageUpInputs > 0);
		assert.equal(value.menu.retained, true);
		assert.equal(value.menu.offscreenSource, true);
		assert.ok(["observed", "unavailable"].includes(value.thumb.status));
		if (value.thumb.status === "unavailable") {
			assert.equal(typeof value.thumb.reason, "string");
			assert.ok(value.thumb.reason.trim());
		} else {
			assert.ok(value.thumb.gutter >= 3);
			assert.deepEqual(
				value.thumb.positions.map((position) => position.phase),
				["middle", "end", "back"],
			);
			const [middle, end, back] = value.thumb.positions;
			for (const position of value.thumb.positions) {
				assert.ok(Number.isFinite(position.maximum) && position.maximum > 0);
				assert.ok(
					Number.isFinite(position.scrollTop) && position.scrollTop >= 0 && position.scrollTop <= position.maximum,
				);
				assert.equal(position.maximum, middle.maximum, "Thumb replay must retain the same measured extent");
			}
			assert.ok(
				middle.maximum > 0 && middle.scrollTop > middle.maximum * 0.25 && middle.scrollTop < middle.maximum * 0.75,
			);
			assert.ok(end.maximum > 0 && end.scrollTop >= end.maximum - 2);
			assert.ok(back.scrollTop <= 1);
		}
	}
	assert.deepEqual(reopened.loaded.first, first.loaded.first);
	assert.deepEqual(reopened.loaded.last, first.loaded.last);
	assert.equal(reopened.loaded.canonicalEntries, first.loaded.canonicalEntries);
	const unavailable = [first, reopened].flatMap((value, index) =>
		value.thumb.status === "unavailable" ? [`${index === 0 ? "first" : "reopened"}: ${value.thumb.reason}`] : [],
	);
	return unavailable.length
		? {
				status: "unqualified",
				reason: `Native scrollbar thumb qualification is unavailable on this host; this is not a product defect. ${unavailable.join("; ")}`,
				missing: ["native-thumb-drag"],
			}
		: { status: "passed" };
}
