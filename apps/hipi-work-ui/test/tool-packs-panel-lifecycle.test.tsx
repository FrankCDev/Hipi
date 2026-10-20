import assert from "node:assert/strict";
import {
	type AppClient,
	type Conversation,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseResult,
} from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { ToolPackSession } from "../src/features/tool-packs/session.ts";
import { ToolPacksPanel } from "../src/features/tool-packs/tool-packs-panel.tsx";
import { LocalState } from "../src/features/workbench/local-state.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	commits: [] as (() => void)[],
	modelEnabled: false,
}));
// A bounded hook-lifecycle adapter drives the production owner and real session
// without a DOM. Native acceptance separately covers focus, portals, and clicks.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	function cell() {
		const index = hooks.cursor++;
		return { index, previous: hooks.cells[index] };
	}
	const changed = (previous: React.DependencyList | undefined, next: React.DependencyList) =>
		!previous || next.some((value, index) => !Object.is(value, previous[index]));
	return {
		...actual,
		useState: <T,>(initial: T | (() => T)) => {
			const { index, previous } = cell();
			const current = previous ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = current;
			return [
				current.value,
				(next: T | ((value: T) => T)) => {
					current.value = typeof next === "function" ? (next as (value: T) => T)(current.value as T) : next;
				},
			];
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const { index, previous } = cell();
			if (!previous || changed(previous.deps, deps)) hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useRef: <T,>(initial: T) => {
			const { index, previous } = cell();
			const current = previous ?? { value: { current: initial } };
			hooks.cells[index] = current;
			return current.value;
		},
		useId: () => `field-${hooks.cursor++}`,
		useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const { index, previous } = cell();
			if (!previous || changed(previous.deps, deps))
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ enabled }: { enabled: boolean }) => {
		hooks.modelEnabled = enabled;
		return { data: { model: { provider: "faux", modelId: "faux-1" } }, isError: false, refetch: async () => {} };
	},
}));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../src/app/client-provider.tsx", () => ({ useAppClient: () => client, useLocalState: () => local }));
const conversation: Conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "Fixture",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
let local = new LocalState();
const calls: { method: Method; signal?: AbortSignal }[] = [];
let blockRead = false;
const client: AppClient = {
	call: async <M extends Method>(method: M, _params: Params<M>, signal?: AbortSignal) => {
		calls.push({ method, signal });
		if (blockRead && method === "listToolPacks") return new Promise<never>(() => {});
		if (method === "listToolPacks") return parseResult(method, { items: [], nextCursor: null });
		if (method === "listActiveToolPackBindings") return parseResult(method, []);
		if (method === "getToolPackCommandResult") return parseResult(method, null);
		throw new Error("LOST_REPLY");
	},
	observe: async () => ({ dispose: async () => {} }),
};
function drive(active: boolean, current = conversation) {
	hooks.cursor = 0;
	const content = ToolPacksPanel({
		workspaceId: current.workspaceId,
		conversation: current,
		active,
		children: (body) => body,
	});
	for (const commit of hooks.commits.splice(0)) commit();
	const owners = hooks.cells.filter((entry) => entry?.value instanceof ToolPackSession);
	assert.equal(owners.length, 1);
	const session = owners[0]?.value;
	assert.ok(session instanceof ToolPackSession);
	return { content, session };
}
function textarea(node: React.ReactNode): React.ReactElement<React.ComponentProps<typeof Textarea>> | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = textarea(child);
			if (found) return found;
		}
		return;
	}
	if (!isValidElement<React.ComponentProps<typeof Textarea>>(node)) return;
	if (node.type === Textarea) return node;
	return textarea(node.props.children);
}
beforeEach(() => {
	hooks.cells = [];
	hooks.commits = [];
	calls.length = 0;
	blockRead = false;
	local = new LocalState();
});
afterEach(() => {
	for (const entry of hooks.cells) entry?.cleanup?.();
});
test("the mounted owner retains import text and recovery across section changes and close/reopen", async () => {
	const initial = drive(false);
	assert.equal(calls.length, 0, "Closed capabilities do not eagerly load tool packs");
	assert.equal(hooks.modelEnabled, false);
	const input = textarea(initial.content);
	assert.ok(input?.props.onChange);
	input.props.onChange({ target: { value: "exact original package draft" } } as React.ChangeEvent<HTMLTextAreaElement>);
	const opened = drive(true);
	assert.equal(opened.session, initial.session);
	assert.equal(hooks.modelEnabled, true);
	await vi.waitFor(() => assert.equal(initial.session.getSnapshot().busy, false));
	await initial.session.execute({
		version: PROTOCOL_VERSION,
		method: "setToolPackEnabled",
		params: {
			workspaceId: "workspace",
			requestId: "original",
			digest: "a".repeat(64),
			expectedRevision: 1,
			enabled: true,
		},
	});
	const pending = initial.session.getSnapshot().pending;
	assert.ok(pending);
	for (const active of [false, true, false, true]) {
		const current = drive(active);
		assert.equal(current.session, initial.session);
		assert.equal(textarea(current.content)?.props.value, "exact original package draft");
		await vi.waitFor(() => assert.equal(current.session.getSnapshot().busy, false));
		assert.deepEqual(current.session.getSnapshot().pending, pending);
	}
	assert.equal(
		calls.filter(({ method }) => method === "setToolPackEnabled").length,
		1,
		"Reopening never replays a mutation",
	);
	assert.equal(local.hasUnsavedWork(), true);
});
test("deactivating cancels the active read, and the next activation reuses the owner for read-only recovery", async () => {
	blockRead = true;
	const first = drive(true);
	await vi.waitFor(() => assert.equal(calls.length, 1));
	const reading = calls[0];
	assert.equal(reading?.signal?.aborted, false);
	const closed = drive(false);
	assert.equal(closed.session, first.session);
	assert.equal(reading?.signal?.aborted, true);
	assert.equal(hooks.modelEnabled, false);
	await vi.waitFor(() => assert.equal(first.session.getSnapshot().busy, false));
	blockRead = false;
	drive(true);
	await vi.waitFor(() => assert.equal(first.session.getSnapshot().loaded, true));
	assert.ok(calls.every(({ method }) => method === "listToolPacks" || method === "listActiveToolPackBindings"));
});
