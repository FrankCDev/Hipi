import assert from "node:assert/strict";
import type { Conversation, ConversationModel, Scope } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { useConversation } from "../../../src/features/workbench/conversation/use-conversation.ts";
import type { ConnectionState } from "../../../src/features/workbench/conversation/use-observation.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

// Model the effect lifecycle explicitly, while using the production hook closure and
// real TanStack observers/cancellation. Actual rendered Running/Cancel remains a native GUI gate.
const effects: { effect: React.EffectCallback; deps: React.DependencyList | undefined }[] = [];
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useEffect: (effect: React.EffectCallback, deps?: React.DependencyList) => {
			effects.push({ effect, deps });
			actual.useEffect(effect, deps);
		},
	};
});
const local = new LocalState();
const call = vi.fn<(method: string, scope: Scope, signal?: AbortSignal) => Promise<ConversationModel>>();
let observation: { connection: ConnectionState; snapshot?: { running: boolean; partial: string } };
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => ({ call }), useLocalState: () => local }));
vi.mock("../../../src/features/workbench/conversation/use-observation.ts", () => ({
	useObservation: () => observation,
}));
const status = (executionState: ConversationModel["executionState"]): ConversationModel => ({
	model: { provider: "faux", modelId: "faux-1" },
	credentialState: "configured",
	executionState,
});
const scopeA = { workspaceId: "workspace", conversationId: "conversation-a" };
const scopeB = { workspaceId: "workspace", conversationId: "conversation-b" };
const key = (scope: Scope) => ["conversation-model", scope.workspaceId, scope.conversationId];

function setup() {
	const cache = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: Infinity } },
	});
	const pending: { scope: Scope; signal: AbortSignal | undefined; resolve: (value: ConversationModel) => void }[] = [];
	call.mockReset();
	call.mockImplementation((method, scope, signal) => {
		assert.equal(method, "getConversationModel");
		return new Promise((resolve) => pending.push({ scope, signal, resolve }));
	});
	const stops = [scopeA, scopeB].map((scope) => {
		cache.setQueryData(key(scope), status("ready"));
		const observer = new QueryObserver(cache, {
			queryKey: key(scope),
			queryFn: ({ signal }) => call("getConversationModel", scope, signal),
		});
		return observer.subscribe(() => {});
	});
	let previous: React.DependencyList | undefined;
	const drive = (
		scope: Scope,
		running: boolean | undefined,
		connection: ConnectionState = "connected",
		partial = "",
	) => {
		observation = { connection, snapshot: running === undefined ? undefined : { running, partial } };
		function Probe() {
			const conversation: Conversation = { ...scope, title: "Fixture", revision: 1, createdAt: 0, archivedAt: null };
			useConversation(conversation);
			return null;
		}
		effects.length = 0;
		renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<Probe />
			</QueryClientProvider>,
		);
		const refresh = effects.filter(({ deps }) => deps?.[0] === cache && deps.length === 5);
		assert.equal(refresh.length, 1, "The production refresh effect must have a bounded transition dependency list");
		const current = refresh[0];
		assert.ok(current.deps);
		if (!previous || current.deps.some((value, index) => !Object.is(value, previous?.[index]))) current.effect();
		previous = current.deps;
	};
	return {
		cache,
		pending,
		drive,
		close() {
			for (const stop of stops) stop();
			cache.clear();
		},
	};
}

test("authoritative running/terminal/reconnect transitions refresh immediately without per-token storms", async () => {
	const h = setup();
	try {
		h.drive(scopeA, undefined);
		h.drive(scopeA, false, "connecting");
		assert.equal(call.mock.calls.length, 0, "Unknown or disconnected snapshots are not execution authority");
		h.drive(scopeA, false);
		assert.equal(h.pending.length, 1);
		h.pending[0].resolve(status("ready"));
		await vi.waitFor(() => assert.equal(h.cache.getQueryState(key(scopeA))?.fetchStatus, "idle"));
		h.drive(scopeA, true);
		assert.equal(h.pending.length, 2, "Running transition must not wait for the 2000ms periodic query");
		h.pending[1].resolve(status("running"));
		await vi.waitFor(() =>
			assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeA))?.executionState, "running"),
		);
		for (let n = 0; n < 20; n++) h.drive(scopeA, true, "connected", `partial-${n}`);
		assert.equal(h.pending.length, 2, "Token updates must not trigger model refetches");
		h.drive(scopeA, false);
		assert.equal(h.pending.length, 3);
		h.pending[2].resolve(status("ready"));
		await vi.waitFor(() => assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeA))?.executionState, "ready"));
		h.drive(scopeA, false, "stale");
		assert.equal(h.pending.length, 3);
		h.drive(scopeA, false);
		assert.equal(h.pending.length, 4, "Same running value after reconnect still requires authoritative refresh");
		h.pending[3].resolve(status("paused"));
		await vi.waitFor(() =>
			assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeA))?.executionState, "paused"),
		);
		assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeB))?.executionState, "ready");
		assert.ok(h.pending.every((request) => request.scope.conversationId === scopeA.conversationId));
	} finally {
		h.close();
	}
});

test("new transition cancels stale model reads and scope changes cannot overwrite another conversation", async () => {
	const h = setup();
	try {
		h.drive(scopeA, false);
		const stale = h.pending[0];
		assert.equal(stale.signal?.aborted, false);
		h.drive(scopeA, true);
		assert.equal(stale.signal?.aborted, true, "Transition invalidation cancels an older model read");
		h.pending[1].resolve(status("running"));
		await vi.waitFor(() =>
			assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeA))?.executionState, "running"),
		);
		stale.resolve(status("ready"));
		await Promise.resolve();
		assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeA))?.executionState, "running");
		h.drive(scopeB, false);
		assert.deepEqual(h.pending[2].scope, scopeB);
		h.pending[2].resolve(status("cancellation_pending"));
		await vi.waitFor(() =>
			assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeB))?.executionState, "cancellation_pending"),
		);
		assert.equal(h.cache.getQueryData<ConversationModel>(key(scopeA))?.executionState, "running");
	} finally {
		h.close();
	}
});
