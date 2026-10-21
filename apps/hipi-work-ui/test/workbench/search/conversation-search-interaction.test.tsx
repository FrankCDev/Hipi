import assert from "node:assert/strict";
import {
	type AppClient,
	AppError,
	type ConversationSearchHit,
	type Method,
	parseResult,
} from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../../../src/components/ui/button.tsx";
import { DialogContent } from "../../../src/components/ui/dialog.tsx";
import { InputGroupInput } from "../../../src/components/ui/input-group.tsx";
import { ConversationSearch } from "../../../src/features/workbench/search/search.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
// Deterministic component callback/effect adapter. Native portals, real focus traps
// and DOM geometry are separately exercised by the packaged GUI search journey.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const changed = (before: React.DependencyList | undefined, after: React.DependencyList) =>
		!before || before.length !== after.length || after.some((value, index) => !Object.is(value, before[index]));
	return {
		...actual,
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			const current = hooks.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = current;
			return [
				current.value,
				(next: T) => {
					hooks.changed ||= !Object.is(current.value, next);
					current.value = next;
				},
			];
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			if (changed(hooks.cells[index]?.deps, deps)) hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: { current: initial } };
			return hooks.cells[index]?.value;
		},
		useId: () => `search-test-${hooks.cursor++}`,
		useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
		useEffect: (setup: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const previous = hooks.cells[index];
			if (changed(previous?.deps, deps))
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = setup();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
});
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
const hit: ConversationSearchHit = {
	workspaceId: "closed",
	conversationId: "unloaded",
	title: "Other title",
	workspaceName: "Closed project",
	kind: "message",
	messageId: "1_0",
	locator: "opaque",
	snippet: "😀 NeEdLe 中文",
	snippetOffset: 9000,
	matchStart: 9003,
	matchEnd: 9009,
};
const hits = [hit, { ...hit, conversationId: "second" }];
const client: AppClient = {
	call: vi.fn(async <M extends Method>(method: M) => {
		const index = { generation: "g", completedAt: 1, state: "ready", nextCursor: null };
		if (method === "refreshConversationSearch") return parseResult(method, index);
		assert.equal(method, "searchConversations");
		return parseResult(method, { items: hits, index, nextCursor: null });
	}),
	async observe() {
		throw new Error("Search must not observe execution");
	},
};
function find<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => find(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	return [
		...(node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node] : []),
		...find(node.props.children, type),
	];
}
function invoke(callback: unknown, event?: unknown) {
	assert.equal(typeof callback, "function");
	return Reflect.apply(callback as (...args: unknown[]) => unknown, undefined, [event]);
}
const focus = vi.fn();
function host(activate: (hit: ConversationSearchHit, signal: AbortSignal) => Promise<boolean>) {
	const close = vi.fn();
	const restore = vi.fn();
	const outer = ConversationSearch({ open: true, onOpenChange: close, onRestoreFocus: restore, onActivate: activate });
	const child = outer.props.children;
	assert.ok(isValidElement(child) && typeof child.type === "function");
	const component = child.type;
	const drive = () => {
		for (let attempt = 0; attempt < 8; attempt++) {
			hooks.cursor = 0;
			hooks.changed = false;
			const result: React.ReactNode = Reflect.apply(component, undefined, [child.props]);
			const input = find(result, InputGroupInput)[0];
			assert.ok(input?.props.ref && typeof input.props.ref === "object");
			Reflect.set(input.props.ref, "current", { focus });
			for (const commit of hooks.commits.splice(0)) commit();
			if (!hooks.changed) return result;
		}
		throw new Error("Search component did not settle");
	};
	return {
		drive,
		close,
		restore,
		input: () => {
			const input = find(drive(), InputGroupInput)[0];
			assert.ok(input);
			return input.props;
		},
		dialog: () => {
			const dialog = find(drive(), DialogContent)[0];
			assert.ok(dialog);
			return dialog.props;
		},
	};
}
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	hooks.cells = [];
	hooks.commits = [];
	vi.stubGlobal("document", { getElementById: () => ({ scrollIntoView: () => {} }) });
});
afterEach(() => {
	for (const cell of hooks.cells) cell?.cleanup?.();
	assert.equal(vi.getTimerCount(), 0);
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("modal focuses its input, keyboard selection activates exact scope, and close returns through the exact opener callback", async () => {
	const activate = vi.fn(async (_hit: ConversationSearchHit, _signal: AbortSignal) => true);
	const owner = host(activate);
	const preventDefault = vi.fn();
	invoke(owner.dialog().onOpenAutoFocus, { preventDefault });
	assert.equal(preventDefault.mock.calls.length, 1);
	assert.deepEqual(focus.mock.calls, [[{ preventScroll: true }]]);
	await flush();
	invoke(owner.input().onChange, { target: { value: "needle" } });
	await vi.advanceTimersByTimeAsync(180);
	assert.equal(find(owner.drive(), "button").length, 2);
	invoke(owner.input().onKeyDown, { key: "ArrowDown", nativeEvent: {}, preventDefault });
	assert.equal(owner.input()["aria-activedescendant"]?.endsWith("result-1"), true);
	invoke(owner.input().onKeyDown, { key: "Enter", nativeEvent: {}, preventDefault });
	await flush();
	assert.deepEqual(activate.mock.calls[0]?.[0], hits[1]);
	assert.deepEqual(owner.close.mock.calls, [[false]]);
	invoke(owner.dialog().onCloseAutoFocus, { preventDefault });
	assert.equal(owner.restore.mock.calls.length, 1);
});

test("IME suppresses Escape and Enter, cancels pending activation immediately, and clear keeps input focus", async () => {
	const pending = Promise.withResolvers<boolean>();
	const activate = vi.fn((_hit: ConversationSearchHit, _signal: AbortSignal) => pending.promise);
	const owner = host(activate);
	owner.drive();
	await flush();
	invoke(owner.input().onChange, { target: { value: "needle" } });
	await vi.advanceTimersByTimeAsync(180);
	invoke(owner.input().onKeyDown, { key: "Enter", nativeEvent: {}, preventDefault: vi.fn() });
	const signal = activate.mock.calls[0]?.[1];
	assert.ok(signal);
	invoke(owner.input().onCompositionStart);
	assert.equal(signal.aborted, true, "Composition start cancels navigation before the first change event");
	const preventDefault = vi.fn();
	invoke(owner.dialog().onEscapeKeyDown, { isComposing: false, preventDefault });
	assert.equal(preventDefault.mock.calls.length, 1);
	invoke(owner.input().onKeyDown, { key: "Enter", nativeEvent: {}, preventDefault: vi.fn() });
	assert.equal(activate.mock.calls.length, 1);
	pending.resolve(true);
	await flush();
	assert.equal(owner.close.mock.calls.length, 0);
	invoke(owner.input().onCompositionEnd, { currentTarget: { value: "中文" } });
	await vi.advanceTimersByTimeAsync(180);
	const clear = find(owner.drive(), Button).find((item) => item.props.className === "conversation-search-clear");
	assert.ok(clear);
	invoke(clear.props.onClick);
	assert.equal(owner.input().value, "");
	assert.equal(find(owner.drive(), "button").length, 0);
	assert.deepEqual(focus.mock.lastCall, [{ preventScroll: true }]);
});

test("failed activation releases the whole read group before closing can lose its cancellation handle", async () => {
	const activate = vi.fn(async (_hit: ConversationSearchHit, _signal: AbortSignal) => {
		throw new AppError("CURSOR_STALE");
	});
	const owner = host(activate);
	owner.drive();
	await flush();
	invoke(owner.input().onChange, { target: { value: "needle" } });
	await vi.advanceTimersByTimeAsync(180);
	invoke(owner.input().onKeyDown, { key: "Enter", nativeEvent: {}, preventDefault: vi.fn() });
	await flush();
	assert.equal(activate.mock.calls[0]?.[1].aborted, true);
	assert.equal(owner.close.mock.calls.length, 0);
	assert.ok(
		find(owner.drive(), "p").some(
			(item) => item.props.role === "alert" && String(item.props.children).includes("changed"),
		),
	);
});
