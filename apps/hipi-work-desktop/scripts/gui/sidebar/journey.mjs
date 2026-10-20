import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, click, evaluate, hover, until } from "../../gui-flow.mjs";
import { assertSidebarHoverTrace, startSidebarHoverTrace } from "../../gui-sidebar-hover.mjs";
import { defaultRoleEntry } from "./manifest.mjs";

const heading = (id) => `[data-sidebar-section="${id}"] .sidebar-section-toggle`;
const project = (id) => `.workspace-branch[data-workspace-id="${id}"] .project-open`;
const pin = (scope) =>
	`.pinned-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read-only observer; native CDP input owns every interaction. */
export function sidebarState(document) {
	const sections = [...document.querySelectorAll("[data-sidebar-section]")];
	const scopes = (selector) =>
		[...document.querySelectorAll(selector)].map((node) => ({
			workspaceId: node.dataset.workspaceId,
			conversationId: node.dataset.conversationId,
		}));
	const viewport = document.querySelector(".navigation-list");
	return {
		sections: sections.map((node) => node.dataset.sidebarSection),
		collapsed: Object.fromEntries(
			sections.map((node) => [
				node.dataset.sidebarSection,
				node.querySelector(".sidebar-section-toggle")?.getAttribute("aria-expanded") === "false",
			]),
		),
		projects: [...document.querySelectorAll(".workspace-branch:not(.recent-conversations)")].map(
			(node) => node.dataset.workspaceId,
		),
		pins: scopes(".pinned-conversations .conversation-link"),
		selected: scopes(".conversation-link[aria-current='page']"),
		draft: document.querySelector(".composer textarea")?.value ?? null,
		messages: [...document.querySelectorAll("[data-message-id]")].map((node) => ({
			id: node.dataset.messageId,
			text: node.textContent,
		})),
		dragging: document.querySelector(".sidebar-order-surface")?.dataset.sidebarDragging === "true",
		overlay: !!document.querySelector(".sidebar-drag-overlay"),
		scroll: viewport ? { top: viewport.scrollTop, height: viewport.clientHeight, total: viewport.scrollHeight } : null,
	};
}
export function assertSidebarState(value, seed) {
	assert.deepEqual([...value.sections].sort(), ["pinned", "projects", "recent"]);
	assert.deepEqual([...value.projects].sort(), seed.workspaceIds.filter((id) => id !== seed.defaultWorkspaceId).sort());
	assert.equal(value.dragging, false);
	assert.equal(value.overlay, false);
	assert.deepEqual(
		[...value.pins].map(scopeKey).sort(),
		seed.pins.map(scopeKey).sort(),
		"Exact canonical pins must survive",
	);
}
const scopeKey = ({ workspaceId, conversationId }) => `${workspaceId}.${conversationId}`;

export function assertSidebarAcceptance({ first, reopened }) {
	assert.equal(first.nativeInput, true);
	assert.equal(first.fixtureSetupOnly, true);
	assert.ok(first.actions.length >= 12, "Incomplete native sidebar journey");
	assert.ok(first.warmHover.frames > 0);
	assert.equal(first.autoscroll.observed, true);
	assert.deepEqual(
		reopened.final,
		first.final,
		"Cold restart must retain local ordering/disclosures and runtime pin order",
	);
	assert.equal(reopened.coldRestored, true);
}

async function key(cdp, value, modifiers = 0) {
	const keys = {
		Enter: [13, "Enter"],
		" ": [32, "Space"],
		Tab: [9, "Tab"],
		Escape: [27, "Escape"],
		ArrowUp: [38, "ArrowUp"],
		ArrowDown: [40, "ArrowDown"],
	};
	assert.ok(keys[value]);
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", {
			type,
			key: value,
			code: keys[value][1],
			windowsVirtualKeyCode: keys[value][0],
			modifiers,
			...(type === "keyDown" && [" ", "Enter"].includes(value) ? { text: value === "Enter" ? "\r" : " " } : {}),
		});
}
async function point(cdp, selector, fraction = 0.5, scroll = true) {
	const value = await evaluate(
		cdp,
		`(()=>{
		const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];
		if(nodes.length!==1)throw Error('Ambiguous target');
		const node=nodes[0];if(${scroll})node.scrollIntoView({block:'nearest'});
		const r=node.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height*${fraction});
		return {x,y,hit:node.contains(document.elementFromPoint(x,y))};
	})()`,
	);
	assert.equal(value.hit, true, "Native input target must be unobstructed");
	return { x: value.x, y: value.y };
}
async function mouse(cdp, type, location) {
	await cdp.request("Input.dispatchMouseEvent", {
		type,
		...location,
		...(type === "mouseMoved" ? { buttons: 1 } : { button: "left", clickCount: 1 }),
	});
}
async function focusByTab(cdp, selector) {
	for (let n = 0; n < 180; n++) {
		if (await evaluate(cdp, `document.activeElement===document.querySelector(${JSON.stringify(selector)})`)) return;
		await key(cdp, "Tab");
	}
	throw new Error("Native Tab did not reach required focus owner");
}
async function assertFocus(cdp, selector) {
	assert.equal(
		await evaluate(cdp, `document.activeElement===document.querySelector(${JSON.stringify(selector)})`),
		true,
		"Native gesture must retain or restore its exact canonical focus owner",
	);
}
const readState = (cdp) => evaluate(cdp, `(${sidebarState.toString()})(document)`);
const layout = ({ sections, collapsed, projects, pins, draft, messages }) => ({
	sections,
	collapsed,
	projects,
	pins,
	draft,
	messages,
});

export function expectedPinnedPreview(seed, scope) {
	const conversation = seed.snapshot.conversations.find(
		(item) => scopeKey(item.conversation) === scopeKey(scope),
	)?.conversation;
	const workspace = seed.snapshot.workspaces.find((item) => item.workspaceId === scope.workspaceId);
	assert.ok(conversation && workspace, "Hover expectation requires exact seeded canonical scope");
	assert.ok(Number.isFinite(conversation.createdAt), "Fixture must have a known creation timestamp");
	return {
		scope: { workspaceId: scope.workspaceId, conversationId: scope.conversationId },
		title: conversation.title,
		metadata: {
			titles: [conversation.title],
			created: [new Date(conversation.createdAt).toISOString()],
			workspaces: [workspace.name],
			projects: 0,
			projectMetadata: [],
		},
	};
}

async function warmHover(cdp, directory, seed) {
	// Establish viewport geometry before any measured interval. Last disclosure focus
	// may have scrolled Recent into view and left the pinned rows clipped.
	await evaluate(cdp, "document.querySelector('.pinned-conversations').scrollIntoView({block:'start'});true");
	let priorGeometry;
	await until(async () => {
		const geometry = await evaluate(
			cdp,
			`${JSON.stringify(seed.pins.map(pin))}.map(selector=>{
			const node=document.querySelector(selector);if(!node)return null;
			const r=node.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
			return r.width>0&&r.height>0&&node.contains(document.elementFromPoint(x,y))?{x,y}:null;
		})`,
		);
		const serialized = JSON.stringify(geometry);
		const ready = geometry.every(Boolean) && serialized === priorGeometry;
		priorGeometry = serialized;
		return ready;
	}, "all three pin centers settle unobstructed after disclosure animation");
	const targets = [];
	for (const scope of seed.pins) {
		const expected = expectedPinnedPreview(seed, scope);
		await hover(cdp, pin(scope));
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.conversation-preview-card')?.getAttribute('aria-labelledby')===document.querySelector(${JSON.stringify(pin(scope))}).closest('.sidebar-preview-row').getAttribute('aria-labelledby') && document.querySelector('.conversation-preview-card .preview-workspace')?.textContent.trim()===${JSON.stringify(expected.metadata.workspaces[0])}`,
				),
			"pinned metadata ready",
		);
		targets.push({
			...expected,
			...(await evaluate(
				cdp,
				`(()=>{
			const node=document.querySelector(${JSON.stringify(pin(scope))}),r=node.getBoundingClientRect();
			return {owner:node.closest('.sidebar-preview-row').getAttribute('aria-labelledby'),point:{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}};
		})()`,
			)),
		});
		assert.equal(
			await evaluate(cdp, "document.querySelector('.conversation-preview-card').getAttribute('aria-labelledby')"),
			targets.at(-1).owner,
		);
	}
	await hover(cdp, ".app-toolbar");
	await until(
		() => evaluate(cdp, "!document.querySelector('.conversation-preview-card')"),
		"preview closes before cold A",
	);
	await pause(350);
	for (const [index, scope] of seed.pins.entries())
		assert.deepEqual(
			await point(cdp, pin(scope), 0.5, false),
			targets[index].point,
			"Prewarm must not move measured row centers",
		);
	let trace;
	try {
		await evaluate(
			cdp,
			`void(window.__sidebarFrames=(${startSidebarHoverTrace.toString()})(document,${JSON.stringify(targets)}))`,
		);
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...targets[0].point });
		assert.equal(await evaluate(cdp, "window.__sidebarFrames.coldOpen()"), true);
		for (const target of targets.slice(1)) {
			await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...target.point });
			await evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
		}
	} finally {
		trace = await evaluate(
			cdp,
			"(()=>{const t=window.__sidebarFrames?.stop();delete window.__sidebarFrames;return t})()",
		);
		await writeFile(join(directory, "sidebar-warm-frames.json"), `${JSON.stringify(trace, null, 2)}\n`);
	}
	const result = assertSidebarHoverTrace(trace);
	await capture(cdp, directory, "sidebar-warm-hover");
	await hover(cdp, ".app-toolbar");
	return result;
}

export async function exerciseSidebar({ cdp, directory, reopened, seed, previous, record }) {
	await until(() => evaluate(cdp, "!!document.querySelector('.navigation-list')"), "sidebar ready");
	if (!reopened) {
		// Only the completed default-role record is fixture setup. Never inject ordering or disclosure state.
		const entry = defaultRoleEntry(seed);
		await evaluate(
			cdp,
			`localStorage.setItem(${JSON.stringify(`hipi.work.local.v1.${seed.handshake.storeId}.value.default-chat-workspace`)},${JSON.stringify(JSON.stringify(entry))});location.reload();true`,
		);
	}
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelectorAll('[data-sidebar-section]').length===3 && document.querySelectorAll('.workspace-branch:not(.recent-conversations)').length===2`,
			),
		"three sections and two real projects",
	);
	const actions = [];
	let failure;
	try {
		if (reopened) {
			await until(async () => (await readState(cdp)).pins.length === seed.pins.length, "cold canonical pins loaded");
			// Expand only after checking persisted disclosure state; final comparison precedes any action.
			const restored = await readState(cdp);
			assert.deepEqual(restored.sections, previous.final.sections);
			assert.deepEqual(restored.collapsed, previous.final.collapsed);
			// Restart is read-only: no fallback click may repair a lost persisted selection.
			await until(
				() =>
					evaluate(
						cdp,
						`!!document.querySelector('.composer textarea') && document.querySelector(${JSON.stringify(pin(seed.pins[0]))})?.getAttribute('aria-current')==='page'`,
					),
				"cold selected canonical conversation restores without input",
			);
			await until(
				() => evaluate(cdp, `document.querySelector('.composer textarea')?.value===${JSON.stringify(seed.draft)}`),
				"cold draft restored",
			);
			await until(
				async () => (await readState(cdp)).messages.length === previous.final.messages.length,
				"cold history restored",
			);
			const final = layout(await readState(cdp));
			await capture(cdp, directory, "sidebar-cold-restored");
			return { final, coldRestored: true };
		}
		await click(cdp, pin(seed.pins[0]));
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.conversation-panel')?.textContent.includes(${JSON.stringify(seed.answer)})`,
				),
			"seed history visible",
		);
		await click(cdp, ".composer textarea");
		await cdp.request("Input.insertText", { text: seed.draft });
		await evaluate(
			cdp,
			`void(window.__sidebarContinuity={panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll')})`,
		);
		const baseline = await readState(cdp);
		assert.equal(baseline.draft, seed.draft);
		assert.equal(baseline.messages.length, 2, "Continuity needs actual persisted history rows");
		const continuity = async () => {
			const current = await readState(cdp);
			assert.equal(current.draft, baseline.draft);
			assert.deepEqual(current.messages, baseline.messages);
			if (!current.collapsed.pinned)
				assert.ok(
					current.selected.some((selected) => scopeKey(selected) === scopeKey(seed.pins[0])),
					"Expanded pins must expose the exact active canonical scope",
				);
			for (const selected of current.selected)
				assert.deepEqual(selected, seed.pins[0], "Visible selection must retain its canonical scope");
			assert.equal(
				await evaluate(
					cdp,
					"(()=>{const b=window.__sidebarContinuity;return b.panel===document.querySelector('.conversation-panel')&&b.composer===document.querySelector('.composer textarea')&&b.history===document.querySelector('.message-scroll')})()",
				),
				true,
			);
		};
		const completed = async (name) => {
			await continuity();
			actions.push({ name, state: await readState(cdp) });
			record({ sidebarAction: name });
		};
		for (const id of ["pinned", "projects", "recent"]) {
			await click(cdp, heading(id));
			await until(async () => (await readState(cdp)).collapsed[id], `${id} click collapse`);
			await key(cdp, "Enter");
			await until(async () => !(await readState(cdp)).collapsed[id], `${id} Enter expand`);
			await key(cdp, " ");
			await until(async () => (await readState(cdp)).collapsed[id], `${id} Space collapse`);
			await key(cdp, " ");
			await until(async () => !(await readState(cdp)).collapsed[id], `${id} Space expand`);
			await completed(`${id} click Enter Space disclosure`);
		}
		const thresholdOrder = (await readState(cdp)).sections;
		const thresholdStart = await point(cdp, heading("pinned"));
		await mouse(cdp, "mousePressed", thresholdStart);
		await mouse(cdp, "mouseMoved", { x: thresholdStart.x + 6, y: thresholdStart.y });
		await evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
		assert.equal(await evaluate(cdp, "!!document.querySelector('.sidebar-drag-overlay')"), false);
		await mouse(cdp, "mouseReleased", { x: thresholdStart.x + 6, y: thresholdStart.y });
		await until(
			async () => (await readState(cdp)).collapsed.pinned,
			"release at six pixels remains ordinary disclosure click",
		);
		assert.deepEqual((await readState(cdp)).sections, thresholdOrder);
		await click(cdp, heading("pinned"));
		await until(async () => !(await readState(cdp)).collapsed.pinned, "restore pinned disclosure normally");
		await completed("release at exact six pixels remains click");
		const warm = await warmHover(cdp, directory, seed);
		await completed("three canonical pinned warm hover raw frames");
		// Collapse Recent for compact measured heading targets, without removing the section.
		await click(cdp, heading("recent"));
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('[data-sidebar-section="recent"] .sidebar-section-content')?.children.length===0`,
				),
			"Recent collapse animation completes before measuring targets",
		);
		const drag = async (source, target, edge, expected, field, name) => {
			const before = await readState(cdp);
			await point(cdp, source);
			await point(cdp, target, edge === "before" ? 0.2 : 0.8);
			// The final scroll can move the source. Measure both again without scrolling.
			const start = await point(cdp, source, 0.5, false);
			const end = await point(cdp, target, edge === "before" ? 0.2 : 0.8, false);
			await mouse(cdp, "mousePressed", start);
			await mouse(cdp, "mouseMoved", { x: start.x + 6, y: start.y });
			await evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
			assert.equal(
				await evaluate(cdp, "!!document.querySelector('.sidebar-drag-overlay')"),
				false,
				"Exact six pixels must not activate pickup",
			);
			await mouse(cdp, "mouseMoved", { x: start.x + 8, y: start.y });
			await until(
				() => evaluate(cdp, "!!document.querySelector('.sidebar-drag-overlay')"),
				"pointer pickup above six pixels",
			);
			await mouse(cdp, "mouseMoved", end);
			await mouse(cdp, "mouseReleased", end);
			await until(async () => JSON.stringify((await readState(cdp))[field]) === JSON.stringify(expected), name);
			await assertFocus(cdp, source);
			assert.deepEqual((await readState(cdp)).collapsed, before.collapsed, "Drag must not trigger disclosure click");
			await completed(name);
		};
		await drag(
			heading("recent"),
			'[data-sidebar-section="pinned"]',
			"before",
			["recent", "pinned", "projects"],
			"sections",
			"heading before target",
		);
		await drag(
			heading("recent"),
			'[data-sidebar-section="projects"]',
			"after",
			["pinned", "projects", "recent"],
			"sections",
			"heading end target",
		);
		await drag(
			heading("recent"),
			'[data-sidebar-section="pinned"]',
			"after",
			["pinned", "recent", "projects"],
			"sections",
			"heading after target",
		);
		let pins = (await readState(cdp)).pins;
		const row = (scope) => `${pin(scope)}:not([disabled])`;
		await drag(row(pins[2]), `${pin(pins[0])}`, "before", [pins[2], pins[0], pins[1]], "pins", "canonical pin before");
		pins = (await readState(cdp)).pins;
		await drag(row(pins[0]), pin(pins[2]), "after", [pins[1], pins[2], pins[0]], "pins", "canonical pin end");
		let projects = (await readState(cdp)).projects;
		await drag(
			project(projects[1]),
			project(projects[0]),
			"before",
			[projects[1], projects[0]],
			"projects",
			"project before without membership move",
		);
		projects = (await readState(cdp)).projects;
		await drag(
			project(projects[0]),
			project(projects[1]),
			"after",
			[projects[1], projects[0]],
			"projects",
			"project end without membership move",
		);
		// Native focus owner and configured default Alt-ArrowDown; no DOM focus or synthetic keys.
		await focusByTab(cdp, heading("pinned"));
		await key(cdp, "ArrowDown", 1);
		await until(
			async () => (await readState(cdp)).sections.join() === "recent,pinned,projects",
			"configured Alt ArrowDown on heading",
		);
		await assertFocus(cdp, heading("pinned"));
		await completed("configured keyboard heading order");
		await focusByTab(cdp, pin(seed.pins[0]));
		const keyboardPins = (await readState(cdp)).pins;
		const at = keyboardPins.findIndex((scope) => scopeKey(scope) === scopeKey(seed.pins[0]));
		await key(cdp, at === 0 ? "ArrowDown" : "ArrowUp", 1);
		const expectedPins = [...keyboardPins];
		const other = at === 0 ? 1 : at - 1;
		[expectedPins[at], expectedPins[other]] = [expectedPins[other], expectedPins[at]];
		await until(
			async () => JSON.stringify((await readState(cdp)).pins) === JSON.stringify(expectedPins),
			"configured canonical pin keyboard order",
		);
		await assertFocus(cdp, pin(seed.pins[0]));
		await completed("configured keyboard pinned order");
		projects = (await readState(cdp)).projects;
		await focusByTab(cdp, project(projects[0]));
		await key(cdp, "ArrowDown", 1);
		await until(
			async () => (await readState(cdp)).projects.join() === [projects[1], projects[0]].join(),
			"configured project keyboard order",
		);
		await assertFocus(cdp, project(projects[0]));
		await completed("configured keyboard project order");
		// Restore compact order with native keys, then expose overflow for bounded scrolling.
		await focusByTab(cdp, heading("recent"));
		await key(cdp, "ArrowDown", 1);
		await until(
			async () => (await readState(cdp)).sections.join() === "pinned,recent,projects",
			"first section keyboard move persisted",
		);
		await key(cdp, "ArrowDown", 1);
		await until(
			async () => (await readState(cdp)).sections.join() === "pinned,projects,recent",
			"second section keyboard move persisted",
		);
		await click(cdp, heading("recent"));
		await until(async () => {
			const s = (await readState(cdp)).scroll;
			return s.total > s.height + 100;
		}, "bounded fixture actually overflows");
		const orderBeforeCancel = (await readState(cdp)).sections;
		const start = await point(cdp, heading("pinned"));
		await mouse(cdp, "mousePressed", start);
		await mouse(cdp, "mouseMoved", { x: start.x + 8, y: start.y });
		await until(() => evaluate(cdp, "!!document.querySelector('.sidebar-drag-overlay')"), "autoscroll pickup");
		const viewport = await evaluate(
			cdp,
			"(()=>{const r=document.querySelector('.navigation-list').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.bottom-4),outsideX:Math.round(r.right+50)}})()",
		);
		const initialScroll = (await readState(cdp)).scroll.top;
		await mouse(cdp, "mouseMoved", { x: viewport.x, y: viewport.y });
		await until(async () => (await readState(cdp)).scroll.top > initialScroll + 10, "native bounded autoscroll", 3000);
		await mouse(cdp, "mouseMoved", { x: viewport.outsideX, y: viewport.y });
		await pause(80);
		const outside = (await readState(cdp)).scroll.top;
		await pause(150);
		assert.equal((await readState(cdp)).scroll.top, outside, "Outside sidebar must stop autoscroll");
		await key(cdp, "Escape");
		await mouse(cdp, "mouseReleased", { x: viewport.outsideX, y: viewport.y });
		await until(
			() => evaluate(cdp, "!document.querySelector('.sidebar-drag-overlay')"),
			"Escape cancels pointer gesture",
		);
		assert.deepEqual((await readState(cdp)).sections, orderBeforeCancel);
		await assertFocus(cdp, heading("pinned"));
		await completed("bounded autoscroll outside viewport Escape cancel");
		await click(cdp, heading("recent"));
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('[data-sidebar-section="recent"] .sidebar-section-content')?.children.length===0`,
				),
			"Recent collapse animation completes before outside-drop probe",
		);
		const cancelStart = await point(cdp, heading("pinned"));
		const cancelOrder = (await readState(cdp)).sections;
		await mouse(cdp, "mousePressed", cancelStart);
		await mouse(cdp, "mouseMoved", { x: cancelStart.x + 8, y: cancelStart.y });
		await until(() => evaluate(cdp, "!!document.querySelector('.sidebar-drag-overlay')"), "outside-drop pickup");
		await mouse(cdp, "mouseMoved", { x: viewport.outsideX, y: cancelStart.y });
		await mouse(cdp, "mouseReleased", { x: viewport.outsideX, y: cancelStart.y });
		await until(
			() => evaluate(cdp, "!document.querySelector('.sidebar-drag-overlay')"),
			"outside release ends gesture",
		);
		assert.deepEqual((await readState(cdp)).sections, cancelOrder);
		await assertFocus(cdp, heading("pinned"));
		await completed("outside viewport release cannot reorder");
		await focusByTab(cdp, heading("recent"));
		await key(cdp, "ArrowUp", 1);
		await until(
			async () => (await readState(cdp)).sections.join() === "pinned,recent,projects",
			"non-default section order persists",
		);
		await completed("non-default section order for cold restart");
		const finalState = await readState(cdp);
		assertSidebarState(finalState, seed);
		await capture(cdp, directory, "sidebar-first-final");
		return {
			nativeInput: true,
			fixtureSetupOnly: true,
			actions,
			warmHover: warm,
			autoscroll: { observed: true, initialScroll, outside },
			final: layout(finalState),
		};
	} catch (error) {
		failure = error.message;
		throw error;
	} finally {
		await writeFile(
			join(directory, `sidebar-actions-${reopened ? "cold" : "first"}.json`),
			`${JSON.stringify({ actions, failure, state: await readState(cdp) }, null, 2)}\n`,
		);
		await evaluate(cdp, "delete window.__sidebarContinuity");
	}
}
