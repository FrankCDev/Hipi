import assert from "node:assert/strict";
import type { Conversation, ReceiptView, Snapshot } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { ConversationPane } from "../../../src/features/workbench/conversation/pane.tsx";
import {
	type ConversationController,
	useConversation,
} from "../../../src/features/workbench/conversation/use-conversation.ts";
import type { ConnectionState } from "../../../src/features/workbench/conversation/use-observation.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

// Run the production effect closures with real TanStack query observers. Native focus and timing remain a GUI gate.
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
let local = new LocalState();
const call = vi.fn<(method: string, params: object, signal?: AbortSignal) => Promise<ReceiptView | null>>();
const client = { call };
const reconnect = vi.fn();
let observation: {
	connection: ConnectionState;
	showConnectionNotice: boolean;
	snapshot: Snapshot;
	error: boolean;
	errorCode: null;
	pause(): void;
	reconnect(): void;
};
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useAppClient: () => client,
	useLocalState: () => local,
	useFiles: () => ({}),
}));
vi.mock("../../../src/features/workbench/conversation/use-observation.ts", () => ({
	useObservation: () => observation,
}));
vi.mock("../../../src/features/tool-activities/activity-transcript.tsx", () => ({
	ActivityTranscriptProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../../src/features/tool-activities/tool-activities.tsx", () => ({
	ToolActivities: () => null,
	ActivityHistoryAction: () => null,
	ActivityHistoryDialog: () => null,
}));
vi.mock("../../../src/features/workbench/conversation/history.tsx", () => ({
	ConversationHistory: ({ snapshot }: { snapshot: Snapshot }) => <div>{snapshot.partial}</div>,
}));
vi.mock("../../../src/features/workbench/conversation/model.tsx", () => ({ ConversationModelControls: () => null }));
vi.mock("../../../src/features/conversation-capabilities/conversation-capabilities.tsx", () => ({
	ConversationCapabilities: () => null,
}));
const scope = { workspaceId: "workspace", conversationId: "conversation" };
const conversation: Conversation = { ...scope, title: "Recovery", revision: 1, createdAt: 1, archivedAt: null };
const receiptKey = ["receipt", scope.workspaceId, "original-request"];

function setup() {
	local = new LocalState();
	call.mockReset();
	reconnect.mockReset();
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
	});
	cache.setQueryData(["conversation-model", scope.workspaceId, scope.conversationId], {
		model: { provider: "fake", modelId: "ready" },
		credentialState: "configured",
		executionState: "ready",
	});
	observation = {
		connection: "connecting",
		showConnectionNotice: false,
		snapshot: {
			...scope,
			messages: [],
			partial: "Preserved response",
			partialLength: 18,
			partialTruncated: false,
			historyCursor: null,
			running: false,
		},
		error: false,
		errorCode: null,
		pause() {},
		reconnect,
	};
	return cache;
}

test("verified reconnect reads the original receipt once without replaying a command or erasing newer input", async () => {
	const cache = setup();
	const pending = { ...scope, requestId: "original-request", text: "submitted input" };
	local.remember(`${scope.workspaceId}.${scope.conversationId}`, pending);
	local.write(`draft.${scope.workspaceId}.${scope.conversationId}`, "newer unsent input");
	cache.setQueryData(receiptKey, null);
	call.mockResolvedValue({ ...pending, receiptId: "receipt", state: "accepted" });
	const observer = new QueryObserver(cache, {
		queryKey: receiptKey,
		queryFn: ({ signal }) =>
			call("getReceipt", { workspaceId: scope.workspaceId, requestId: pending.requestId }, signal),
	});
	const stop = observer.subscribe(() => {});
	let previous: React.DependencyList | undefined;
	let controller: ConversationController | undefined;
	const drive = () => {
		function Probe() {
			controller = useConversation(conversation);
			return null;
		}
		effects.length = 0;
		renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<Probe />
			</QueryClientProvider>,
		);
		const matching = effects.filter(({ deps }) => deps?.[0] === cache && deps.length === 4);
		assert.equal(matching.length, 1);
		const current = matching[0];
		assert.ok(current?.deps);
		if (!previous || current.deps.some((value, index) => !Object.is(value, previous?.[index]))) current.effect();
		previous = current.deps;
	};
	try {
		drive();
		assert.ok(controller);
		assert.equal(controller.blocked, true);
		controller.submit();
		assert.equal(call.mock.calls.length, 0, "Grace hides the notice, never authorizes a send");
		observation.connection = "connected";
		drive();
		await vi.waitFor(() => assert.equal(cache.getQueryState(receiptKey)?.fetchStatus, "idle"));
		assert.equal(call.mock.calls.length, 1);
		assert.equal(call.mock.calls[0]?.[0], "getReceipt");
		assert.deepEqual(call.mock.calls[0]?.[1], { workspaceId: scope.workspaceId, requestId: "original-request" });
		for (let i = 0; i < 10; i++) {
			observation.snapshot.partial = `stream-${i}`;
			drive();
		}
		assert.equal(call.mock.calls.length, 1);
		assert.equal(local.read(`draft.${scope.workspaceId}.${scope.conversationId}`), "newer unsent input");
		controller.reconnect();
		assert.equal(reconnect.mock.calls.length, 1);
		assert.equal(call.mock.calls.length, 1, "Manual reconnect waits for verified observation before receipt lookup");
	} finally {
		stop();
		cache.clear();
	}
});

test("recovery grace keeps cached content visible without a banner; persistent loss exposes reconnect", () => {
	const cache = setup();
	const render = () =>
		renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					<ConversationPane conversation={conversation} detailsOpen={false} onDetailsClose={() => {}} />
				</PreferencesProvider>
			</QueryClientProvider>,
		);
	try {
		const grace = render();
		assert.match(grace, /Preserved response/);
		assert.doesNotMatch(grace, /connection-bar|重新连接并核对/);
		observation.showConnectionNotice = true;
		assert.match(render(), /connection-bar/);
		observation.connection = "stale";
		observation.error = true;
		const stale = render();
		assert.match(stale, /Preserved response/);
		assert.match(stale, /connection-warning/);
		assert.match(stale, /重新连接并核对/);
	} finally {
		cache.clear();
	}
});
