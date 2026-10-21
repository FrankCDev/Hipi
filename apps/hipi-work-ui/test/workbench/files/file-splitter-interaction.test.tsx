import assert from "node:assert/strict";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { FileSplitView } from "../../../src/features/files/file-split-view.tsx";
import { FileWorkbench } from "../../../src/features/files/file-workbench.tsx";
import { FileWorkspaceSession } from "../../../src/features/files/file-workspace-session.ts";
import { FilePanel } from "../../../src/features/workbench/files/panel.tsx";
import { FilePanelController } from "../../../src/features/workbench/files/panel-controller.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const connection = vi.hoisted(() => ({ owner: {} }));
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
// Invokes production splitter callbacks/effects. Native pointer capture, focus,
// modal portals and React reconciliation still require browser/platform coverage.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const changed = (previous: React.DependencyList | undefined, next: React.DependencyList) =>
		!previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
	const mock = {
		...actual,
		useCallback: <T,>(callback: T) => callback,
		useDebugValue: () => {},
		useState: <T,>(initial: T | (() => T)) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = cell;
			return [
				cell.value,
				(next: T | ((value: T) => T)) => {
					const value = typeof next === "function" ? (next as (value: T) => T)(cell.value as T) : next;
					if (!Object.is(cell.value, value)) hooks.changed = true;
					cell.value = value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: { current: initial } };
			return hooks.cells[index].value;
		},
		useId: () => `split-${hooks.cursor++}`,
		useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const previous = hooks.cells[index];
			if (!previous || changed(previous.deps, deps))
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
	return { ...mock, default: mock };
});
// This callback fixture supplies a stable connection identity; mounted ownership
// and reconciliation are covered by file-panel-lifecycle.test.tsx.
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => connection.owner }));
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));

function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function drive(render: () => React.ReactNode) {
	for (let attempt = 0; attempt < 5; attempt++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const result = render();
		for (const commit of hooks.commits.splice(0)) commit();
		if (!hooks.changed) return result;
	}
	throw new Error("Splitter effects did not settle");
}
function pointerTarget() {
	const captured = new Set<number>();
	return {
		focus: vi.fn(),
		hasPointerCapture: (pointer: number) => captured.has(pointer),
		setPointerCapture: vi.fn((pointer: number) => captured.add(pointer)),
		releasePointerCapture: vi.fn((pointer: number) => captured.delete(pointer)),
	};
}
function pointer(
	callback: React.PointerEventHandler<HTMLHRElement> | undefined,
	target: ReturnType<typeof pointerTarget>,
	x: number,
	pointerId = 1,
	button = 0,
) {
	assert.ok(callback);
	Reflect.apply(callback, undefined, [
		{ clientX: x, pointerId, button, currentTarget: target, preventDefault: vi.fn() },
	]);
}
function key(node: React.ReactNode, value: string) {
	const separator = elements(node, "hr")[0];
	assert.ok(separator?.props.onKeyDown);
	Reflect.apply(separator.props.onKeyDown, undefined, [{ key: value, preventDefault: vi.fn() }]);
}
let panel: FilePanelController;
let local: LocalState;
let available = 1200;
let trigger: { current: HTMLButtonElement | null };
const focus = vi.fn();
const sessions: FileWorkspaceSession[] = [];
function panelView(session?: FileWorkspaceSession) {
	return drive(() =>
		FilePanel({
			controller: panel,
			available,
			workspaceId: "workspace",
			session,
			guard: (action) => action(),
			trigger,
			id: "files",
		}),
	);
}
function separator(node: React.ReactNode) {
	const value = elements(node, "hr")[0];
	assert.ok(value);
	return value.props;
}
beforeEach(() => {
	connection.owner = {};
	hooks.cells = [];
	hooks.commits = [];
	vi.clearAllMocks();
	local = new LocalState();
	panel = new FilePanelController(local);
	panel.setOpen(true);
	panel.resize(640, 1200);
	available = 1200;
	trigger = { current: { focus } as HTMLButtonElement };
});
afterEach(() => {
	for (const cell of hooks.cells) cell?.cleanup?.();
	for (const session of sessions.splice(0)) session.dispose();
});

test("dock gesture enters and leaves full width without replacing the file owner, then collapses with focus return", async () => {
	const session = new FileWorkspaceSession({
		readText: async () => ({ text: "baseline", revision: "a".repeat(64), bytes: 8, encoding: "utf-8" }),
	} as FileClient);
	sessions.push(session);
	await session.open({ workspaceId: "workspace", rootId: "root", path: "work.txt" }, true);
	const tab = session.snapshot().tabs[0];
	assert.ok(tab?.kind === "editor");
	tab.editor.edit("unsaved");
	const snapshot = session.snapshot();
	const target = pointerTarget();
	let view = panelView(session);
	const firstOwner = elements(view, FileWorkbench)[0];
	assert.ok(firstOwner);
	assert.equal(firstOwner.props.session, session);
	const handle = separator(view);
	pointer(handle.onPointerDown, target, 560);
	pointer(handle.onPointerMove, target, 160);
	assert.equal(panel.store.getState().fullWidth, false); // Exactly 160px of conversation remains.
	pointer(handle.onPointerMove, target, 159);
	assert.equal(panel.store.getState().fullWidth, true);
	view = panelView(session);
	assert.equal(elements(view, "section")[0]?.props.style?.width, 1200);
	assert.equal(elements(view, FileWorkbench)[0]?.type, firstOwner?.type);
	assert.equal(elements(view, FileWorkbench)[0]?.props.session, session);
	assert.equal(elements(view, FileWorkbench)[0]?.key, firstOwner.key);
	pointer(separator(view).onPointerUp, target, 159);
	assert.equal(target.hasPointerCapture(1), false);
	key(panelView(session), "ArrowRight");
	assert.equal(panel.store.getState().fullWidth, false);
	assert.equal(panel.store.getState().width, 640);
	view = panelView(session);
	pointer(separator(view).onPointerDown, target, 560);
	pointer(separator(view).onPointerMove, target, 1040);
	assert.equal(panel.store.getState().open, true); // Exactly 160px stays open.
	pointer(separator(view).onPointerMove, target, 1041);
	assert.equal(panel.store.getState().open, false);
	assert.equal(target.hasPointerCapture(1), false);
	assert.deepEqual(focus.mock.calls.at(-1), [{ preventScroll: true }]);
	const hidden = panelView(session);
	assert.equal(elements(hidden, "section")[0]?.props.inert, true);
	assert.equal(elements(hidden, "section")[0]?.props["aria-hidden"], true);
	// Explicit close intentionally unmounts presentation, not its session owner.
	assert.equal(elements(hidden, FileWorkbench).length, 0);
	assert.equal(session.snapshot(), snapshot);
	assert.equal(tab.editor.snapshot().document?.text, "unsaved");
	assert.equal(session.protected, true);
	panel.setOpen(true);
	const reopened = panelView(session);
	assert.equal(elements(reopened, "section")[0]?.props.inert, false);
	assert.equal(elements(reopened, FileWorkbench).length, 1);
	assert.equal(elements(reopened, FileWorkbench)[0]?.props.session, session);
	assert.equal(panel.store.getState().width, 640);
});

test.each(["cancel", "lost", "unmount", "narrow"] as const)(
	"dock %s retires capture and rolls back preview without writing the ratio",
	(reason) => {
		const initial = panel.store.getState();
		const saved = local.read("file-panel.ratio");
		const target = pointerTarget();
		const handle = separator(panelView());
		pointer(handle.onPointerDown, target, 560);
		pointer(handle.onPointerMove, target, 400);
		assert.equal(panel.store.getState().width, 800);
		if (reason === "cancel") pointer(handle.onPointerCancel, target, 400);
		if (reason === "lost") {
			target.releasePointerCapture(1);
			pointer(handle.onLostPointerCapture, target, 400);
		}
		if (reason === "unmount") for (const cell of hooks.cells) cell?.cleanup?.();
		if (reason === "narrow") {
			available = 600;
			panelView();
		}
		assert.equal(target.hasPointerCapture(1), false);
		assert.deepEqual(panel.store.getState(), initial);
		assert.equal(local.read("file-panel.ratio"), saved);
		pointer(handle.onPointerMove, target, -10000);
		assert.deepEqual(panel.store.getState(), initial);
	},
);

test("dock keyboard retains steps and Home/End bounds with accessible edge transitions", () => {
	key(panelView(), "ArrowLeft");
	assert.equal(panel.store.getState().width, 664);
	key(panelView(), "Home");
	assert.equal(panel.store.getState().width, 320);
	key(panelView(), "ArrowRight");
	assert.equal(panel.store.getState().open, false);
	panel.setOpen(true);
	key(panelView(), "End");
	assert.equal(panel.store.getState().width, 847);
	key(panelView(), "ArrowLeft");
	assert.equal(panel.store.getState().fullWidth, true);
	key(panelView(), "ArrowRight");
	assert.equal(panel.store.getState().fullWidth, false);
	assert.equal(panel.store.getState().width, 847);
});

test("tree uses the independent 100px collapse threshold and 60 percent maximum, restoring pre-gesture preference", () => {
	let width = 240;
	let treeOpen = true;
	const content = <div>Retained editor</div>;
	const render = () =>
		drive(() =>
			FileSplitView({
				content,
				tree: <div>Tree</div>,
				treeOpen,
				width,
				onResize: (next) => {
					width = next;
				},
				onCollapse: () => {
					treeOpen = false;
				},
			}),
		);
	const target = pointerTarget();
	const handle = separator(render());
	pointer(handle.onPointerDown, target, 400, 2, 1);
	assert.equal(target.hasPointerCapture(2), false);
	pointer(handle.onPointerDown, target, 400);
	pointer(handle.onPointerMove, target, -10000, 2);
	assert.equal(width, 240);
	pointer(handle.onPointerMove, target, -10000);
	assert.equal(width, 384);
	pointer(handle.onPointerMove, target, 540);
	assert.equal(treeOpen, true);
	assert.equal(width, 200);
	pointer(handle.onPointerMove, target, 540.01);
	assert.equal(treeOpen, false);
	assert.equal(width, 240);
	assert.equal(target.hasPointerCapture(1), false);
	assert.ok(elements(render(), "div").some((node) => node.props.children === content));
	treeOpen = true;
	key(render(), "Home");
	assert.equal(width, 200);
	key(render(), "ArrowRight");
	assert.equal(treeOpen, false);
});

test.each(["cancel", "lost", "unmount"] as const)(
	"tree %s releases its gesture without retaining preview width",
	(reason) => {
		let width = 240;
		const target = pointerTarget();
		const view = drive(() =>
			FileSplitView({
				content: <div>Editor</div>,
				tree: <div>Tree</div>,
				treeOpen: true,
				width,
				onResize: (next) => {
					width = next;
				},
				onCollapse: () => {},
			}),
		);
		const handle = separator(view);
		pointer(handle.onPointerDown, target, 400);
		pointer(handle.onPointerMove, target, 300);
		assert.equal(width, 340);
		if (reason === "cancel") pointer(handle.onPointerCancel, target, 300);
		if (reason === "lost") {
			target.releasePointerCapture(1);
			pointer(handle.onLostPointerCapture, target, 300);
		}
		if (reason === "unmount") for (const cell of hooks.cells) cell?.cleanup?.();
		assert.equal(width, 240);
		assert.equal(target.hasPointerCapture(1), false);
	},
);
