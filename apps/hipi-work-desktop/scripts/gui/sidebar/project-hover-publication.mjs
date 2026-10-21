import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluate, hover, until } from "../../gui-flow.mjs";

/**
 * Test-only adapter for pinned react-dom 19.3.1: host nodes own __reactFiber$<salt>,
 * ancestors use .return and QueryClientProvider retains .memoizedProps.client.
 * There is no supported application query-observation API. Never fall back to
 * bridge calls or cache writes; a React upgrade must requalify this adapter.
 */
export function mountedQueryCache(node) {
	const keys = Object.keys(node).filter((key) => key.startsWith("__reactFiber$"));
	if (keys.length !== 1) throw new Error("Expected one mounted React fiber");
	const clients = new Set();
	const seen = new Set();
	for (let fiber = node[keys[0]]; fiber; fiber = fiber.return) {
		if (seen.has(fiber)) throw new Error("Cyclic React ancestry");
		seen.add(fiber);
		const client = fiber.memoizedProps?.client;
		if (typeof client?.getQueryCache === "function" && typeof client?.getQueryData === "function") clients.add(client);
	}
	if (clients.size !== 1) throw new Error("Expected one mounted query provider");
	return [...clients][0].getQueryCache();
}

/** Observes actual cache completion and DOM identity; never fetches or changes application state. */
export function observeProjectPublication(document, cache, projectId) {
	const view = document.defaultView;
	const row = document.querySelector(`.workspace-branch[data-project-id="${projectId}"] .project-open`);
	if (!row) throw new Error("Missing exact project row");
	const owner = row.closest(".sidebar-preview-row").getAttribute("aria-labelledby");
	const nodes = {
		panel: document.querySelector(".conversation-panel"),
		composer: document.querySelector(".composer textarea"),
		history: document.querySelector(".message-scroll"),
	};
	if (Object.values(nodes).some((node) => !node?.isConnected)) throw new Error("Missing conversation continuity owner");
	const draft = nodes.composer.value;
	const messages = () =>
		[...document.querySelectorAll("[data-message-id]")].map((node) => ({
			id: node.dataset.messageId,
			text: node.textContent,
		}));
	const baseline = messages();
	const evidence = {
		projectId,
		owner,
		summaryReads: 0,
		probesAfterSummary: 0,
		framesAfterProbe: 0,
		frames: 0,
		failures: [],
		draft,
		messages: baseline,
	};
	let card;
	let armed = false;
	let frame;
	const fail = (reason) => {
		if (!evidence.failures.includes(reason)) evidence.failures.push(reason);
	};
	const sample = () => {
		const current = document.querySelector(".conversation-preview-card:has(.project-preview-content)");
		if (current?.getAttribute("aria-labelledby") === owner && !card) card = current;
		if (card) {
			if (!card.isConnected || current !== card || current.getAttribute("aria-labelledby") !== owner)
				fail("project card detached or replaced");
			if (document.querySelector(".conversation-panel") !== nodes.panel || !nodes.panel.isConnected)
				fail("conversation panel replaced");
			if (
				document.querySelector(".composer textarea") !== nodes.composer ||
				!nodes.composer.isConnected ||
				nodes.composer.value !== draft
			)
				fail("composer or draft changed");
			if (
				document.querySelector(".message-scroll") !== nodes.history ||
				!nodes.history.isConnected ||
				JSON.stringify(messages()) !== JSON.stringify(baseline)
			)
				fail("history changed");
		}
	};
	const unsubscribe = cache.subscribe((event) => {
		if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
		const key = event.query.queryKey;
		if (
			key.length === 4 &&
			key[0] === "sidebar-navigation" &&
			key[1] === "project-summary" &&
			key[2] === projectId &&
			key[3] === "all" &&
			event.query.isActive()
		) {
			if (event.query.state.status !== "success" || event.query.state.fetchStatus !== "idle") return;
			evidence.summaryReads++;
			evidence.summary = {
				count: event.query.state.data.count,
				coverage: event.query.state.data.coverage,
			};
		}
		if (
			armed &&
			key.length === 2 &&
			key[0] === "sidebar-navigation-probe" &&
			key[1] === "logical" &&
			event.query.state.fetchStatus === "idle"
		) {
			sample();
			evidence.probesAfterSummary++;
			evidence.probe = {
				dataUpdatedAt: event.query.state.dataUpdatedAt,
				coverage: event.query.state.data.coverage,
			};
		}
	});
	const tick = () => {
		sample();
		if (card) {
			evidence.frames++;
			if (evidence.probesAfterSummary > 0) evidence.framesAfterProbe++;
		}
		frame = view.requestAnimationFrame(tick);
	};
	frame = view.requestAnimationFrame(tick);
	return {
		readyForHover() {
			const query = cache.find({
				queryKey: ["sidebar-navigation", "project-summary", projectId, "all"],
				exact: true,
			});
			if (!query) return true;
			if (query.isActive() || query.state.fetchStatus !== "idle") return false;
			if (typeof query.options.staleTime !== "number") throw new Error("Expected explicit project summary freshness");
			return query.isStaleByTime(query.options.staleTime);
		},
		arm() {
			sample();
			if (!card || evidence.summaryReads < 1) return false;
			armed = true;
			return true;
		},
		read() {
			return structuredClone(evidence);
		},
		stop() {
			view.cancelAnimationFrame(frame);
			unsubscribe();
			sample();
			return structuredClone(evidence);
		},
	};
}

export function assertProjectPublication(value) {
	assert.ok(value.summaryReads >= 1, "Actual project summary read must complete after observation starts");
	assert.ok(value.probesAfterSummary >= 1, "Actual background probe must complete after card and summary are ready");
	assert.ok(value.framesAfterProbe >= 2, "Observe rendered continuity after probe effects have run");
	assert.ok(Number.isFinite(value.summary?.count));
	assert.ok(value.summary?.coverage && value.probe?.coverage, "Both reads must retain actual publication coverage");
	assert.deepEqual(value.failures, []);
	assert.deepEqual(value.rendererErrors, []);
}

export async function exerciseProjectHoverPublication({ cdp, directory, seed }) {
	assert.match(seed.aliasProjectId, /^[A-Za-z0-9_-]+$/);
	const selector = `.workspace-branch[data-project-id="${seed.aliasProjectId}"] .project-open`;
	const rendererErrors = [];
	const dispose = cdp.onEvent((method, params) => {
		if (method === "Runtime.exceptionThrown" || (method === "Runtime.consoleAPICalled" && params.type === "error"))
			rendererErrors.push({ method, params });
	});
	let evidence;
	let failure;
	try {
		await cdp.request("Runtime.enable");
		await hover(cdp, ".app-toolbar");
		await until(
			() => evaluate(cdp, "!document.querySelector('.conversation-preview-card')"),
			"previous preview closes",
		);
		await evaluate(
			cdp,
			`void(window.__projectPublication=(${observeProjectPublication.toString()})(document,(${mountedQueryCache.toString()})(document.querySelector(${JSON.stringify(selector)})),${JSON.stringify(seed.aliasProjectId)}))`,
		);
		// A previous native action may have warmed this summary. Wait for its own
		// freshness to expire, never invalidate it or count cached data as a new read.
		await until(
			() => evaluate(cdp, "window.__projectPublication.readyForHover()"),
			"project summary eligible for a real hover read",
			20000,
		);
		await hover(cdp, selector);
		await until(
			() => evaluate(cdp, "window.__projectPublication.arm()"),
			"real project card and completed summary read",
			10000,
		);
		await until(
			async () => {
				const value = await evaluate(cdp, "window.__projectPublication.read()");
				assert.deepEqual(value.failures, []);
				assert.deepEqual(rendererErrors, []);
				return value.probesAfterSummary > 0 && value.framesAfterProbe >= 2;
			},
			"actual background publication completes while project remains hovered",
			10000,
		);
	} catch (error) {
		failure = error;
	} finally {
		try {
			evidence = await evaluate(
				cdp,
				"(()=>{const value=window.__projectPublication?.stop();delete window.__projectPublication;return value})()",
			);
		} catch (error) {
			failure ??= error;
		} finally {
			dispose();
			await writeFile(
				join(directory, "sidebar-project-hover-publication.json"),
				`${JSON.stringify({ ...evidence, rendererErrors, failure: failure?.message }, null, 2)}\n`,
			);
		}
	}
	if (failure) throw failure;
	const result = { ...evidence, rendererErrors };
	assertProjectPublication(result);
	await hover(cdp, ".app-toolbar");
	return result;
}
