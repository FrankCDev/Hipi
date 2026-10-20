import assert from "node:assert/strict";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ConversationPreviewInteraction } from "../../../src/features/workbench/sidebar/conversation-preview-interaction.ts";
import type { SidebarPreviewCoordinator } from "../../../src/features/workbench/sidebar/preview-coordinator.ts";
import { SidebarPreviewProvider } from "../../../src/features/workbench/sidebar/preview-provider.tsx";

type Cell = { value?: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	layouts: [] as (() => void)[],
	effects: [] as (() => void)[],
	dragging: false,
}));
// Production provider callbacks with owned EventTarget listeners. This is not a
// mounted React/portal test and cannot establish painted-frame continuity.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const effect = (queue: (() => void)[], setup: React.EffectCallback, deps: React.DependencyList) => {
		const index = hooks.cursor++;
		const previous = hooks.cells[index];
		if (!previous?.deps || deps.some((value, offset) => !Object.is(value, previous.deps?.[offset])))
			queue.push(() => {
				previous?.cleanup?.();
				const cleanup = setup();
				hooks.cells[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
			});
	};
	return {
		...actual,
		useState: <T,>(initial: () => T) => {
			const index = hooks.cursor++;
			if (!hooks.cells[index]) hooks.cells[index] = { value: initial() };
			return [hooks.cells[index]?.value];
		},
		useLayoutEffect: (setup: React.EffectCallback, deps: React.DependencyList) => effect(hooks.layouts, setup, deps),
		useEffect: (setup: React.EffectCallback, deps: React.DependencyList) => effect(hooks.effects, setup, deps),
	};
});
vi.mock("../../../src/features/workbench/sidebar/drag-provider.tsx", () => ({
	useSidebarDragging: () => hooks.dragging,
}));

function render(disabled = false, navigationKey = "initial") {
	hooks.cursor = 0;
	const output = SidebarPreviewProvider({ disabled, navigationKey, children: null });
	for (const commit of hooks.layouts.splice(0)) commit();
	for (const commit of hooks.effects.splice(0)) commit();
	assert.ok(isValidElement<{ value: SidebarPreviewCoordinator }>(output));
	return output.props.value;
}

beforeEach(() => {
	hooks.cells = [];
	hooks.layouts = [];
	hooks.effects = [];
	hooks.dragging = false;
	vi.useFakeTimers();
	vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
	for (const cell of hooks.cells) cell.cleanup?.();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("navigation and disabled-surface changes close the old owner and cancel its delayed work", () => {
	const coordinator = render();
	const row = new ConversationPreviewInteraction(() => {}, coordinator);
	row.enter(true);
	assert.equal(row.mode, "hover");
	render(false, "next");
	assert.equal(row.mode, "closed");
	row.enter();
	vi.advanceTimersByTime(199);
	assert.equal(row.mode, "closed");
	render(true, "next");
	vi.advanceTimersByTime(1000);
	row.enter(true, true);
	assert.equal(row.mode, "closed");
	render(false, "next");
	row.enter();
	vi.advanceTimersByTime(200);
	assert.equal(row.mode, "hover");
});

test("actual provider drag and window blur clear warmth without returning focus or reopening", () => {
	const coordinator = render();
	const row = new ConversationPreviewInteraction(() => {}, coordinator);
	row.pin();
	hooks.dragging = true;
	render();
	assert.equal(row.mode, "closed");
	assert.equal(row.consumeFocusReturn(), false);
	hooks.dragging = false;
	render();
	row.enter();
	vi.advanceTimersByTime(200);
	assert.equal(row.mode, "hover");
	window.dispatchEvent(new Event("blur"));
	assert.equal(row.mode, "closed");
	row.enter();
	vi.advanceTimersByTime(199);
	assert.equal(row.mode, "closed");
	vi.advanceTimersByTime(1);
	assert.equal(row.mode, "hover");
});

test("provider disposal removes its listener and Strict Mode can reacquire the same scoped coordinator", () => {
	const add = vi.spyOn(window, "addEventListener");
	const remove = vi.spyOn(window, "removeEventListener");
	const coordinator = render();
	const row = new ConversationPreviewInteraction(() => {}, coordinator);
	row.enter();
	for (const cell of hooks.cells) {
		cell.cleanup?.();
		cell.cleanup = undefined;
		cell.deps = undefined;
	}
	vi.advanceTimersByTime(500);
	assert.equal(row.mode, "closed");
	assert.equal(remove.mock.calls.length, 1);
	assert.equal(add.mock.calls[0]?.[1], remove.mock.calls[0]?.[1]);
	assert.equal(render(), coordinator);
	assert.equal(add.mock.calls.length, 2);
	row.enter();
	vi.advanceTimersByTime(200);
	assert.equal(row.mode, "hover");
});
