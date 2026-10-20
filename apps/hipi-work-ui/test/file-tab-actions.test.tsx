import assert from "node:assert/strict";
import { type FileRoot, FileServiceError } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type { PreviewClient, PreviewHandle } from "@hipi/work-runtime/previews/protocol";
import { ContextMenu } from "radix-ui";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { FileBuffer } from "../src/features/files/file-buffer.tsx";
import { FileSplitView } from "../src/features/files/file-split-view.tsx";
import { FileTabContextMenu } from "../src/features/files/file-tab-menu.tsx";
import { FileTabs } from "../src/features/files/file-tabs.tsx";
import { FileWorkbench } from "../src/features/files/file-workbench.tsx";
import { FileWorkspaceSession } from "../src/features/files/file-workspace-session.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
// Drives production owner callbacks, not native context-menu placement or focus.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const changed = (old: React.DependencyList | undefined, next: React.DependencyList) =>
		!old || old.length !== next.length || next.some((value, index) => !Object.is(value, old[index]));
	return {
		...actual,
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = cell;
			return [
				cell.value,
				(next: T | ((value: T) => T)) => {
					const value = typeof next === "function" ? (next as (value: T) => T)(cell.value as T) : next;
					hooks.changed ||= !Object.is(cell.value, value);
					cell.value = value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: { current: initial } };
			return hooks.cells[index]?.value;
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			if (changed(hooks.cells[index]?.deps, deps)) hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const old = hooks.cells[index];
			if (changed(old?.deps, deps))
				hooks.commits.push(() => {
					old?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
});
const root: FileRoot = { workspaceId: "w", rootId: "r", writable: true };
const cache = { invalidateQueries: vi.fn(async () => {}) };
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => cache,
	useQuery: () => ({ data: [root], isPending: false, isError: false, isFetching: false, refetch: async () => {} }),
}));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../src/app/client-provider.tsx", () => ({ useFiles: () => port }));
const text = { text: "original", revision: "a".repeat(64), bytes: 8, encoding: "utf-8" as const };
let port: { files: FileClient };
let session: FileWorkspaceSession;
let workspaceId = "w";
let visible: boolean | undefined;
function reset() {
	for (const cell of hooks.cells) cell.cleanup?.();
	hooks.cells = [];
	hooks.commits = [];
}
function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function drive() {
	for (let count = 0; count < 10; count++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const tree = FileWorkbench({ workspaceId, session, visible });
		for (const commit of hooks.commits.splice(0)) commit();
		if (hooks.changed) continue;
		const split = elements(tree, FileSplitView)[0];
		assert.ok(split);
		const tabs = elements(split.props.content, FileTabs)[0];
		const panel = elements(split.props.content, "section").find((item) => item.props.role === "tabpanel");
		const buffer = elements(split.props.content, FileBuffer)[0];
		const dialog = elements(tree, Dialog).at(-1);
		assert.ok(dialog);
		const treeToggle = elements(tree, Button).find((item) => item.props["aria-label"] === "Toggle file tree");
		return { tabs, panel, buffer, dialog, tree: split.props.tree, split, treeToggle };
	}
	throw new Error("Effects did not settle");
}
function press(node: React.ReactNode, label: string) {
	const button = elements(node, Button).find((item) => item.props.children === label);
	assert.ok(button?.props.onClick);
	Reflect.apply(button.props.onClick, undefined, []);
	return button.props.onClick;
}
async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}
async function open(path: string, pinned = true, workspace = "w") {
	await session.open({ workspaceId: workspace, rootId: "r", path }, true, { pinned });
	const tab = session.snapshot().tabs.find((item) => item.id === session.snapshot().activeId);
	assert.ok(tab?.kind === "editor");
	return tab;
}
class ElementStub {
	constructor(private exempt = false) {}
	hasAttribute(name: string) {
		return this.exempt && name === "data-tab-preview-pin-exempt";
	}
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("Element", ElementStub);
	workspaceId = "w";
	visible = undefined;
	port = {
		files: {
			listRoots: vi.fn(async () => [root]),
			list: async () => ({ entries: [], nextCursor: null }),
			readText: vi.fn(async () => text),
			saveText: vi.fn(async () => {
				throw new FileServiceError("WRITE_OUTCOME_UNKNOWN");
			}),
			preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
		},
	};
	session = new FileWorkspaceSession(port.files);
	session.setWorkspace("w");
});
afterEach(() => {
	reset();
	session.dispose();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("failed and canceled initial reads expose Retry for the same tab with fresh current authority", async () => {
	vi.mocked(port.files.readText).mockRejectedValueOnce(new FileServiceError("IO_ERROR"));
	const tab = await open("failed.txt");
	const selected = drive().buffer;
	assert.ok(selected);
	reset();
	hooks.cursor = 0;
	const content = FileBuffer(selected.props);
	press(content, "Retry");
	await flush();
	assert.equal(tab.editor.snapshot().document?.text, "original");
	assert.equal(session.snapshot().tabs.length, 1);
	assert.equal(vi.mocked(port.files.listRoots).mock.calls.length, 1);
	assert.equal(vi.mocked(port.files.readText).mock.calls.length, 2);
});

test("repeated retry and late canceled results cannot replace a current document or retired tab", async () => {
	const pending = Promise.withResolvers<typeof text>();
	vi.mocked(port.files.readText).mockImplementationOnce(() => pending.promise);
	const opening = session.open({ workspaceId: "w", rootId: "r", path: "cancel.txt" }, true, { pinned: true });
	const tab = session.snapshot().tabs[0];
	assert.ok(tab?.kind === "editor");
	tab.editor.cancel();
	assert.equal(tab.editor.snapshot().operation, undefined);
	const retry = session.retry(tab.id);
	void session.retry(tab.id);
	await retry;
	pending.resolve({ ...text, text: "late stale bytes" });
	await opening;
	assert.equal(tab.editor.snapshot().document?.text, "original");
	assert.equal(vi.mocked(port.files.readText).mock.calls.length, 2);
	await session.retry(tab.id);
	assert.equal(vi.mocked(port.files.readText).mock.calls.length, 2);
	session.discard([tab.id]);
	await session.retry(tab.id);
	assert.equal(session.snapshot().tabs.length, 0);
});

test("retry rechecks revoked authority and retains latest artifact reference without creating a new tab", async () => {
	vi.mocked(port.files.readText).mockRejectedValueOnce(new FileServiceError("IO_ERROR"));
	const tab = await open("artifact.md");
	await session.openArtifact(tab.target, { operationId: "latest", expectedRevision: "c".repeat(64) });
	vi.mocked(port.files.listRoots).mockResolvedValueOnce([]);
	await session.retry(tab.id);
	assert.equal(tab.editor.snapshot().error, "UNAUTHORIZED");
	assert.equal(vi.mocked(port.files.readText).mock.calls.length, 1);
	await session.retry(tab.id);
	assert.equal(tab.editor.snapshot().document?.artifactReference?.operationId, "latest");
	assert.equal(tab.editor.snapshot().document?.baseline.revision, text.revision);
});

test.each(["onPointerDownCapture", "onKeyDownCapture"] as const)(
	"real panel %s pins its exact transient tab, but exemption, tree, focus and retired callbacks do not",
	async (eventName) => {
		const tab = await open("transient.txt", false);
		const view = drive();
		const handler = view.panel?.props[eventName];
		assert.ok(handler);
		assert.equal(view.panel?.props.onFocus, undefined);
		assert.equal(
			elements(view.tree, "section").some((item) => !!item.props[eventName]),
			false,
		);
		Reflect.apply(handler, undefined, [{ nativeEvent: { composedPath: () => [new ElementStub(true)] } }]);
		assert.equal(session.snapshot().tabs[0]?.pinned, false);
		Reflect.apply(handler, undefined, [{ nativeEvent: { composedPath: () => [new ElementStub()] } }]);
		assert.equal(session.snapshot().tabs[0]?.pinned, true);
		const other = await open("other.txt", false);
		Reflect.apply(handler, undefined, [{ nativeEvent: { composedPath: () => [] } }]);
		assert.equal(session.snapshot().tabs.find((item) => item.id === other.id)?.pinned, false);
		assert.equal(session.snapshot().tabs.find((item) => item.id === tab.id)?.pinned, true);
		workspaceId = "retired";
		drive();
		Reflect.apply(handler, undefined, [{ nativeEvent: { composedPath: () => [] } }]);
		assert.equal(session.snapshot().tabs.find((item) => item.id === other.id)?.pinned, false);
	},
);

test("inactive-tab context actions use clicked identity, live order and workspace, never active-tab identity", async () => {
	const first = await open("first.txt");
	const second = await open("second.txt");
	const third = await open("third.txt");
	const hidden = await open("hidden.txt", true, "other");
	session.select(third.id);
	const close = vi.fn();
	hooks.cursor = 0;
	const tabList = FileTabs({
		tabs: session.snapshot().tabs.filter((tab) => tab.target.workspaceId === "w"),
		activeId: third.id,
		session,
		close,
		closing: false,
	});
	assert.deepEqual(
		elements(tabList, FileTabContextMenu).map((item) => item.props.id),
		[first.id, second.id, third.id],
	);
	const tree = FileTabContextMenu({ id: second.id, session, close, closing: false, children: null });
	const choose = (label: string) => {
		const item = elements(tree, ContextMenu.Item).find((node) => node.props.children === label);
		assert.ok(item?.props.onSelect);
		Reflect.apply(item.props.onSelect, undefined, [{}]);
	};
	choose("Close file");
	assert.deepEqual(close.mock.lastCall, [[second.id]]);
	choose("Close other files");
	assert.deepEqual(close.mock.lastCall, [[first.id, third.id]]);
	choose("Close files to the right");
	assert.deepEqual(close.mock.lastCall, [[third.id]]);
	session.discard([second.id]);
	choose("Close files to the right");
	assert.deepEqual(close.mock.lastCall, [[]]);
	assert.ok(session.snapshot().tabs.some((tab) => tab.id === hidden.id));
});

test("per-tab close keeps unknown work for confirmation, refreshes changed drafts, and ignores stale/canceled callbacks", async () => {
	const tab = await open("protected.txt");
	tab.editor.edit("first draft");
	const action = drive().tabs?.props.close;
	assert.ok(action);
	action([tab.id]);
	action([tab.id]);
	await flush();
	assert.equal(vi.mocked(port.files.saveText).mock.calls.length, 1);
	let review = drive().dialog;
	assert.equal(review.props.open, true);
	const old = elements(review.props.children, Button).find(
		(button) => button.props.children === "Discard and continue",
	);
	assert.ok(old?.props.onClick);
	tab.editor.edit("later draft");
	Reflect.apply(old.props.onClick, undefined, []);
	assert.equal(tab.editor.snapshot().document?.text, "later draft");
	review = drive().dialog;
	press(review.props.children, "Keep editing");
	Reflect.apply(old.props.onClick, undefined, []);
	assert.equal(session.snapshot().tabs.length, 1);
	action([tab.id]);
	await flush();
	review = drive().dialog;
	const confirm = press(review.props.children, "Discard and continue");
	Reflect.apply(confirm, undefined, []);
	assert.equal(session.snapshot().tabs.length, 0);
});

test("late close failure cannot open a discard dialog in a newer workspace", async () => {
	const pending = Promise.withResolvers<typeof text>();
	vi.mocked(port.files.saveText).mockImplementationOnce(() => pending.promise);
	const tab = await open("pending.txt");
	tab.editor.edit("keep pending");
	drive().tabs?.props.close([tab.id]);
	workspaceId = "other";
	session.setWorkspace("other");
	drive();
	pending.reject(new FileServiceError("WRITE_OUTCOME_UNKNOWN"));
	await flush();
	assert.equal(drive().dialog.props.open, false);
	assert.equal(tab.editor.snapshot().unknown, "keep pending");
	assert.equal(session.snapshot().tabs.length, 1);
});

test("retired retry owner ignores its late read result after exact tab disposal", async () => {
	vi.mocked(port.files.readText).mockRejectedValueOnce(new FileServiceError("IO_ERROR"));
	const tab = await open("retry.txt");
	const pending = Promise.withResolvers<typeof text>();
	vi.mocked(port.files.readText).mockImplementationOnce(() => pending.promise);
	const retry = session.retry(tab.id);
	await flush();
	session.discard([tab.id]);
	pending.resolve({ ...text, text: "retired bytes" });
	await retry;
	assert.deepEqual(tab.editor.snapshot(), {});
	assert.equal(session.snapshot().tabs.length, 0);
});

test("reload confirmation refreshes newer protected input before executing the same exact action once", async () => {
	const tab = await open("reload.txt");
	tab.editor.edit("reviewed draft");
	const action = vi.fn(() => tab.editor.reload());
	const guard = drive().buffer?.props.guard;
	assert.ok(guard);
	guard(action);
	const first = drive().dialog;
	const staleConfirm = elements(first.props.children, Button).find(
		(item) => item.props.children === "Discard and continue",
	)?.props.onClick;
	assert.ok(staleConfirm);
	tab.editor.edit("newer protected draft");
	Reflect.apply(staleConfirm, undefined, []);
	assert.equal(action.mock.calls.length, 0);
	assert.equal(tab.editor.snapshot().document?.text, "newer protected draft");
	assert.equal(vi.mocked(port.files.readText).mock.calls.length, 1);
	Reflect.apply(staleConfirm, undefined, []);
	assert.equal(action.mock.calls.length, 0);
	const refreshed = drive().dialog;
	assert.equal(refreshed.props.open, true);
	const confirm = press(refreshed.props.children, "Discard and continue");
	Reflect.apply(confirm, undefined, []);
	await flush();
	assert.equal(action.mock.calls.length, 1);
	assert.equal(vi.mocked(port.files.readText).mock.calls.length, 2);
	assert.equal(tab.editor.snapshot().document?.text, "original");
	assert.equal(drive().dialog.props.open, false);
});

test.each(["removed", "replaced", "workspace", "session", "connection", "unmount"] as const)(
	"reload review cannot execute after its exact %s lifetime retires",
	async (retirement) => {
		const originalSession = session;
		const tab = await open("retained.txt");
		tab.editor.edit("keep protected");
		const action = vi.fn(() => tab.editor.reload());
		const guard = drive().buffer?.props.guard;
		assert.ok(guard);
		guard(action);
		const confirm = elements(drive().dialog.props.children, Button).find(
			(item) => item.props.children === "Discard and continue",
		)?.props.onClick;
		assert.ok(confirm);
		if (retirement === "removed" || retirement === "replaced") {
			session.discard([tab.id]);
			if (retirement === "replaced") {
				const replacement = await open("retained.txt");
				replacement.editor.edit("replacement protected");
			}
			drive();
		} else if (retirement === "workspace") {
			workspaceId = "other";
			session.setWorkspace(workspaceId);
			drive();
		} else if (retirement === "session") {
			session = new FileWorkspaceSession(port.files);
			session.setWorkspace(workspaceId);
			drive();
		} else if (retirement === "connection") {
			port = { files: { ...port.files } };
			drive();
		} else reset();
		Reflect.apply(confirm, undefined, []);
		guard(action);
		assert.equal(action.mock.calls.length, 0);
		assert.equal(vi.mocked(port.files.readText).mock.calls.length, retirement === "replaced" ? 2 : 1);
		if (retirement === "replaced")
			assert.equal(
				session.snapshot().tabs[0]?.kind === "editor" && session.snapshot().tabs[0].editor.snapshot().document?.text,
				"replacement protected",
			);
		else if (retirement !== "removed") assert.equal(tab.editor.snapshot().document?.text, "keep protected");
		if (originalSession !== session) originalSession.dispose();
	},
);

test("cancel invalidates reload confirmation, while an unchanged clean reload needs no prompt", async () => {
	const tab = await open("cancel-reload.txt");
	tab.editor.edit("keep");
	const action = vi.fn(() => tab.editor.reload());
	const guard = drive().buffer?.props.guard;
	assert.ok(guard);
	guard(action);
	const review = drive().dialog;
	const stale = elements(review.props.children, Button).find((item) => item.props.children === "Discard and continue")
		?.props.onClick;
	assert.ok(stale);
	press(review.props.children, "Keep editing");
	Reflect.apply(stale, undefined, []);
	assert.equal(action.mock.calls.length, 0);
	assert.equal(tab.editor.snapshot().document?.text, "keep");
	tab.editor.edit("original");
	guard(action);
	guard(action);
	assert.equal(action.mock.calls.length, 1);
	assert.equal(drive().dialog.props.open, false);
	await flush();
});

test("tree collapse keeps every file owner and preferred width, updates the toggle and returns focus", async () => {
	const tab = await open("draft.txt");
	tab.editor.edit("keep");
	session.layout.treeWidth = 275;
	const view = drive();
	const focus = vi.fn();
	assert.ok(view.treeToggle?.props.ref);
	(view.treeToggle.props.ref as React.RefObject<unknown>).current = { focus };
	view.split.props.onCollapse();
	const collapsed = drive();
	assert.equal(collapsed.split.props.treeOpen, false);
	assert.equal(session.layout.treeOpen, false);
	assert.equal(collapsed.split.props.width, 275);
	assert.equal(session.layout.treeWidth, 275);
	assert.equal(session.snapshot().tabs[0]?.id, tab.id);
	assert.equal(tab.editor.snapshot().document?.text, "keep");
	assert.deepEqual(focus.mock.calls, [[{ preventScroll: true }]]);
	assert.equal(collapsed.treeToggle?.props["aria-pressed"], false);
});

test("retained panel visibility releases all preview handles and reopens only the active preview with fresh resources", async () => {
	let sequence = 0;
	const previews: PreviewClient = {
		open: vi.fn(async () => ({
			id: `handle-${++sequence}`,
			revision: text.revision,
			kind: "png",
			summary: { bytes: 1, pages: 1, truncated: false },
		})),
		readBytes: vi.fn(async (id, offset) => ({ id, offset, revision: text.revision, total: 1, base64: "AA==" })),
		readPage: async () => {
			throw new Error("Unexpected page read");
		},
		close: vi.fn(async () => {}),
	};
	session.dispose();
	session = new FileWorkspaceSession(port.files, previews);
	session.setWorkspace("w");
	const editor = await open("retained.txt");
	editor.editor.edit("retained draft");
	await session.openPreview({ workspaceId: "w", rootId: "r", path: "first.png" }, true);
	await session.openPreview({ workspaceId: "w", rootId: "r", path: "second.png" }, true);
	const previewTabs = session.snapshot().tabs.filter((tab) => tab.kind === "preview");
	const active = previewTabs.at(-1);
	assert.ok(active);
	const firstBytes = active.preview.snapshot().bytes;
	assert.ok(firstBytes);
	drive();
	assert.equal(vi.mocked(previews.open).mock.calls.length, 2, "default visibility reuses existing resources");
	visible = false;
	drive();
	assert.deepEqual(vi.mocked(previews.close).mock.calls, [["handle-1"], ["handle-2"]]);
	for (const tab of previewTabs) assert.deepEqual(tab.preview.snapshot(), {});
	assert.equal(session.snapshot().activeId, active.id);
	assert.equal(session.snapshot().tabs[0], editor);
	assert.equal(editor.editor.snapshot().document?.text, "retained draft");
	drive();
	assert.equal(vi.mocked(previews.open).mock.calls.length, 2);
	visible = true;
	drive();
	await flush();
	assert.equal(vi.mocked(previews.open).mock.calls.length, 3);
	assert.equal(active.preview.snapshot().handle?.id, "handle-3");
	assert.notEqual(active.preview.snapshot().bytes, firstBytes);
	assert.equal(previewTabs[0]?.preview.snapshot().handle, undefined);
	assert.equal(session.snapshot().activeId, active.id);
	reset();
	assert.deepEqual(vi.mocked(previews.close).mock.calls, [["handle-1"], ["handle-2"], ["handle-3"]]);
});

test("hiding a retained panel cancels pending preview acquisition and cannot resume it while hidden", async () => {
	const pending = Promise.withResolvers<PreviewHandle>();
	const previews: PreviewClient = {
		open: vi.fn(() => pending.promise),
		readBytes: vi.fn(),
		readPage: vi.fn(),
		close: vi.fn(async () => {}),
	};
	session.dispose();
	session = new FileWorkspaceSession(port.files, previews);
	session.setWorkspace("w");
	const opening = session.openPreview({ workspaceId: "w", rootId: "r", path: "pending.png" }, true);
	const tab = session.snapshot().tabs[0];
	assert.ok(tab?.kind === "preview");
	drive();
	visible = false;
	drive();
	pending.resolve({
		id: "late-handle",
		revision: text.revision,
		kind: "png",
		summary: { bytes: 1, pages: 1, truncated: false },
	});
	await opening;
	drive();
	assert.deepEqual(vi.mocked(previews.close).mock.calls, [["late-handle"]]);
	assert.equal(vi.mocked(previews.open).mock.calls.length, 1);
	assert.equal(vi.mocked(previews.readBytes).mock.calls.length, 0);
	assert.deepEqual(tab.preview.snapshot(), {});
	assert.equal(session.snapshot().tabs[0], tab);
	assert.equal(session.snapshot().activeId, tab.id);
});

test("tab drop uses target halves including the last edge and ignores a canceled or external drag", async () => {
	const first = await open("first.txt");
	const second = await open("second.txt");
	const third = await open("third.txt");
	hooks.cursor = 0;
	const tree = FileTabs({ tabs: session.snapshot().tabs, activeId: third.id, session, close: vi.fn(), closing: false });
	const buttons = elements(tree, "button").filter((node) => node.props.role === "tab");
	const start = buttons[0]?.props.onDragStart;
	const end = buttons[0]?.props.onDragEnd;
	const drop = buttons[2]?.props.onDrop;
	assert.ok(start && end && drop);
	const values = new Map<string, string>();
	const event = {
		preventDefault: vi.fn(),
		clientX: 90,
		currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) },
		dataTransfer: {
			effectAllowed: "none",
			setData: (type: string, value: string) => values.set(type, value),
			getData: (type: string) => values.get(type) ?? "",
		},
	};
	values.set("application/x-hipi-file-tab", first.id);
	Reflect.apply(drop, undefined, [event]);
	assert.deepEqual(
		session.snapshot().tabs.map((tab) => tab.id),
		[first.id, second.id, third.id],
	);
	Reflect.apply(start, undefined, [event]);
	Reflect.apply(end, undefined, [event]);
	Reflect.apply(drop, undefined, [event]);
	assert.deepEqual(
		session.snapshot().tabs.map((tab) => tab.id),
		[first.id, second.id, third.id],
	);
	Reflect.apply(start, undefined, [event]);
	Reflect.apply(drop, undefined, [event]);
	assert.deepEqual(
		session.snapshot().tabs.map((tab) => tab.id),
		[second.id, third.id, first.id],
	);
	Reflect.apply(start, undefined, [event]);
	Reflect.apply(drop, undefined, [{ ...event, clientX: 10 }]);
	assert.deepEqual(
		session.snapshot().tabs.map((tab) => tab.id),
		[second.id, first.id, third.id],
	);
});

test("close during autosave keeps the dialog closed and stale authority cannot initiate a follow-on write", async () => {
	const pending = Promise.withResolvers<typeof text>();
	vi.mocked(port.files.saveText).mockImplementationOnce(() => pending.promise);
	const tab = await open("pending-autosave.txt");
	tab.editor.edit("submitted");
	const saving = tab.editor.save();
	drive().tabs?.props.close([tab.id]);
	assert.equal(drive().dialog.props.open, false);
	tab.editor.edit("newer draft");
	port = { files: { ...port.files } };
	drive();
	pending.resolve({ ...text, text: "submitted", revision: "b".repeat(64) });
	await saving;
	await flush();
	assert.equal(drive().dialog.props.open, false);
	assert.equal(vi.mocked(port.files.saveText).mock.calls.length, 1);
	assert.equal(tab.editor.snapshot().document?.text, "newer draft");
	assert.equal(session.snapshot().tabs[0]?.id, tab.id);
});

test("close cancels its continuation when the same root loses write authority during a save", async () => {
	const pending = Promise.withResolvers<typeof text>();
	vi.mocked(port.files.saveText).mockImplementationOnce(() => pending.promise);
	const tab = await open("authority-change.txt");
	tab.editor.edit("submitted");
	drive().tabs?.props.close([tab.id]);
	tab.editor.edit("later");
	try {
		root.writable = false;
		drive();
		pending.resolve({ ...text, text: "submitted", revision: "b".repeat(64) });
		await flush();
		await flush();
		assert.equal(vi.mocked(port.files.saveText).mock.calls.length, 1);
		assert.equal(drive().dialog.props.open, false);
		assert.equal(session.snapshot().tabs[0]?.id, tab.id);
		assert.equal(tab.editor.snapshot().document?.text, "later");
	} finally {
		root.writable = true;
	}
});

test("empty tab strip keeps a reachable reopen action, reopens through current authority and hands focus to exact buffer", async () => {
	const tab = await open("closed.txt");
	const before = drive();
	assert.ok(before.tabs);
	before.tabs.props.close([tab.id]);
	await flush();
	const empty = drive();
	assert.ok(empty.tabs);
	assert.equal(empty.tabs.props.tabs.length, 0);
	assert.equal(empty.tabs.props.canReopen, true);
	empty.tabs.props.reopen?.();
	await flush();
	await flush();
	const restored = drive();
	assert.ok(restored.buffer);
	assert.notEqual(restored.buffer.props.tab.id, tab.id);
	assert.equal(restored.buffer.props.focusRequest, session.snapshot().focusSequence);
	restored.buffer.props.onFocusHandled?.(restored.buffer.props.focusRequest as number);
	assert.equal(session.snapshot().focusId, undefined);
	assert.equal(vi.mocked(port.files.listRoots).mock.calls.length, 1);
});

test("hidden successful reopen defers editor focus until visible and stale focus acknowledgment cannot consume newer request", async () => {
	const tab = await open("hidden.txt");
	await session.close([tab.id]);
	visible = false;
	drive();
	const result = await session.reopen("w");
	assert.ok(result);
	assert.equal(drive().buffer?.props.focusRequest, undefined);
	visible = true;
	const shown = drive();
	assert.equal(shown.buffer?.props.focusRequest, result.request);
	session.consumeFocus(result.id, result.request - 1);
	assert.equal(session.snapshot().focusId, result.id);
	shown.buffer?.props.onFocusHandled?.(result.request);
	assert.equal(session.snapshot().focusId, undefined);
});

test("hidden preview reopen retains its pending and successful handle until panel reveal", async () => {
	const pending = Promise.withResolvers<PreviewHandle>();
	let deferred = false;
	const released: string[] = [];
	const previews: PreviewClient = {
		open: () =>
			deferred
				? pending.promise
				: Promise.resolve({
						id: "first",
						revision: "a".repeat(64),
						kind: "docx",
						summary: { bytes: 4, pages: 1, truncated: false },
					}),
		readPage: async (id, page) => ({
			id,
			revision: "a".repeat(64),
			page,
			content: { kind: "document", format: "docx", text: "page", truncated: false, limitations: [] },
		}),
		readBytes: async () => {
			throw Error("unexpected");
		},
		close: async (id) => {
			released.push(id);
		},
	};
	session.dispose();
	session = new FileWorkspaceSession(port.files, previews);
	session.setWorkspace("w");
	await session.openPreview({ workspaceId: "w", rootId: "r", path: "doc.docx" }, true);
	const tab = session.snapshot().tabs[0];
	assert.ok(tab);
	await session.close([tab.id]);
	visible = false;
	drive();
	deferred = true;
	const reopening = session.reopen("w");
	drive();
	const restored = session.snapshot().tabs[0];
	assert.ok(restored?.kind === "preview");
	assert.equal(restored.preview.snapshot().loading, true);
	pending.resolve({
		id: "restored",
		revision: "a".repeat(64),
		kind: "docx",
		summary: { bytes: 4, pages: 1, truncated: false },
	});
	assert.ok(await reopening);
	drive();
	assert.equal(restored.preview.snapshot().handle?.id, "restored");
	assert.deepEqual(released, ["first"]);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", () => {});
	visible = true;
	drive();
	assert.equal(restored.preview.snapshot().handle?.id, "restored");
});

test("inactive tab context menu exposes the shared reopen command and blocks it while closing", async () => {
	const tab = await open("menu.txt");
	const reopen = vi.fn();
	const render = (closing: boolean) =>
		FileTabContextMenu({ id: tab.id, session, close: () => {}, closing, reopen, canReopen: true, children: null });
	const item = elements(render(false), ContextMenu.Item).find((node) => node.props.children === "Reopen closed file");
	assert.ok(item?.props.onSelect);
	assert.equal(item.props.disabled, false);
	Reflect.apply(item.props.onSelect, undefined, [{}]);
	assert.equal(reopen.mock.calls.length, 1);
	const disabled = elements(render(true), ContextMenu.Item).find(
		(node) => node.props.children === "Reopen closed file",
	);
	assert.equal(disabled?.props.disabled, true);
});
