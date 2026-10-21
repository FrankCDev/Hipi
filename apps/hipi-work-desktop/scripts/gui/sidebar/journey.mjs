import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, click, evaluate, hover, until } from "../../gui-flow.mjs";
import { assertSidebarShellGeometry, sidebarShellGeometry } from "../../gui-sidebar-geometry.mjs";
import { assertSidebarHoverTrace, startSidebarHoverTrace } from "../../gui-sidebar-hover.mjs";
import { exerciseSidebarContextMenus } from "./context-menu.mjs";
import { exerciseSidebarKeyboard } from "./item-navigation.mjs";
import { nativeKeyEvents } from "./native-key.mjs";
import { openRecentConversation } from "./new-chat-navigation.mjs";
import { assertProjectPublication, exerciseProjectHoverPublication } from "./project-hover-publication.mjs";
import { sidebarStartupDiagnostic } from "./startup-diagnostic.mjs";
import { seedSidebarDocument } from "./startup-lifecycle.mjs";

const heading = (id) => `[data-sidebar-section="${id}"] .sidebar-section-toggle`;
const project = (id) => `.workspace-branch[data-workspace-id="${id}"] .project-open`;
const pin = (scope) =>
	`.pinned-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const aliasDraft = "SIDEBAR_ALIAS_UNSUBMITTED 中文";

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

export function assertAliasSelection(value, scope, location, draft, projectId) {
	if (location === "project") assert.ok(typeof projectId === "string" && projectId.length > 0);
	assert.deepEqual(
		value.selected,
		[{ ...scope, location, ...(location === "project" ? { projectId } : {}) }],
		"Exactly one rendered alias must own selection",
	);
	assert.equal(value.draft, draft, "Alias navigation must preserve the unsent draft");
	assert.equal(value.samePanel, true, "Alias navigation must retain the conversation panel");
	assert.equal(value.sameComposer, true, "Alias navigation must retain the composer node");
	assert.equal(value.sameHistory, true, "Alias navigation must retain the history node");
}

async function exerciseAliasSelection(cdp, seed, observeGeometry) {
	const scope = seed.alias;
	assert.ok(scope, "Fixture requires an unpinned project conversation");
	const row = `.conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
	const recentRow = `.recent-conversations ${row}`;
	const projectRow = `.workspace-branch:not(.recent-conversations)[data-workspace-id="${scope.workspaceId}"] ${row}`;
	const toggle = `.workspace-branch:not(.recent-conversations)[data-workspace-id="${scope.workspaceId}"] .project-toggle`;
	await click(cdp, recentRow);
	await until(
		() => evaluate(cdp, "!!document.querySelector('.conversation-panel .composer textarea')"),
		"alias composer ready",
	);
	const draft = aliasDraft;
	await click(cdp, ".composer textarea");
	await cdp.request("Input.insertText", { text: draft });
	await evaluate(
		cdp,
		"(()=>{const nodes={panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll')};if(Object.values(nodes).some(node=>!node?.isConnected))throw Error('Missing alias continuity owner');window.__sidebarAlias=nodes;return true})()",
	);
	const evidence = [];
	const verify = async (location) => {
		const read = () =>
			evaluate(
				cdp,
				`(()=>{
			const retained=window.__sidebarAlias;
			return {selected:[...document.querySelectorAll('.conversation-link[aria-current="page"]')].map(node=>({
				workspaceId:node.dataset.workspaceId,conversationId:node.dataset.conversationId,
				location:node.dataset.sidebarLocation,
				...(node.dataset.sidebarLocation==='project'?{projectId:node.dataset.sidebarLocationProject}:{})
			})),draft:document.querySelector('.composer textarea')?.value,
				samePanel:retained.panel===document.querySelector('.conversation-panel'),
				sameComposer:retained.composer===document.querySelector('.composer textarea'),
				sameHistory:retained.history===document.querySelector('.message-scroll')};
		})()`,
			);
		await until(async () => {
			const value = await read();
			return value.selected.length === 1 && value.selected[0].location === location;
		}, `single active ${location} alias`);
		const value = await read();
		assertAliasSelection(value, scope, location, draft, seed.aliasProjectId);
		evidence.push(value);
		await observeGeometry(`alias selection: ${location}`);
	};
	try {
		await verify("recent");
		if (
			await evaluate(cdp, `document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-expanded')==='false'`)
		)
			await click(cdp, toggle);
		await click(cdp, projectRow);
		await verify("project");
		await click(cdp, toggle);
		await verify("recent");
		await click(cdp, toggle);
		await verify("project");
		await click(cdp, recentRow);
		await verify("recent");
		return evidence;
	} finally {
		await evaluate(cdp, "delete window.__sidebarAlias");
	}
}

export function assertSidebarAcceptance({ first, reopened }) {
	assert.equal(first.nativeInput, true);
	assert.equal(first.fixtureSetupOnly, true);
	assert.ok(first.actions.length >= 12, "Incomplete native sidebar journey");
	assert.ok(first.warmHover.frames > 0);
	assertProjectPublication(first.projectHoverPublication);
	assert.equal(first.autoscroll.observed, true);
	assert.deepEqual(
		reopened.final,
		first.final,
		"Cold restart must retain local ordering/disclosures and runtime pin order",
	);
	assert.equal(reopened.coldRestored, true);
}

export function assertHomeDraftContext(value, workspaceId, draft, continuousHome = true) {
	assert.deepEqual(value.projects, workspaceId ? [workspaceId] : [], "New chat must keep its exact chosen project");
	assert.equal(value.conversations, 0, "New chat must leave the previous conversation view");
	assert.equal(value.draft, draft, "Changing the destination must not replace the shared home draft");
	if (continuousHome) assert.equal(value.sameInput, true, "Changing the destination must retain the actual input node");
}

export function homeInputAcceptsEditing(document) {
	const input = document.querySelector(".prepared-task-input");
	return !!input && !input.disabled && !input.readOnly;
}

async function exerciseNewChatContext(cdp, seed, directory, observeGeometry) {
	const draft = "SIDEBAR_HOME_SHARED 中文";
	const inputFocused = () =>
		until(
			() =>
				evaluate(
					cdp,
					"!!document.querySelector('.prepared-task-input') && document.activeElement===document.querySelector('.prepared-task-input')",
				),
			"New chat focuses its actual home input",
		);
	await click(cdp, ".new-conversation-trigger");
	await until(
		() => evaluate(cdp, `(${homeInputAcceptsEditing.toString()})(document)`),
		"inherited project home input admits editing",
	);
	await inputFocused();
	assert.equal(await evaluate(cdp, "document.querySelector('.prepared-task-input').value"), "");
	await click(cdp, ".prepared-task-input");
	const inputBeforeTyping = await evaluate(
		cdp,
		"(()=>{const input=document.querySelector('.prepared-task-input');return {value:input.value,readOnly:input.readOnly,ariaBusy:input.getAttribute('aria-busy'),focused:document.activeElement===input}})()",
	);
	await cdp.request("Input.insertText", { text: draft });
	const inputAfterTyping = await evaluate(
		cdp,
		"(()=>{const input=document.querySelector('.prepared-task-input');return {value:input.value,readOnly:input.readOnly,ariaBusy:input.getAttribute('aria-busy'),focused:document.activeElement===input}})()",
	);
	await evaluate(
		cdp,
		"(()=>{const input=document.querySelector('.prepared-task-input');if(!input?.isConnected)throw Error('Missing shared home input');window.__sidebarHomeInput=input;return true})()",
	);
	const evidence = [{ step: "native home input", beforeTyping: inputBeforeTyping, afterTyping: inputAfterTyping }];
	let failure;
	const verify = async (step, workspaceId, continuousHome = true) => {
		await until(
			() => evaluate(cdp, `(${homeInputAcceptsEditing.toString()})(document)`),
			`${step}: home input admits editing`,
		);
		const value = await evaluate(
			cdp,
			`({
			projects:[...document.querySelectorAll('.project-open[aria-current="page"]')].map(node=>node.closest('.workspace-branch').dataset.workspaceId),
			conversations:document.querySelectorAll('.conversation-panel').length,
			draft:document.querySelector('.prepared-task-input')?.value,
			readOnly:document.querySelector('.prepared-task-input')?.readOnly,
			ariaBusy:document.querySelector('.prepared-task-input')?.getAttribute('aria-busy'),
			inputFocused:document.activeElement===document.querySelector('.prepared-task-input'),
			sameInput:window.__sidebarHomeInput===document.querySelector('.prepared-task-input')
		})`,
		);
		evidence.push({ step, expectedProject: workspaceId, expectedDraft: draft, ...value, continuousHome });
		await writeFile(join(directory, "sidebar-new-chat-context.json"), `${JSON.stringify({ evidence }, null, 2)}\n`);
		assertHomeDraftContext(value, workspaceId, draft, continuousHome);
		await observeGeometry(step);
	};
	try {
		await verify("typed inherited project draft", seed.alias.workspaceId);
		const otherProject = seed.workspaceIds.find(
			(id) => id !== seed.defaultWorkspaceId && id !== seed.alias.workspaceId,
		);
		assert.ok(otherProject);
		await click(cdp, project(otherProject));
		await verify("switch project destination", otherProject);
		await click(cdp, ".new-conversation-trigger");
		await inputFocused();
		await verify("repeat New chat in selected project", otherProject);
		await click(cdp, ".brand-home");
		await verify("switch to projectless home", null);
		const ordinary = seed.snapshot.conversations.find(
			({ conversation }) => conversation.workspaceId === seed.defaultWorkspaceId,
		)?.conversation;
		assert.ok(ordinary);
		await openRecentConversation(cdp, ordinary, evidence);
		await until(
			() => evaluate(cdp, "!!document.querySelector('.conversation-panel .composer textarea')"),
			"ordinary default conversation opens",
		);
		await click(cdp, ".new-conversation-trigger");
		await inputFocused();
		await verify("New chat from default conversation", null, false);
		await openRecentConversation(cdp, seed.alias, evidence);
		await until(
			() => evaluate(cdp, `document.querySelector('.composer textarea')?.value===${JSON.stringify(aliasDraft)}`),
			"existing conversation draft remains separate from home draft",
		);
		await click(cdp, ".new-conversation-trigger");
		await inputFocused();
		// Entering a conversation intentionally unmounts the home. Subsequent home routes
		// must still preserve text and destination; this is not a same-node claim across views.
		await verify("New chat from project conversation", seed.alias.workspaceId, false);
		await click(cdp, ".prepared-task-input");
		await key(cdp, "a", process.platform === "darwin" ? 4 : 2);
		const selection = await evaluate(
			cdp,
			"(()=>{const input=document.querySelector('.prepared-task-input');return {value:input.value,focused:document.activeElement===input,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd}})()",
		);
		evidence.push({ step: "native select all before clearing home draft", ...selection });
		assert.equal(selection.focused, true, "Native select all must target the focused home input");
		assert.equal(selection.value, draft, "Native select all must not change the draft");
		assert.equal(selection.selectionStart, 0, "Native select all must start at the beginning");
		assert.equal(selection.selectionEnd, selection.value.length, "Native select all must cover the entire draft");
		await key(cdp, "Backspace");
		const clearedDraft = await evaluate(cdp, "document.querySelector('.prepared-task-input').value");
		evidence.push({ step: "native Backspace clears home draft", draft: clearedDraft });
		assert.equal(clearedDraft, "");
		return evidence;
	} catch (error) {
		failure = error.message;
		throw error;
	} finally {
		await writeFile(
			join(directory, "sidebar-new-chat-context.json"),
			`${JSON.stringify({ evidence, failure }, null, 2)}\n`,
		);
		await evaluate(cdp, "delete window.__sidebarHomeInput");
	}
}

async function key(cdp, value, modifiers = 0) {
	for (const event of nativeKeyEvents(value, modifiers)) await cdp.request("Input.dispatchKeyEvent", event);
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
	const startup = { reopened };
	try {
		if (!reopened) await seedSidebarDocument(cdp, seed, startup);
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelectorAll('[data-sidebar-section]').length===3 && document.querySelectorAll('.workspace-branch:not(.recent-conversations)').length===2`,
				),
			"three sections and two real projects",
		);
		startup.expectedSidebarReady = true;
	} catch (error) {
		// Observe the failed startup before any repair; never click Retry or mutate runtime state.
		let diagnostic;
		try {
			diagnostic = await evaluate(
				cdp,
				`(${sidebarStartupDiagnostic.toString()})(${JSON.stringify({ workspaceIds: seed.workspaceIds, defaultWorkspaceId: seed.defaultWorkspaceId, handshake: seed.handshake })},window.hipiWorkDesktop,window.localStorage)`,
			);
		} catch {
			diagnostic = { status: "capture_unavailable" };
		}
		try {
			await writeFile(join(directory, "sidebar-startup-diagnostic.json"), `${JSON.stringify(diagnostic, null, 2)}\n`);
		} catch {
			// A diagnostic write failure must not replace the original startup failure.
		}
		throw error;
	} finally {
		try {
			await writeFile(join(directory, "sidebar-startup-lifecycle.json"), `${JSON.stringify(startup, null, 2)}\n`);
		} catch {
			// Retaining lifecycle evidence must not replace the original startup failure.
		}
	}
	const actions = [];
	const geometry = [];
	const observeGeometry = async (stage, qualify = true) => {
		try {
			geometry.push({ stage, value: await evaluate(cdp, `(${sidebarShellGeometry.toString()})(document)`) });
		} catch {
			geometry.push({ stage, unavailable: true });
		}
		await writeFile(
			join(directory, `sidebar-shell-geometry-${reopened ? "cold" : "first"}.json`),
			`${JSON.stringify({ geometry }, null, 2)}\n`,
		);
		if (qualify) {
			assert.ok(geometry.at(-1).value, "Native geometry observation unavailable");
			assertSidebarShellGeometry(geometry.at(-1).value);
		}
	};
	await observeGeometry("ready before native journey");
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
		const aliasSelection = await exerciseAliasSelection(cdp, seed, observeGeometry);
		await observeGeometry("after alias selection");
		actions.push({ name: "native project Recent alias ownership and disclosure fallback", aliasSelection });
		record({ sidebarAction: "native project Recent alias ownership and disclosure fallback" });
		const newChatContext = await exerciseNewChatContext(cdp, seed, directory, observeGeometry);
		await observeGeometry("after New chat context");
		actions.push({ name: "native New chat project inheritance and shared draft", newChatContext });
		record({ sidebarAction: "native New chat project inheritance and shared draft" });
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
		const keyboardNavigation = await exerciseSidebarKeyboard({ cdp, seed, directory });
		actions.push({ name: "CDP sidebar keyboard traversal and ownership", keyboardNavigation });
		record({ sidebarAction: "CDP sidebar keyboard traversal and ownership" });
		await evaluate(
			cdp,
			`void(window.__sidebarContinuity={panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll')})`,
		);
		const baseline = await readState(cdp);
		assert.equal(baseline.draft, seed.draft);
		assert.equal(baseline.messages.length, 2, "Continuity needs actual persisted history rows");
		const contextMenus = await exerciseSidebarContextMenus({ cdp, seed, directory });
		actions.push({ name: "native conversation context and ellipsis menus", contextMenus });
		record({ sidebarAction: "native conversation context and ellipsis menus" });
		const continuity = async () => {
			const current = await readState(cdp);
			assert.equal(current.draft, baseline.draft);
			assert.deepEqual(current.messages, baseline.messages);
			if (!current.collapsed.pinned)
				assert.deepEqual(
					current.selected,
					[seed.pins[0]],
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
			await observeGeometry(name);
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
		const projectHoverPublication = await exerciseProjectHoverPublication({ cdp, directory, seed });
		await completed("project hover survives completed background publication probe");
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
			projectHoverPublication,
			autoscroll: { observed: true, initialScroll, outside },
			final: layout(finalState),
		};
	} catch (error) {
		failure = error.message;
		throw error;
	} finally {
		await observeGeometry(failure ? "journey failure" : "journey completion", !failure);
		await writeFile(
			join(directory, `sidebar-actions-${reopened ? "cold" : "first"}.json`),
			`${JSON.stringify({ actions, failure, state: await readState(cdp) }, null, 2)}\n`,
		);
		await evaluate(cdp, "delete window.__sidebarContinuity");
	}
}
