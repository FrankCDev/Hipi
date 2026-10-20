// Real packaged-window interaction, not a model DOM acceptance substitute.
import assert from "node:assert/strict";
import {
	assertNoAlerts,
	capture,
	click,
	evaluate,
	fixture,
	receiptScope,
	selectEnglish,
	until,
	waitForOverlayClosed,
} from "./gui-flow.mjs";

export function executionState(document) {
	const controls = document.querySelector(".conversation-model-controls");
	if (
		!controls ||
		document.querySelector(".conversation-panel .connection-bar") ||
		controls.querySelector('[role="alert"]')
	)
		return "unknown";
	if (controls.querySelector(".model-status-trigger")?.textContent.trim() !== "faux-1") return "unknown";
	const states = [...controls.querySelectorAll(":scope > .model-state")].map((e) => e.textContent.trim());
	const cancel = [...controls.querySelectorAll("button")].some((e) => e.textContent.trim() === "Cancel execution");
	if (states.length === 1 && states[0] === "Running" && cancel) return "running";
	if (states.length === 0 && !cancel) return "ready";
	return "unknown";
}

export function viewport(document) {
	const host = document.querySelector(".message-scroll");
	if (!host) return null;
	const box = host.getBoundingClientRect();
	const rows = [...host.querySelectorAll("[data-message-key]")].map((e) => {
		const r = e.getBoundingClientRect();
		return {
			key: e.dataset.messageKey,
			index: Number(e.dataset.index),
			top: r.top - box.top,
			height: r.height,
			visible: r.bottom > box.top && r.top < box.bottom,
			text: e.textContent,
			content: e.querySelector(".message-content > .message-text")?.textContent ?? null,
		};
	});
	const state = executionState(document);
	return {
		scrollTop: host.scrollTop,
		scrollHeight: host.scrollHeight,
		clientHeight: host.clientHeight,
		box: { x: box.x, y: box.y, width: box.width, height: box.height },
		rows,
		jump: !!document.querySelector(".jump-latest"),
		loading: !!document.querySelector(".history-status"),
		running: state === "running",
		executionState: state,
		partial: rows.find((r) => r.key === "partial-output")?.content ?? null,
	};
}

export function anchored(before, after, key, tolerance = 4) {
	const a = before.rows.find((r) => r.key === key);
	const b = after.rows.find((r) => r.key === key);
	assert.ok(a && b, "Reading anchor must remain mounted");
	assert.ok(Number.isFinite(a.top) && Number.isFinite(b.top), "Anchor geometry must be finite");
	assert.ok(Math.abs(b.top - a.top) <= tolerance, `Anchor moved: ${a.top} -> ${b.top}`);
	return { key, before: a.top, after: b.top, tolerance };
}

export function addPartial(samples, observation) {
	if (observation.running && typeof observation.partial === "string" && observation.partial.trim())
		samples.add(observation.partial);
	return samples.size;
}

/** Keep start-time diagnostics even when a brief execution never satisfies both predicates. */
export function observeExecution(document, read) {
	const started = performance.now();
	const samples = [];
	let previous;
	let runningSeen = false;
	let partialSeen = false;
	const take = () => {
		const value = read(document);
		if (!value) return;
		runningSeen ||= value.running;
		partialSeen ||= typeof value.partial === "string" && value.partial.trim().length > 0;
		const current = { state: value.executionState, partialUnits: value.partial?.length ?? 0 };
		if (previous?.state === current.state && previous?.partialUnits === current.partialUnits) return;
		previous = current;
		if (samples.length === 128) samples.shift();
		samples.push({ ...current, elapsedMs: Math.round(performance.now() - started) });
	};
	const observer = new MutationObserver(take);
	observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true });
	take();
	return {
		stop() {
			observer.disconnect();
			return { runningSeen, partialSeen, samples };
		},
	};
}

// Bounded passive observations only. The owning scenario removes every observer in finally.
export function observePrepend(document, read, key) {
	const host = document.querySelector(".message-scroll");
	const samples = [];
	const take = () => {
		const value = read(document);
		const row = value?.rows.find((r) => r.key === key);
		if (row) {
			if (samples.length === 128) samples.shift();
			samples.push({ scrollTop: value.scrollTop, rows: [row] });
		}
	};
	const observer = new MutationObserver(take);
	host.addEventListener("scroll", take, { passive: true });
	observer.observe(host, { childList: true, subtree: true, attributes: true });
	take();
	return {
		samples,
		stop() {
			observer.disconnect();
			host.removeEventListener("scroll", take);
		},
	};
}

export function prependEvidence(samples, before, finalAfter, key) {
	const initial = before.rows.find((r) => r.key === key);
	assert.ok(initial, "Initial prepend anchor missing");
	const candidates = samples.filter((v) => v.scrollTop < before.scrollTop && v.rows[0].index === initial.index);
	// Last observed old-index geometry is the consumed wheel baseline, not requested delta.
	const baseline = candidates.at(-1);
	if (!baseline) return { status: "notvalidated", reason: "No observed post-wheel/pre-prepend anchor baseline" };
	if (!finalAfter.rows.some((row) => row.key === key && row.index > initial.index))
		return { status: "notvalidated", reason: "No observed prepend" };
	return { status: "validated", observedBaselineCount: candidates.length, ...anchored(baseline, finalAfter, key) };
}

export function assertLongHistoryAcceptance(first, reopened) {
	for (const report of [first, reopened]) {
		assert.equal(report.prepend.status, "validated", "History prepend geometry was not validated");
		assert.equal(report.oldestReached, true);
		assert.equal(report.expansion.status, "validated");
		assert.equal(report.scopeIsolation, true);
	}
	assert.equal(first.streamValidation, "validated", "Fewer than three true running partials after leaving bottom");
	assert.equal(reopened.readOnly, true, "Restart must not duplicate submission");
	assert.deepEqual(reopened.persistedProbe, first.persistedProbe);
}

/** The package's fixed deterministic answer/rate are never overridden by this scenario. */
export async function exerciseLongHistory({ cdp, directory, seed, reopened, previous, originalText, record }) {
	for (const domain of ["Runtime", "Log", "Page"]) await cdp.request(`${domain}.enable`);
	await until(
		() => evaluate(cdp, "location.href === 'hipi-work://app/index.html' && !!document.querySelector('.work-shell')"),
		"real workbench",
	);
	assert.deepEqual(
		await evaluate(
			cdp,
			"({bridge:typeof window.hipiWorkDesktop?.request,node:typeof window.require,process:typeof window.process})",
		),
		{ bridge: "function", node: "undefined", process: "undefined" },
	);
	await selectEnglish(cdp);
	const workspace = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
		const names=[...document.querySelectorAll('.project-name')];
		if(names.length!==1 || names[0].textContent!==${JSON.stringify(seed.workspaceTitle)})return null;
		const button=names[0].closest('.workspace-branch')?.querySelector('.project-toggle');
		return button && ['true','false'].includes(button.getAttribute('aria-expanded')) ? {expanded:button.getAttribute('aria-expanded')} : null;
	})()`,
			),
		"exact seeded workspace",
	);
	if (workspace.expanded === "false") await click(cdp, ".project-toggle");
	const read = () =>
		evaluate(
			cdp,
			`(()=>{const executionState=${executionState.toString()};return (${viewport.toString()})(document);})()`,
		);
	const frames = () => evaluate(cdp, "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
	const wheel = async (delta) => {
		const value = await read();
		assert.ok(value && Number.isFinite(delta));
		// Stay on the scroll region's padding, away from nested code/table scroll surfaces.
		const point = await evaluate(
			cdp,
			`(() => {
			const host=document.querySelector('.message-scroll'),r=host.getBoundingClientRect();
			for(const x of [r.x+8,r.x+r.width-24])for(const y of [r.y+r.height/2,r.y+32]){
				if(document.elementFromPoint(x,y)===host)return {x,y};
			} return null;
		})()`,
		);
		assert.ok(point, "History wheel needs an unobstructed non-nested scroll target");
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: delta });
		await frames();
	};
	const select = async (conversation) => {
		await click(cdp, ".conversation-list button.conversation-link", conversation.title);
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.toolbar-conversation')?.textContent===${JSON.stringify(conversation.title)}`,
				),
			"selected seeded conversation",
		);
		await click(cdp, 'button[aria-label="Conversation details"]');
		assert.deepEqual(await receiptScope(cdp), {
			workspaceId: seed.workspaceId,
			conversationId: conversation.conversationId,
		});
		await click(cdp, ".workbench-detail-dialog button", "Close");
		await waitForOverlayClosed(cdp, 'button[aria-label="Conversation details"]');
		await until(async () => (await read())?.executionState === "ready", "known ready conversation");
	};
	await select(seed.long);
	if (reopened) {
		assert.ok(previous?.persistedProbe?.userKey && previous?.persistedProbe?.answerKey);
		await until(async () => {
			const value = await read();
			return (
				value?.rows.some((r) => r.key === previous.persistedProbe.userKey && r.content === seed.probe) &&
				value.rows.some(
					(r) => r.key === previous.persistedProbe.answerKey && r.content === previous.persistedProbe.answerText,
				)
			);
		}, "cold reopened exact persisted probe IDs and text");
	}
	const first = await until(async () => {
		const value = await read();
		return value?.rows.some((r) => r.text.includes(`HISTORY_ANSWER_${String(seed.turns - 1).padStart(3, "0")}`))
			? value
			: null;
	}, "latest seeded tail");
	const mountedCounts = [first.rows.length];
	assert.ok(first.rows.length < seed.persistedMessages, "List must virtualize, not mount all 200 seed rows");
	for (let n = 0; n < 100; n++) {
		const value = await read();
		if (value.scrollTop <= 380) break;
		await wheel(-Math.min(650, value.scrollTop - 350));
	}
	const before = await read();
	assert.ok(before.scrollTop > 240 && before.scrollTop <= 380, "Position before auto-load threshold");
	const anchor = before.rows.find((r) => r.visible && r.top >= 0);
	assert.ok(anchor);
	await evaluate(
		cdp,
		`(()=>{const executionState=${executionState.toString()};globalThis.__hipiHistoryObservation=(${observePrepend.toString()})(document,${viewport.toString()},${JSON.stringify(anchor.key)});})()`,
	);
	let after;
	let observed;
	try {
		await wheel(-(before.scrollTop - 200));
		await until(async () => {
			const value = await read();
			return !value.loading && value.rows.some((r) => r.key === anchor.key && r.index > anchor.index);
		}, "automatic prepend of same anchor");
		await frames();
		after = await read();
	} finally {
		observed = await evaluate(
			cdp,
			"(()=>{const o=globalThis.__hipiHistoryObservation;o.stop();delete globalThis.__hipiHistoryObservation;return o.samples;})()",
		);
	}
	const prepend = prependEvidence(observed, before, after, anchor.key);
	record({ prepend });
	await capture(cdp, directory, reopened ? "history-prepend-reopened" : "history-prepend");
	const seen = new Set();
	let oldest;
	for (let n = 0; n < 400; n++) {
		const value = await read();
		mountedCounts.push(value.rows.length);
		for (const row of value.rows) if (row.visible) seen.add(row.key);
		if (value.rows.some((r) => r.visible && r.text.includes("HISTORY_USER_000"))) {
			oldest = value;
			break;
		}
		await wheel(-650);
	}
	assert.ok(oldest, "Oldest seeded history marker must be reachable");
	assert.ok(
		await evaluate(
			cdp,
			`(() => {
		const e=[...document.querySelectorAll('[data-message-key]')].find(e=>e.textContent.includes('HISTORY_ANSWER_000'));
		return !!e?.querySelector('table') && !!e?.querySelector('pre') && !!e?.querySelector('blockquote');
	})()`,
		),
		"Real complex Markdown blocks must be mounted",
	);
	await capture(cdp, directory, reopened ? "history-oldest-reopened" : "history-oldest");
	const expansionKey = `message:${seed.expansionMessageId}`;
	const expansionSelector = `[data-message-key=${JSON.stringify(expansionKey)}]`;
	// Position the actual original-text button with wheel events, never a scrollTop write.
	const buttonPoint = (label) =>
		evaluate(
			cdp,
			`(() => {
		const host=document.querySelector('.message-scroll'),box=host.getBoundingClientRect();
		const buttons=[...document.querySelectorAll(${JSON.stringify(`${expansionSelector} button`)})].filter(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled);
		if(buttons.length!==1)return null;
		const e=buttons[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
		return {x,y,delta:y-(box.y+box.height/2),hit:y>box.y+4 && y<box.bottom-4 && e.contains(document.elementFromPoint(x,y))};
	})()`,
		);
	let point;
	for (let n = 0; n < 80; n++) {
		point = await buttonPoint("Read full original in pages");
		if (point?.hit) break;
		await wheel(point ? Math.max(-400, Math.min(400, point.delta)) : 300);
	}
	assert.ok(point?.hit, "Original text control must be visible and reachable");
	const collapsed = await read();
	const clickPoint = async (target) => {
		assert.ok(target?.hit, "No forced or offscreen click");
		for (const type of ["mousePressed", "mouseReleased"])
			await cdp.request("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
	};
	await clickPoint(point);
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector(${JSON.stringify(`${expansionSelector} .original-text pre`)})?.textContent===${JSON.stringify(originalText)}`,
			),
		"exact full original, including suffix outside preview",
	);
	await frames();
	const expanded = await read();
	const expansionAnchor = anchored(collapsed, expanded, expansionKey);
	const heightBefore = collapsed.rows.find((r) => r.key === expansionKey).height;
	const heightAfter = expanded.rows.find((r) => r.key === expansionKey).height;
	assert.ok(heightAfter > heightBefore, "Expansion must exercise real changed row height");
	await capture(cdp, directory, reopened ? "history-expanded-reopened" : "history-expanded");
	await clickPoint(await buttonPoint("Close"));
	await until(
		() => evaluate(cdp, `!document.querySelector(${JSON.stringify(`${expansionSelector} .original-text`)})`),
		"original text collapsed",
	);
	await frames();
	const closed = await read();
	const collapseAnchor = anchored(expanded, closed, expansionKey);
	assert.ok(Math.abs(closed.rows.find((r) => r.key === expansionKey).height - heightBefore) <= 4);
	const expansion = {
		status: "validated",
		exactOriginal: true,
		heightBefore,
		heightAfter,
		expansionAnchor,
		collapseAnchor,
	};
	record({ oldestReached: true, expansion, visibleDistinctMessageKeys: seen.size });
	await click(cdp, ".jump-latest");
	await until(async () => {
		const v = await read();
		return v.scrollHeight - v.clientHeight - v.scrollTop <= 64;
	}, "explicit jump latest");
	let persistedProbe = previous?.persistedProbe;
	let streamValidation;
	let streamPartialSamples;
	let streamAnchorSamples;
	if (!reopened) {
		await click(cdp, ".composer textarea");
		await cdp.request("Input.insertText", { text: seed.probe });
		assert.equal(await evaluate(cdp, "document.querySelector('.composer textarea').value"), seed.probe);
		await evaluate(
			cdp,
			`(()=>{const executionState=${executionState.toString()};globalThis.__hipiExecutionObservation=(${observeExecution.toString()})(document,${viewport.toString()});})()`,
		);
		try {
			await click(cdp, '.composer button[type="submit"]');
			await until(async () => {
				const v = await read();
				return v.running && !!v.partial;
			}, "global Running and true GUI partial");
		} finally {
			record({
				streamStart: await evaluate(
					cdp,
					"(()=>{const o=globalThis.__hipiExecutionObservation;const result=o.stop();delete globalThis.__hipiExecutionObservation;return result;})()",
				),
			});
		}
		await wheel(-200);
		const reading = await read();
		assert.ok(
			reading.jump && reading.scrollHeight - reading.clientHeight - reading.scrollTop > 64,
			"User intentionally left bottom",
		);
		const readingAnchor = reading.rows.find((r) => r.visible && r.top >= 0 && r.key !== "partial-output");
		assert.ok(readingAnchor);
		const partials = new Set();
		addPartial(partials, reading);
		streamAnchorSamples = [];
		await until(async () => {
			const value = await read();
			assert.notEqual(value.executionState, "unknown", "Execution state must remain known");
			addPartial(partials, value);
			streamAnchorSamples.push(anchored(reading, value, readingAnchor.key));
			return value.executionState === "ready";
		}, "continuous anchor observation through execution completion");
		streamPartialSamples = partials.size;
		streamValidation = partials.size >= 3 ? "validated" : "notvalidated";
		record({ streamValidation, streamPartialSamples, streamAnchorSamples });
		await capture(cdp, directory, "history-stream-away-from-bottom");
		await click(cdp, 'button[aria-label="Conversation details"]');
		await until(
			() =>
				evaluate(cdp, "document.querySelector('[data-testid=\"execution-status\"]')?.textContent==='Result confirmed'"),
			"durable confirmed result",
		);
		streamAnchorSamples.push(anchored(reading, await read(), readingAnchor.key));
		const requestId = await evaluate(cdp, "document.querySelector('[data-testid=\"request-id\"]')?.textContent");
		assert.match(requestId, /^[A-Za-z0-9_-]{1,128}$/);
		await click(cdp, ".workbench-detail-dialog button", "Close");
		await waitForOverlayClosed(cdp, 'button[aria-label="Conversation details"]');
		await click(cdp, ".jump-latest");
		persistedProbe = await until(async () => {
			const value = await read();
			const user = value.rows.find((r) => r.key.startsWith("message:") && r.content === seed.probe);
			const answer = user && value.rows.find((r) => r.index === user.index + 1);
			return user && answer?.key.startsWith("message:") && answer.content === fixture.answer && !value.running
				? { userKey: user.key, answerKey: answer.key, answerText: answer.content, requestId }
				: null;
		}, "persistent probe identities and exact unchanged deterministic answer");
	}
	await select(seed.control);
	const control = await until(async () => {
		const v = await read();
		return v?.rows.length === 2 ? v : null;
	}, "two control messages");
	assert.ok(control.rows.some((r) => r.content === seed.controlUser));
	assert.ok(control.rows.some((r) => r.content === seed.controlAnswer));
	assert.ok(control.rows.every((r) => !r.text.includes("HISTORY_") && !r.text.includes("LONG_GUI_STREAM_PROBE")));
	await select(seed.long);
	await until(async () => {
		const value = await read();
		return (
			value.rows.some((r) => r.key === persistedProbe.userKey && r.content === seed.probe) &&
			value.rows.some((r) => r.key === persistedProbe.answerKey && r.content === persistedProbe.answerText) &&
			value.rows.every((r) => !r.text.includes("CONTROL_ONLY_"))
		);
	}, "return to exact isolated persisted long conversation");
	await assertNoAlerts(cdp);
	await capture(cdp, directory, reopened ? "history-isolation-reopened" : "history-isolation");
	return {
		reopened,
		readOnly: reopened,
		seededMessages: seed.persistedMessages,
		seedViaPublicRuntime: true,
		seedManuallyEnteredViaGUI: false,
		guiSubmissions: reopened ? 0 : 1,
		prepend,
		oldestReached: true,
		markdownBlocks: true,
		expansion,
		persistedProbe,
		streamValidation,
		streamPartialSamples,
		streamAnchorSamples,
		mountedRows: { min: Math.min(...mountedCounts), max: Math.max(...mountedCounts) },
		visibleDistinctMessageKeys: seen.size,
		scopeIsolation: true,
		nativeProcessMemory: "not measured",
		performanceBudget: "not established",
	};
}
