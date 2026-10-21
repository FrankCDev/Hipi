import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import {
	assertProjectPublication,
	mountedQueryCache,
	observeProjectPublication,
} from "./project-hover-publication.mjs";

function fixture() {
	let tick;
	const nodes = Object.fromEntries(["panel", "composer", "history", "card"].map((key) => [key, { isConnected: true }]));
	nodes.composer.value = "Unsent 中文";
	nodes.card.getAttribute = () => "project-label";
	let shown = false;
	const document = {
		defaultView: {
			requestAnimationFrame(fn) {
				tick = fn;
				return 1;
			},
			cancelAnimationFrame() {
				tick = undefined;
			},
		},
		querySelector(selector) {
			if (selector.includes(".project-open")) return { closest: () => ({ getAttribute: () => "project-label" }) };
			if (selector === ".conversation-panel") return nodes.panel;
			if (selector === ".composer textarea") return nodes.composer;
			if (selector === ".message-scroll") return nodes.history;
			if (selector.startsWith(".conversation-preview-card")) return shown ? nodes.card : null;
			throw new Error(`Unexpected selector: ${selector}`);
		},
		querySelectorAll: () => [{ dataset: { messageId: "persisted" }, textContent: "Actual history" }],
	};
	return {
		document,
		nodes,
		frame: () => tick(),
		show: () => {
			shown = true;
		},
		hide: () => {
			shown = false;
		},
	};
}
const summaryKey = ["sidebar-navigation", "project-summary", "project-a", "all"];
const probeKey = ["sidebar-navigation-probe", "logical"];
const coverage = {
	generation: 3,
	projectMembershipGeneration: 2,
	state: "ready",
	completedAt: 100,
};
const summary = { count: 4, partial: false, state: "ready", coverage };

test("read-only provider discovery is exact and fails closed on ambiguous or missing ancestry", () => {
	const cache = {};
	const client = { getQueryCache: () => cache, getQueryData() {} };
	const provider = { memoizedProps: { client } };
	assert.equal(mountedQueryCache({ __reactFiber$fixture: { return: provider } }), cache);
	assert.throws(() => mountedQueryCache({}));
	assert.throws(() => mountedQueryCache({ __reactFiber$a: provider, __reactFiber$b: provider }));
	assert.throws(() =>
		mountedQueryCache({
			__reactFiber$a: {
				memoizedProps: { client },
				return: { memoizedProps: { client: { ...client } } },
			},
		}),
	);
});

test("real QueryObserver completion must follow summary/card readiness; manual writes and earlier probes do not qualify", async () => {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const dom = fixture();
	const observer = observeProjectPublication(dom.document, cache.getQueryCache(), "project-a");
	const probe = new QueryObserver(cache, {
		queryKey: probeKey,
		queryFn: async () => ({ coverage }),
	});
	const summaryObserver = new QueryObserver(cache, {
		queryKey: summaryKey,
		queryFn: async () => summary,
		staleTime: 15000,
	});
	const releaseProbe = probe.subscribe(() => {});
	let releaseSummary;
	try {
		await probe.refetch();
		cache.setQueryData(summaryKey, summary);
		dom.show();
		dom.frame();
		assert.equal(observer.arm(), false, "Manual cache writes cannot count as native summary reads");
		assert.equal(observer.read().probesAfterSummary, 0);
		releaseSummary = summaryObserver.subscribe(() => {});
		await summaryObserver.refetch();
		assert.equal(observer.arm(), true);
		assert.equal(observer.read().probesAfterSummary, 0, "Earlier completed probes must not count");
		await probe.refetch();
		assert.throws(() => assertProjectPublication({ ...observer.read(), rendererErrors: [] }), /rendered continuity/);
		dom.frame();
		dom.frame();
		assertProjectPublication({ ...observer.read(), rendererErrors: [] });
		assert.throws(() =>
			assertProjectPublication({
				...observer.read(),
				rendererErrors: [{ error: "white screen" }],
			}),
		);
	} finally {
		observer.stop();
		releaseProbe();
		releaseSummary?.();
		summaryObserver.destroy();
		cache.clear();
	}
});

test("cache warmth alone cannot qualify; freshness expiration never invalidates or fetches", async () => {
	const cache = new QueryClient();
	const dom = fixture();
	const observation = observeProjectPublication(dom.document, cache.getQueryCache(), "project-a");
	assert.equal(observation.readyForHover(), true);
	let reads = 0;
	await cache.fetchQuery({
		queryKey: summaryKey,
		staleTime: 15000,
		queryFn: async () => {
			reads++;
			return summary;
		},
	});
	assert.equal(observation.readyForHover(), false);
	assert.equal(reads, 1);
	assert.equal(cache.getQueryState(summaryKey).isInvalidated, false);
	observation.stop();
	cache.clear();
});

test("card replacement, white screen, draft loss and history replacement are retained as failures", () => {
	for (const mutate of [
		(dom) => dom.hide(),
		(dom) => {
			dom.nodes.card = { ...dom.nodes.card };
		},
		(dom) => {
			dom.nodes.panel.isConnected = false;
		},
		(dom) => {
			dom.nodes.composer.value = "";
		},
		(dom) => {
			dom.nodes.history = { isConnected: true };
		},
	]) {
		const cache = new QueryClient();
		const dom = fixture();
		const observer = observeProjectPublication(dom.document, cache.getQueryCache(), "project-a");
		dom.show();
		dom.frame();
		mutate(dom);
		dom.frame();
		assert.ok(observer.stop().failures.length > 0);
		cache.clear();
	}
});

test("detached target cleanup removes cache subscription and animation callback", () => {
	const cache = new QueryClient();
	const dom = fixture();
	const observer = observeProjectPublication(dom.document, cache.getQueryCache(), "project-a");
	assert.equal(cache.getQueryCache().hasListeners(), true);
	dom.show();
	dom.frame();
	dom.hide();
	assert.deepEqual(observer.stop().failures, ["project card detached or replaced"]);
	assert.equal(cache.getQueryCache().hasListeners(), false);
	assert.throws(() => dom.frame(), TypeError);
	cache.clear();
});
