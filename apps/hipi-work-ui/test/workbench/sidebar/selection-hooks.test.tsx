import assert from "node:assert/strict";
import type { Scope } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SidebarLocation } from "../../../src/features/workbench/sidebar/selection-owner.ts";
import {
	type SidebarAliasRegistry,
	SidebarSelectionProvider,
	useSidebarAlias,
} from "../../../src/features/workbench/sidebar/selection-provider.tsx";

type Cell = { value?: unknown; deps?: React.DependencyList; cleanup?: () => void };
type Frame = {
	id: string;
	element: HTMLButtonElement | null;
	cells: Cell[];
	cursor: number;
	pending: (() => void)[];
	unsubscribes: (() => void)[];
};
const hooks = vi.hoisted(() => ({
	current: null as Frame | null,
	registry: null as SidebarAliasRegistry | null,
}));

// Bounded adapter: invoke production provider/hook bodies, then explicitly commit
// their effects. Context, stable hook cells, ref attachment and subscriptions are
// injected here. This is not a mounted React, native DOM, or Strict Mode renderer
// test; it cannot establish browser scheduling, mutation delivery or painted UI.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const current = () => {
		if (!hooks.current) throw new Error("No active hook adapter frame");
		return hooks.current;
	};
	const changed = (previous: Cell | undefined, deps: React.DependencyList) =>
		!previous?.deps ||
		previous.deps.length !== deps.length ||
		deps.some((value, index) => !Object.is(value, previous.deps?.[index]));
	const effect = (setup: React.EffectCallback, deps: React.DependencyList) => {
		const frame = current();
		const index = frame.cursor++;
		const previous = frame.cells[index];
		if (changed(previous, deps))
			frame.pending.push(() => {
				previous?.cleanup?.();
				const cleanup = setup();
				frame.cells[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
			});
	};
	return {
		...actual,
		useContext: () => hooks.registry,
		useId: () => {
			const frame = current();
			frame.cells[frame.cursor++] ??= { value: frame.id };
			return frame.id;
		},
		useRef: () => {
			const frame = current();
			const index = frame.cursor++;
			frame.cells[index] ??= { value: { current: frame.element } };
			return frame.cells[index].value;
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const frame = current();
			const index = frame.cursor++;
			if (changed(frame.cells[index], deps)) frame.cells[index] = { value: create(), deps };
			return frame.cells[index]?.value as T;
		},
		useLayoutEffect: effect,
		useSyncExternalStore: <T,>(subscribe: (notify: () => void) => () => void, snapshot: () => T) => {
			const frame = current();
			effect(() => {
				const unsubscribe = vi.fn(subscribe(vi.fn()));
				frame.unsubscribes.push(unsubscribe);
				return unsubscribe;
			}, [subscribe]);
			return snapshot();
		},
	};
});

// All rows in this deliberately small surface are eligible. Eligibility,
// ancestor traversal and real SSR are covered separately in selection-provider.
class AdapterElement {
	readonly ownerDocument: { defaultView: EventTarget & { getComputedStyle: () => { visibility: string } } };
	readonly parentElement: AdapterElement | null;
	readonly isConnected = true;
	constructor(view: AdapterElement["ownerDocument"]["defaultView"], parent: AdapterElement | null = null) {
		this.ownerDocument = { defaultView: view };
		this.parentElement = parent;
	}
	contains(element: AdapterElement) {
		return element === this || element.parentElement === this;
	}
	closest() {
		return null;
	}
	matches() {
		return false;
	}
	getClientRects() {
		return [{ width: 200, height: 32 }];
	}
	compareDocumentPosition() {
		return 4;
	}
}

class AdapterObserver {
	static instances: AdapterObserver[] = [];
	readonly observe = vi.fn();
	readonly disconnect = vi.fn();
	readonly deliver: () => void;
	constructor(callback: () => void) {
		this.deliver = callback;
		AdapterObserver.instances.push(this);
	}
}

// The partial DOM representation crosses into production only at this seam.
function dom(element: AdapterElement): HTMLButtonElement {
	return element as unknown as HTMLButtonElement;
}

const frames: Frame[] = [];
function frame(id: string, element: HTMLButtonElement | null = null): Frame {
	const value: Frame = { id, element, cells: [], cursor: 0, pending: [], unsubscribes: [] };
	frames.push(value);
	return value;
}

function render<T>(owner: Frame, component: () => T): T {
	hooks.current = owner;
	owner.cursor = 0;
	try {
		const output = component();
		for (const commit of owner.pending.splice(0)) commit();
		return output;
	} finally {
		hooks.current = null;
	}
}

function cleanup(owner: Frame) {
	for (const cell of owner.cells) {
		cell.cleanup?.();
		cell.cleanup = undefined;
		// Preserve memo/ref/ID identity while forcing effect setup to run again.
		if (!("value" in cell)) cell.deps = undefined;
	}
}

const scope: Scope = { workspaceId: "workspace", conversationId: "conversation" };
const pinned: SidebarLocation = { kind: "pinned" };
const recent: SidebarLocation = { kind: "recent" };
function harness() {
	const view = Object.assign(new EventTarget(), { getComputedStyle: () => ({ visibility: "visible" }) });
	const add = vi.spyOn(view, "addEventListener");
	const remove = vi.spyOn(view, "removeEventListener");
	const root = new AdapterElement(view);
	const rootRef: React.RefObject<HTMLElement | null> = { current: dom(root) };
	const provider = frame("provider");
	return {
		view,
		add,
		remove,
		provider,
		row: (id: string) => frame(id, dom(new AdapterElement(view, root))),
		provide: (canonical: Scope = scope, preferredLocation: SidebarLocation | null = pinned) => {
			const output = render(provider, () =>
				SidebarSelectionProvider({ scope: canonical, preferredLocation, rootRef, children: null }),
			);
			assert.ok(isValidElement<{ value: SidebarAliasRegistry }>(output));
			hooks.registry = output.props.value;
			return output.props.value;
		},
	};
}

beforeEach(() => {
	AdapterObserver.instances = [];
	vi.stubGlobal("MutationObserver", AdapterObserver);
	vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 });
});
afterEach(() => {
	for (const owner of frames.splice(0).reverse()) cleanup(owner);
	hooks.registry = null;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("only an exact nonempty canonical Scope registers, including across equal conversation IDs", () => {
	const ui = harness();
	const registry = ui.provide();
	const register = vi.spyOn(registry, "register");
	for (const candidate of [
		{ ...scope, workspaceId: "other-workspace" },
		{ ...scope, conversationId: "other-conversation" },
		{ ...scope, conversationId: "" },
	]) {
		const row = ui.row(`${candidate.workspaceId}/${candidate.conversationId}`);
		assert.equal(render(row, () => useSidebarAlias(candidate, pinned)).active, false);
	}
	assert.equal(register.mock.calls.length, 0);
	assert.equal(registry.getSnapshot(), null);
	assert.equal(AdapterObserver.instances.length, 0);
	const row = ui.row("canonical-row");
	render(row, () => useSidebarAlias({ ...scope }, pinned));
	assert.deepEqual(register.mock.calls, [["canonical-row", pinned, row.element]]);
	assert.equal(render(row, () => useSidebarAlias({ ...scope }, pinned)).active, true);
	assert.equal(register.mock.calls.length, 1, "equal Scope objects must not replace their registration");
});

test("same-Scope location changes retire the exact old registration but equal locations do not churn", () => {
	const ui = harness();
	const registry = ui.provide();
	const register = vi.spyOn(registry, "register");
	const row = ui.row("row");
	const locations: SidebarLocation[] = [
		pinned,
		{ kind: "workspace", workspaceId: "first" },
		{ kind: "workspace", workspaceId: "second" },
		recent,
	];
	for (const [index, location] of locations.entries()) {
		const previous = AdapterObserver.instances.at(-1);
		render(row, () => useSidebarAlias(scope, location));
		assert.deepEqual(register.mock.calls[index], ["row", location, row.element]);
		assert.equal(register.mock.calls.length, index + 1);
		assert.equal(previous?.disconnect.mock.calls.length ?? 1, 1);
		assert.equal(AdapterObserver.instances.at(-1)?.disconnect.mock.calls.length, 0);
		assert.equal(render(row, () => useSidebarAlias(scope, { ...location })).active, true);
		assert.equal(register.mock.calls.length, index + 1);
		assert.equal(registry.getSnapshot(), "row");
	}
	assert.equal(ui.remove.mock.calls.length, locations.length - 1);
	for (const call of ui.remove.mock.calls) assert.deepEqual(call, ["resize", registry.reconcile]);
});

for (const replacement of [
	{ ...scope, workspaceId: "next-workspace" },
	{ ...scope, conversationId: "next-conversation" },
]) {
	test(`canonical ${replacement.workspaceId !== scope.workspaceId ? "workspace" : "conversation"} replacement clears the retired owner and resources`, () => {
		const ui = harness();
		const retired = ui.provide();
		const oldRow = ui.row("old-row");
		render(oldRow, () => useSidebarAlias(scope, pinned));
		const oldObserver = AdapterObserver.instances[0];
		const unsubscribe = oldRow.unsubscribes[0];
		assert.ok(oldObserver);
		assert.ok(unsubscribe);
		const current = ui.provide(replacement);
		assert.notEqual(current, retired);
		assert.deepEqual(current.scope, replacement);
		assert.equal(retired.getSnapshot(), null);
		assert.equal(current.getSnapshot(), null, "a new canonical owner must not inherit the old row ID");
		assert.equal(oldObserver.disconnect.mock.calls.length, 1);
		assert.deepEqual(ui.remove.mock.calls, [["resize", retired.reconcile]]);
		const register = vi.spyOn(current, "register");
		assert.equal(render(oldRow, () => useSidebarAlias(scope, pinned)).active, false);
		assert.equal(register.mock.calls.length, 0);
		assert.equal(vi.mocked(unsubscribe).mock.calls.length, 1);
		const newRow = ui.row("new-row");
		render(newRow, () => useSidebarAlias(replacement, recent));
		assert.equal(render(newRow, () => useSidebarAlias(replacement, recent)).active, true);
		oldObserver.deliver();
		ui.view.dispatchEvent(new Event("resize"));
		assert.equal(retired.getSnapshot(), null);
		assert.equal(current.getSnapshot(), "new-row");
		assert.equal(AdapterObserver.instances.length, 2);
		assert.deepEqual(ui.add.mock.calls, [
			["resize", retired.reconcile],
			["resize", current.reconcile],
		]);
	});
}

test("Strict Mode-style cleanup/setup keeps the owner and a retired callback cannot clear the new registration", () => {
	const ui = harness();
	const registry = ui.provide();
	const register = vi.spyOn(registry, "register");
	const row = ui.row("stable-row");
	const initial = render(row, () => useSidebarAlias(scope, pinned));
	const result = register.mock.results[0];
	const oldObserver = AdapterObserver.instances[0];
	assert.ok(result?.type === "return");
	assert.ok(oldObserver);
	cleanup(ui.provider);
	cleanup(row);
	assert.equal(registry.getSnapshot(), null);
	assert.deepEqual(ui.remove.mock.calls, [["resize", registry.reconcile]]);
	assert.equal(ui.provide({ ...scope }), registry);
	const restored = render(row, () => useSidebarAlias(scope, pinned));
	assert.equal(restored.ref, initial.ref);
	assert.deepEqual(register.mock.calls, [
		["stable-row", pinned, row.element],
		["stable-row", pinned, row.element],
	]);
	result.value();
	oldObserver.deliver();
	assert.equal(render(row, () => useSidebarAlias(scope, pinned)).active, true);
	assert.equal(registry.getSnapshot(), "stable-row");
	assert.equal(AdapterObserver.instances.length, 2);
	assert.equal(AdapterObserver.instances[1]?.disconnect.mock.calls.length, 0);
	assert.equal(ui.add.mock.calls.length, 2);
	assert.equal(ui.remove.mock.calls.length, 1);
	cleanup(row);
	assert.equal(registry.getSnapshot(), null);
	assert.equal(ui.remove.mock.calls.length, 2);
});
