import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, click, evaluate, hover, pressKey, until } from "./gui-flow.mjs";
import { nativeEditorKey } from "./gui-work-experience.mjs";

/** Renderer-only observer. Native input, never DOM dispatch, supplies the expected row owner. */
export function startSidebarHoverTrace(document, targets) {
	const view = document.defaultView;
	const trace = { targets, armedAt: view.performance.now(), moves: [], frames: [], truncated: false };
	let owner = null;
	let frame;
	let stopped = false;
	let coldOpened;
	const cold = new Promise((resolve) => {
		coldOpened = resolve;
	});
	const moved = (event) => {
		const entered = event.target.closest?.(".sidebar-preview-row")?.getAttribute("aria-labelledby") ?? null;
		if (entered) owner = entered;
		trace.moves.push({
			at: view.performance.now(),
			owner: entered,
			cardOwner: event.target.closest?.(".conversation-preview-card")?.getAttribute("aria-labelledby") ?? null,
			x: event.clientX,
			y: event.clientY,
			trusted: event.isTrusted,
		});
	};
	const sample = () => {
		if (stopped) return;
		const cards = [...document.querySelectorAll(".conversation-preview-card")].map((card) => {
			const rect = card.getBoundingClientRect();
			const style = view.getComputedStyle(card);
			const title = card.querySelector(".preview-title, .project-preview-title");
			const titleRect = title?.getBoundingClientRect();
			let visibleAncestors = true;
			let opacity = 1;
			for (let node = card; node; node = node.parentElement) {
				const computed = view.getComputedStyle(node);
				visibleAncestors &&= computed.display !== "none" && computed.visibility === "visible";
				opacity *= Number(computed.opacity);
			}
			const bounds = {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				viewportWidth: view.innerWidth,
				viewportHeight: view.innerHeight,
			};
			const positioned =
				rect.width > 0 &&
				rect.height > 0 &&
				rect.x >= 0 &&
				rect.y >= 0 &&
				rect.right <= view.innerWidth + 1 &&
				rect.bottom <= view.innerHeight + 1;
			const hit = card.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
			const visible = visibleAncestors && opacity === 1;
			const interactive = style.pointerEvents !== "none" && !card.closest("[inert]") && hit;
			const text = (selector) => [...card.querySelectorAll(selector)].map((node) => node.textContent.trim());
			return {
				owner: card.getAttribute("aria-labelledby"),
				...bounds,
				positioned,
				visible,
				interactive,
				hit,
				opacity,
				display: style.display,
				visibility: style.visibility,
				pointerEvents: style.pointerEvents,
				animationName: style.animationName,
				runningAnimations: card.getAnimations().filter((animation) => animation.playState === "running").length,
				title: title?.textContent ?? null,
				contentFits:
					!!titleRect &&
					titleRect.x >= rect.x &&
					titleRect.y >= rect.y &&
					titleRect.right <= rect.right + 1 &&
					titleRect.bottom <= rect.bottom + 1 &&
					title.scrollWidth <= title.clientWidth + 1 &&
					title.scrollHeight <= title.clientHeight + 1,
				metadata: {
					titles: text(".preview-title, .project-preview-title"),
					created: [...card.querySelectorAll(".preview-created")].map((node) => node.getAttribute("datetime")),
					workspaces: text(".preview-workspace"),
					projects: card.querySelectorAll(".project-preview-content").length,
					projectMetadata: text(".project-preview-meta"),
				},
			};
		});
		trace.frames.push({
			at: view.performance.now(),
			owner,
			cards,
			focusedCardOwner:
				document.activeElement?.closest?.(".conversation-preview-card")?.getAttribute("aria-labelledby") ?? null,
			focusedRowOwner:
				document.activeElement?.closest?.(".sidebar-preview-row")?.getAttribute("aria-labelledby") ?? null,
		});
		if (owner === targets[0].owner && cards.some((card) => card.positioned && card.visible && card.interactive))
			coldOpened(true);
		if (trace.frames.length >= 600) {
			trace.truncated = true;
			stop();
		} else frame = view.requestAnimationFrame(sample);
	};
	const stop = () => {
		stopped = true;
		view.cancelAnimationFrame(frame);
		document.removeEventListener("pointermove", moved, true);
		coldOpened(false);
		return trace;
	};
	document.addEventListener("pointermove", moved, true);
	frame = view.requestAnimationFrame(sample);
	return {
		stop,
		async coldOpen() {
			let timer;
			try {
				return await Promise.race([
					cold,
					new Promise((resolve) => {
						timer = view.setTimeout(() => resolve(false), 3000);
					}),
				]);
			} finally {
				view.clearTimeout(timer);
			}
		},
	};
}

export function assertSidebarHoverTrace(trace, expectedOwners = 3) {
	assert.ok(expectedOwners === 2 || expectedOwners === 3, "Explicit two- or three-owner qualification required");
	assert.equal(trace.truncated, false, "Frame trace exceeded its bound; native qualification is incomplete");
	assert.equal(trace.targets.length, expectedOwners, "The probe must cover every declared cold/warm owner");
	assert.equal(
		new Set(trace.targets.map((target) => target.owner)).size,
		expectedOwners,
		"Each row needs its own DOM owner",
	);
	assert.deepEqual(
		trace.moves.map((move) => move.owner),
		trace.targets.map((target) => target.owner),
		"Native moves must visit the exact declared rows",
	);
	for (const [index, move] of trace.moves.entries()) {
		assert.ok(Number.isFinite(move.at) && move.at >= (trace.moves[index - 1]?.at ?? trace.armedAt));
		assert.equal(move.trusted, true, "Untrusted input is not native qualification");
		assert.equal(move.x, trace.targets[index].point.x);
		assert.equal(move.y, trace.targets[index].point.y);
	}
	let openedAt = null;
	const sampledOwners = new Set();
	for (const [index, frame] of trace.frames.entries()) {
		const label = `Frame ${index} at ${frame.at} for ${frame.owner}`;
		assert.ok(Number.isFinite(frame.at) && frame.at >= (trace.frames[index - 1]?.at ?? trace.armedAt), label);
		assert.equal(frame.owner, trace.moves.filter((move) => move.at <= frame.at).at(-1)?.owner ?? null, label);
		for (const card of frame.cards) {
			assert.equal(card.animationName, "none", `${label}: card entrance animation must not mask a gap`);
			assert.equal(card.runningAnimations, 0, `${label}: card must not animate its entrance`);
		}
		if (openedAt === null) {
			assert.ok(frame.cards.length <= 1, `${label}: cold entry must not duplicate cards`);
			if (!frame.cards.some((card) => card.positioned && card.visible && card.interactive)) {
				assert.ok(
					frame.owner === null || frame.owner === trace.targets[0].owner,
					`${label}: cold allowance cannot hide a warm gap`,
				);
				continue;
			}
			assert.equal(frame.owner, trace.targets[0].owner, `${label}: first card must belong to cold A`);
			openedAt = frame.at;
			assert.ok(openedAt - trace.moves[0].at >= 150, "Cold A must retain its ordinary hover delay");
		}
		assert.equal(frame.cards.length, 1, `${label}: exactly one card must remain mounted`);
		const card = frame.cards[0];
		const target = trace.targets.find((candidate) => candidate.owner === frame.owner);
		assert.ok(target, `${label}: input must identify a measured row`);
		assert.equal(card.owner, target.owner, `${label}: stale or competing row owner`);
		assert.equal(card.positioned, true, `${label}: card must already be positioned`);
		assert.equal(card.visible, true, `${label}: card must remain fully visible`);
		assert.equal(card.interactive, true, `${label}: card must remain interactive`);
		assertPreviewBounds({ ...card, title: card.title === target.title });
		assert.deepEqual(card.metadata, target.metadata, `${label}: stale or missing row metadata`);
		sampledOwners.add(frame.owner);
	}
	assert.ok(openedAt !== null, "Cold A never produced a visible interactive card");
	assert.deepEqual(
		[...sampledOwners],
		trace.targets.map((target) => target.owner),
		"Every owner needs rAF evidence",
	);
	for (let index = 1; index < trace.moves.length; index++) {
		const previous = index === 1 ? openedAt : trace.moves[index - 1].at;
		assert.ok(
			trace.moves[index].at >= previous && trace.moves[index].at - previous < 300,
			"CDP input arrived outside the warm window; native qualification is inconclusive",
		);
	}
	return { frames: trace.frames.length, owners: [...sampledOwners], coldDelayMs: openedAt - trace.moves[0].at };
}

export function assertSidebarHoverProtection(trace, { initialOwner, moves, handoffOwner, focus }) {
	assert.equal(trace.truncated, false, "Protection trace must not be truncated");
	assert.deepEqual(
		trace.moves.map(({ owner, cardOwner, x, y, trusted }) => ({ owner, cardOwner, x, y, trusted })),
		moves.map((move) => ({ ...move, trusted: true })),
		"Protection probe must observe every intended native movement",
	);
	assert.ok(trace.frames.length > 0, "Protection probe needs frame evidence");
	assert.ok(
		trace.frames.at(-1).at >= trace.moves.at(-1).at,
		"Protection probe must sample after its last actual native movement",
	);
	const observed = new Set();
	for (const [index, frame] of trace.frames.entries()) {
		assert.ok(Number.isFinite(frame.at) && frame.at >= (trace.frames[index - 1]?.at ?? trace.armedAt));
		assert.equal(frame.owner, trace.moves.filter((move) => move.at <= frame.at && move.owner).at(-1)?.owner ?? null);
		const expectedOwner = handoffOwner && frame.owner === handoffOwner ? handoffOwner : initialOwner;
		const target = trace.targets.find((target) => target.owner === expectedOwner);
		assert.ok(target, `Protection frame ${index}: expected row must be measured`);
		assert.equal(frame.cards.length, 1, `Protection frame ${index}: exactly one card must remain`);
		const card = frame.cards[0];
		assert.equal(card.owner, expectedOwner, `Protection frame ${index}: wrong preview owner`);
		assert.equal(card.animationName, "none");
		assert.equal(card.runningAnimations, 0);
		assert.equal(card.positioned, true);
		assert.equal(card.visible, true);
		assert.equal(card.interactive, true);
		assertPreviewBounds({ ...card, title: card.title === target.title });
		assert.deepEqual(card.metadata, target.metadata);
		if (focus) assert.equal(frame[focus.field], focus.owner, `Protection frame ${index}: native focus changed`);
		observed.add(expectedOwner);
	}
	assert.ok(observed.has(initialOwner), "Protection must sample the original preview before moving");
	if (handoffOwner) assert.ok(observed.has(handoffOwner), "Row-only focus must allow an observed pointer handoff");
	return { frames: trace.frames.length, owners: [...observed], input: "native-cdp" };
}

async function sampleSidebarHover(cdp, directory, name, targets, move) {
	let trace;
	let failure;
	try {
		await evaluate(
			cdp,
			`void (window.__hipiSidebarHoverFrames=(${startSidebarHoverTrace.toString()})(document,${JSON.stringify(targets)}))`,
		);
		await move();
	} catch (error) {
		failure = error;
	} finally {
		try {
			trace = await evaluate(
				cdp,
				"(()=>{const trace=window.__hipiSidebarHoverFrames?.stop();delete window.__hipiSidebarHoverFrames;return trace})()",
			);
			await writeFile(
				join(directory, `${name}.json`),
				`${JSON.stringify({ trace, failure: failure?.message ?? null }, null, 2)}\n`,
			);
		} catch (error) {
			failure = failure ? new AggregateError([failure, error], "Hover probe and trace capture failed") : error;
		}
	}
	if (failure) throw failure;
	return trace;
}

async function sampleTwoFrames(cdp) {
	await evaluate(cdp, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
}

async function exercisePreviewCorridor(cdp, directory, link, title) {
	const geometry = await evaluate(
		cdp,
		`(()=>{
			const source=document.querySelector(${JSON.stringify(link)}),row=source.closest('.sidebar-preview-row'),card=document.querySelector('.conversation-preview-card');
			const r=row.getBoundingClientRect(),c=card.getBoundingClientRect(),s=source.getBoundingClientRect();
			const start={x:s.x+s.width/2,y:s.y+s.height/2},end={x:Math.round(c.x+c.width/2),y:Math.round(c.y+c.height/2)},gapX=Math.round((r.right+c.x)/2);
			const gap={x:gapX,y:Math.round(start.y+(end.y-start.y)*(gapX-start.x)/(end.x-start.x))};
			return {owner:row.getAttribute('aria-labelledby'),created:card.querySelector('.preview-created')?.getAttribute('datetime'),gap,end,gapWidth:c.x-r.right,gapHit:!row.contains(document.elementFromPoint(gap.x,gap.y))&&!card.contains(document.elementFromPoint(gap.x,gap.y))};
		})()`,
	);
	assert.ok(geometry.gapWidth > 0 && geometry.gapHit, "Corridor needs an actual gap outside both row and card");
	assert.ok(Number.isFinite(Date.parse(geometry.created)), "Corridor needs the actual creation metadata");
	const target = {
		owner: geometry.owner,
		title,
		metadata: { titles: [title], created: [geometry.created], workspaces: [], projects: 0, projectMetadata: [] },
	};
	const trace = await sampleSidebarHover(cdp, directory, "sidebar-corridor-frames", [target], async () => {
		await sampleTwoFrames(cdp);
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...geometry.gap });
		await sampleTwoFrames(cdp);
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...geometry.end });
		await sampleTwoFrames(cdp);
	});
	const result = assertSidebarHoverProtection(trace, {
		initialOwner: geometry.owner,
		moves: [
			{ owner: null, cardOwner: null, ...geometry.gap },
			{ owner: null, cardOwner: geometry.owner, ...geometry.end },
		],
	});
	assert.ok(trace.moves[1].at - trace.moves[0].at < 100, "Native corridor hop exceeded the leave grace period");
	return { ...result, trace: "sidebar-corridor-frames.json", sustainedTimerExtension: "not_qualified" };
}

async function exerciseSidebarFocusProtection(cdp, directory, project, recent, title, created) {
	const targets = await evaluate(
		cdp,
		`[${JSON.stringify(`${project} .project-open`)},${JSON.stringify(recent)}].map(selector=>{
			const node=document.querySelector(selector),rect=node.getBoundingClientRect();
			const point={x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
			return {owner:node.closest('.sidebar-preview-row').getAttribute('aria-labelledby'),point,hit:node.contains(document.elementFromPoint(point.x,point.y))};
		})`,
	);
	assert.ok(
		targets.every((target) => target.hit),
		"Focus protection needs both measured row centers",
	);
	for (const [index, target] of targets.entries()) {
		target.title = index === 0 ? "GUI disclosure empty project" : title;
		target.metadata = {
			titles: [target.title],
			created: index === 0 ? [] : [created],
			workspaces: [],
			projects: index === 0 ? 1 : 0,
			projectMetadata: index === 0 ? ["0 chats", "No local folder connected"] : [],
		};
	}
	const moves = [{ owner: targets[1].owner, cardOwner: null, ...targets[1].point }];
	const blockedTrace = await sampleSidebarHover(cdp, directory, "sidebar-card-focus-frames", targets, async () => {
		await sampleTwoFrames(cdp);
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...targets[1].point });
		await sampleTwoFrames(cdp);
	});
	const cardFocus = assertSidebarHoverProtection(blockedTrace, {
		initialOwner: targets[0].owner,
		moves,
		focus: { field: "focusedCardOwner", owner: targets[0].owner },
	});
	await nativeEditorKey(cdp, "Tab", { modifiers: 8 });
	await sampleTwoFrames(cdp);
	assert.equal(
		await evaluate(
			cdp,
			`document.activeElement===document.querySelector(${JSON.stringify(`${project} .project-open`)}) && document.querySelector('.conversation-preview-card')?.getAttribute('aria-labelledby')===${JSON.stringify(targets[0].owner)}`,
		),
		true,
		"Shift Tab must retain the project card and return native focus to its row",
	);
	// The pointer must genuinely re-enter Recent after focus returns, not remain stationary there.
	await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...targets[0].point });
	await sampleTwoFrames(cdp);
	const rowTrace = await sampleSidebarHover(cdp, directory, "sidebar-row-focus-frames", targets, async () => {
		await sampleTwoFrames(cdp);
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...targets[1].point });
		await sampleTwoFrames(cdp);
	});
	const rowFocus = assertSidebarHoverProtection(rowTrace, {
		initialOwner: targets[0].owner,
		handoffOwner: targets[1].owner,
		moves,
		focus: { field: "focusedRowOwner", owner: targets[0].owner },
	});
	return {
		cardFocus: { ...cardFocus, trace: "sidebar-card-focus-frames.json" },
		rowFocus: { ...rowFocus, trace: "sidebar-row-focus-frames.json" },
	};
}

// Pinned rows are excluded from Recent. Three-owner continuous travel is qualified
// by the dedicated sidebar journey; this baseline preserves the cross-type handoff.
async function exerciseWarmSidebarHover(cdp, directory, scope, title) {
	const pinned = `.pinned-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
	const project = ".workspace-branch:not(.recent-conversations) .project-open";
	// Resolve fixture metadata before measurement, then let the shared warm interval expire.
	await hover(cdp, pinned);
	const created = await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.conversation-preview-card .preview-workspace')?.textContent.trim()==='Chats' && document.querySelector('.conversation-preview-card .preview-created')?.getAttribute('datetime')`,
			),
		"pinned fixture metadata is resolved before sampling",
	);
	assert.ok(Number.isFinite(Date.parse(created)), "The fixture needs its actual creation timestamp");
	await capture(cdp, directory, "sidebar-warm-pinned-source");
	await hover(cdp, project);
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.project-preview-title')?.textContent==='GUI disclosure empty project' && document.querySelector('.project-preview-meta:not(.project-preview-path)')?.textContent==='0 chats' && document.querySelector('.project-preview-path')?.textContent==='No local folder connected'`,
			),
		"project fixture metadata is resolved before sampling",
	);
	await hover(cdp, ".app-toolbar");
	await until(
		() => evaluate(cdp, "!document.querySelector('.conversation-preview-card')"),
		"prewarm preview closes before cold A",
	);
	await new Promise((resolve) => setTimeout(resolve, 350));
	const targets = await evaluate(
		cdp,
		`[${[pinned, project].map((selector) => JSON.stringify(selector)).join(",")}].map(selector=>{
			const nodes=[...document.querySelectorAll(selector)];
			if(nodes.length!==1)return null;
			const node=nodes[0],rect=node.getBoundingClientRect(),point={x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
			const owner=node.closest('.sidebar-preview-row')?.getAttribute('aria-labelledby');
			return owner&&rect.width>0&&rect.height>0&&node.contains(document.elementFromPoint(point.x,point.y))?{owner,point}:null;
		})`,
	);
	assert.ok(targets.every(Boolean), "Both actual row centers must be unobstructed before sampling");
	for (const [index, target] of targets.entries()) {
		target.title = index === 1 ? "GUI disclosure empty project" : title;
		target.metadata = {
			titles: [target.title],
			created: index === 1 ? [] : [created],
			workspaces: index === 0 ? ["Chats"] : [],
			projects: index === 1 ? 1 : 0,
			projectMetadata: index === 1 ? ["0 chats", "No local folder connected"] : [],
		};
	}
	const trace = await sampleSidebarHover(cdp, directory, "sidebar-warm-hover-frames", targets, async () => {
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...targets[0].point });
		assert.equal(
			await evaluate(cdp, "window.__hipiSidebarHoverFrames.coldOpen()"),
			true,
			"Cold A did not become visible before the bounded observation deadline",
		);
		for (const target of targets.slice(1)) {
			// No target lookup, readiness polling or settled screenshot may hide an intervening frame.
			await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...target.point });
			await sampleTwoFrames(cdp);
		}
	});
	const result = assertSidebarHoverTrace(trace, 2);
	await capture(cdp, directory, "sidebar-warm-project-result");
	return { ...result, created, trace: "sidebar-warm-hover-frames.json", input: "native-cdp" };
}

export function assertPreviewBounds(value) {
	assert.ok(
		value &&
			[value.x, value.y, value.width, value.height, value.viewportWidth, value.viewportHeight].every(Number.isFinite),
	);
	assert.ok(
		value.width > 0 &&
			value.height > 0 &&
			value.x >= 0 &&
			value.y >= 0 &&
			value.x + value.width <= value.viewportWidth + 1 &&
			value.y + value.height <= value.viewportHeight + 1,
		"Preview must fit actual viewport",
	);
	assert.equal(value.hit, true, "Preview must remain pointer-reachable");
	assert.equal(value.title, true, "Preview must contain complete exact title");
	assert.equal(value.contentFits, true, "Preview title must fit its card without clipping or horizontal overflow");
}

export async function exerciseSidebarHover(cdp, directory, scope, originalTitle) {
	for (const value of [scope.workspaceId, scope.conversationId]) assert.match(value, /^[A-Za-z0-9_-]{1,128}$/);
	const branch = ".recent-conversations";
	const link = `${branch} .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
	const pinnedLink = `.pinned-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
	const row = `${branch} .conversation-nav-item:has(.conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"])`;
	const longTitle =
		"GUI sidebar long title 中文 overflow acceptance with retained conversation identity and complete preview";
	const read = (expression) => evaluate(cdp, expression);
	const check = (expression, label) => until(() => read(expression), label);
	const rename = async (title) => {
		await click(cdp, "header .conversation-actions-trigger");
		await click(cdp, '[role="menuitem"]', "Rename conversation");
		await click(cdp, ".conversation-rename-input");
		await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
		await nativeEditorKey(cdp, "Backspace");
		await cdp.request("Input.insertText", { text: title });
		await click(cdp, ".conversation-rename-save");
		await check(
			`!document.querySelector('.conversation-rename-dialog') && document.querySelector(${JSON.stringify(link)})?.textContent===${JSON.stringify(title)}`,
			"actual rename commits exact title",
		);
	};
	await read(
		`void (window.__hipiSidebarContinuity={projectIds:[...document.querySelectorAll('.workspace-branch[data-workspace-id]')].map(e=>e.dataset.workspaceId),panel:document.querySelector('.conversation-panel'),composer:document.querySelector('.composer textarea'),history:document.querySelector('.message-scroll'),draft:document.querySelector('.composer textarea').value,ids:[...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId)})`,
	);
	const continuity = async () =>
		assert.equal(
			await read(
				`(()=>{const b=window.__hipiSidebarContinuity;return b.panel===document.querySelector('.conversation-panel')&&b.composer===document.querySelector('.composer textarea')&&b.history===document.querySelector('.message-scroll')&&b.composer.value===b.draft&&JSON.stringify(b.ids)===JSON.stringify([...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId))&&JSON.stringify(b.projectIds)===JSON.stringify([...document.querySelectorAll('.workspace-branch[data-workspace-id]')].map(e=>e.dataset.workspaceId))})()`,
			),
			true,
			"Sidebar actions must retain actual conversation, draft, history and workspace identities",
		);
	const filter = async (text) => {
		await click(cdp, `${branch} .recent-actions-trigger`);
		await click(cdp, '[role="menuitemradio"]', text);
		await check(`!document.querySelector('[role="menu"]')`, "Recent filter menu closes");
	};
	let warmPinnedToProject;
	try {
		await rename(longTitle);
		await hover(cdp, ".app-toolbar");
		await check("!document.querySelector('.conversation-preview-card')", "prior preview closes");
		// A closed card can still leave the shared hover context warm for 300 ms.
		await new Promise((resolve) => setTimeout(resolve, 350));
		await cdp.request("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
		});
		const hoverStart = await read("performance.now()");
		await hover(cdp, link);
		const early = await read(
			`({elapsed:performance.now()-${hoverStart},card:!!document.querySelector('.conversation-preview-card')})`,
		);
		if (early.elapsed < 150)
			assert.equal(early.card, false, "Ordinary title hover must not open its preview immediately");
		await check(
			`document.querySelector(${JSON.stringify(`${link} .sidebar-title`)})?.dataset.overflowing==='true' && document.querySelector(${JSON.stringify(`${link} .sidebar-title`)})?.dataset.hovered==='true'`,
			"actual long title overflows while hovered",
		);
		const motion = await read(
			`getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).animationName`,
		);
		assert.equal(
			motion === "none",
			await read("document.documentElement.dataset.reducedMotion==='on'"),
			"Only the explicit reduced-motion preference may suppress travel under no-preference media",
		);
		if (motion !== "none")
			await check(
				`new DOMMatrixReadOnly(getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).transform).m41 < -1`,
				"long title actually travels after its hover delay",
			);
		await check("!!document.querySelector('.conversation-preview-card')", "delayed conversation preview appears");
		const bounds = await read(
			`(()=>{const c=document.querySelector('.conversation-preview-card'),r=c.getBoundingClientRect(),t=c.querySelector('.preview-title'),tr=t.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,hit:c.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),title:t.textContent===${JSON.stringify(longTitle)},contentFits:tr.x>=r.x&&tr.y>=r.y&&tr.right<=r.right+1&&tr.bottom<=r.bottom+1&&t.scrollWidth<=t.clientWidth+1&&t.scrollHeight<=t.clientHeight+1}})()`,
		);
		assertPreviewBounds(bounds);
		const corridor = await exercisePreviewCorridor(cdp, directory, link, longTitle);
		await check("!!document.querySelector('.conversation-preview-card')", "pointer transfers into retained preview");
		await capture(cdp, directory, "sidebar-long-title-preview");
		await hover(cdp, ".app-toolbar");
		await check("!document.querySelector('.conversation-preview-card')", "pointer leave dismisses card");
		await check(
			`getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).transform==='none'`,
			"leaving row resets title travel",
		);
		await cdp.request("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await hover(cdp, link);
		const reduced = await read(
			`document.documentElement.dataset.reducedMotion==='off' ? 'explicit-off' : getComputedStyle(document.querySelector(${JSON.stringify(`${link} .sidebar-title-content`)})).animationName`,
		);
		assert.ok(reduced === "none" || reduced === "explicit-off");
		await hover(cdp, ".app-toolbar");
		await cdp.request("Emulation.setEmulatedMedia", { features: [] });
		for (const pinned of [true, false]) {
			await hover(cdp, pinned ? link : pinnedLink);
			const actionRow = pinned
				? row
				: `.pinned-conversations [data-pinned-conversation][data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]`;
			await click(cdp, `${actionRow} [data-action="pin-conversation-direct"]`);
			await check(
				`document.querySelectorAll('.pinned-conversations .conversation-link').length===${pinned ? 1 : 0} && document.querySelectorAll('.pinned-conversations .conversation-link[data-workspace-id="${scope.workspaceId}"][data-conversation-id="${scope.conversationId}"]').length===${pinned ? 1 : 0} && document.querySelectorAll(${JSON.stringify(link)}).length===${pinned ? 0 : 1}`,
				"direct pin moves the exact row exclusively between Recent and Pinned",
			);
			await continuity();
			if (pinned) warmPinnedToProject = await exerciseWarmSidebarHover(cdp, directory, scope, longTitle);
			else
				await check(
					`document.activeElement===document.querySelector(${JSON.stringify(link)})`,
					"direct unpin returns focus to the exact restored canonical row",
				);
		}
		await hover(cdp, link);
		await click(cdp, `${row} [data-action="archive-conversation-direct"]`);
		await check(
			`!document.querySelector(${JSON.stringify(link)}) && document.activeElement===document.querySelector(${JSON.stringify(`${branch} .project-conversations`)})`,
			"archive removes list row and restores list boundary focus",
		);
		await continuity();
		await filter("Archived conversations");
		await check(`!!document.querySelector(${JSON.stringify(link)})`, "same canonical archived conversation appears");
		await hover(cdp, link);
		await click(cdp, `${row} [data-action="restore-conversation-direct"]`);
		await check(
			`!document.querySelector(${JSON.stringify(link)}) && document.activeElement===document.querySelector(${JSON.stringify(`${branch} .project-conversations`)})`,
			"restore removes archived row and restores boundary focus",
		);
		await filter("Active conversations");
		await check(`!!document.querySelector(${JSON.stringify(link)})`, "original active conversation returns");
		await rename(originalTitle);
		await continuity();
		const project = ".workspace-branch:not(.recent-conversations)";
		await hover(cdp, `${project} .project-open`);
		await click(cdp, `${project} .project-actions-trigger`);
		await pressKey(cdp, "Escape");
		await nativeEditorKey(cdp, "Tab", { modifiers: 8 });
		await check(
			`document.activeElement===document.querySelector('${project} .project-open') && !!document.querySelector('.project-preview-content')`,
			"keyboard focus opens actual project card",
		);
		await nativeEditorKey(cdp, "Tab");
		await check(
			"document.querySelector('.project-preview-content')?.contains(document.activeElement)",
			"Tab enters project card control",
		);
		const focusProtection = await exerciseSidebarFocusProtection(
			cdp,
			directory,
			project,
			link,
			originalTitle,
			warmPinnedToProject.created,
		);
		await hover(cdp, `${project} .project-open`);
		await check(
			`document.activeElement===document.querySelector('${project} .project-open') && !!document.querySelector('.project-preview-content')`,
			"Shift Tab returns to project without dismissing card",
		);
		await nativeEditorKey(cdp, "Tab");
		await capture(cdp, directory, "sidebar-project-card-keyboard");
		await pressKey(cdp, "Escape");
		await check(
			`!document.querySelector('.conversation-preview-card') && document.activeElement===document.querySelector('${project} .project-open')`,
			"Escape closes project card and restores origin",
		);
		await continuity();
		return {
			longTitleOverflow: true,
			hoverDelay: early.elapsed < 150 ? "observed_not_immediate" : "not_run_observation_arrived_after_delay",
			titleMotion: motion === "none" ? "disabled_by_preference" : "observed",
			reducedMotion: reduced === "none" ? "observed" : "not_run_explicit_override",
			cardBounds: bounds,
			pointerTransfer: true,
			pointerCorridor: corridor,
			warmPinnedToProject,
			focusProtection,
			directPinRoundTrip: true,
			archiveRestoreRoundTrip: true,
			projectKeyboardReturn: true,
			originalTitleRestored: true,
		};
	} finally {
		await cdp.request("Emulation.setEmulatedMedia", { features: [] });
		await read("delete window.__hipiSidebarContinuity");
	}
}
