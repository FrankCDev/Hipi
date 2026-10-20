import assert from "node:assert/strict";
import {
	type AgentContext,
	type AppClient,
	type Conversation,
	type ConversationSearchHit,
	type Method,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type SearchHistoryWindow,
	type Submit,
	type Workspace,
} from "@hipi/work-runtime/contracts";
import type { FileText, ProjectFolder } from "@hipi/work-runtime/files";
import { createFileClient, type FileRequest, fileRequestTarget } from "@hipi/work-runtime/files/protocol";
import type * as Query from "@tanstack/react-query";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { FileAuthority } from "../src/app/file-client.ts";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS } from "../src/app/keybindings.ts";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { FileWorkspaceSession } from "../src/features/files/file-workspace-session.ts";
import { SettingsDialog } from "../src/features/settings/index.ts";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import { type CatalogCommand, saveCommand } from "../src/features/workbench/command-recovery.ts";
import { ConnectionActions } from "../src/features/workbench/connection-actions.tsx";
import { ConversationPane } from "../src/features/workbench/conversation-pane.tsx";
import { ConversationSearch } from "../src/features/workbench/conversation-search.tsx";
import { CreateDialog } from "../src/features/workbench/create-dialog.tsx";
import { FilePanel } from "../src/features/workbench/file-panel.tsx";
import { admitInitialSend } from "../src/features/workbench/initial-send.ts";
import type { BrowserStorage } from "../src/features/workbench/local-persistence.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { PreparedTaskEntry } from "../src/features/workbench/prepared-task-entry.tsx";
import { PreparedTaskRecovery } from "../src/features/workbench/prepared-task-recovery.tsx";
import { ProjectFolderDialog } from "../src/features/workbench/project-folder.tsx";
import { Workbench } from "../src/features/workbench/workbench.tsx";
import { WorkbenchWelcome } from "../src/features/workbench/workbench-welcome.tsx";
import { WorkspaceTree } from "../src/features/workbench/workspace-tree.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
const measurement = vi.hoisted(() => ({ width: 1000 }));
// Bounded hook adapter: invoke Workbench's production JSX callbacks and commit its
// owner effects, without mounting descendants. DOM input/focus, portals, React
// reconciliation and execution streams require separate integration/native coverage.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	function cell() {
		const index = hooks.cursor++;
		return { index, previous: hooks.cells[index] };
	}
	const changed = (previous: React.DependencyList | undefined, next: React.DependencyList) =>
		!previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
	return {
		...actual,
		useState: <T,>(initial?: T | (() => T)) => {
			const { index, previous } = cell();
			const current = previous ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = current;
			return [
				current.value,
				(next: T | ((value: T) => T)) => {
					const value = typeof next === "function" ? (next as (value: T) => T)(current.value as T) : next;
					if (!Object.is(value, current.value)) hooks.changed = true;
					current.value = value;
				},
			];
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const { index, previous } = cell();
			if (!previous || changed(previous.deps, deps)) hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useCallback: <T,>(callback: T, deps: React.DependencyList) => {
			const { index, previous } = cell();
			if (!previous || changed(previous.deps, deps)) hooks.cells[index] = { value: callback, deps };
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
		useLayoutEffect: () => {},
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
vi.mock("@tanstack/react-query", async () => ({
	...(await vi.importActual<typeof Query>("@tanstack/react-query")),
	useQueryClient: () => cache,
	useQuery: ({ queryKey, enabled = true }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
		const [kind, workspaceId, conversationId] = queryKey;
		const data = !enabled
			? undefined
			: kind === "workspaces"
				? { items: workspaces, nextCursor: null }
				: kind === "workspace"
					? workspaces.find((item) => item.workspaceId === workspaceId)
					: kind === "conversation" &&
							workspaceId === conversation.workspaceId &&
							conversationId === conversation.conversationId
						? conversation
						: undefined;
		return { data, isSuccess: data !== undefined, isPending: false, isError: false, isFetching: false, error: null };
	},
}));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("../src/features/workbench/file-panel.tsx", async (original) => ({
	...(await original<typeof import("../src/features/workbench/file-panel.tsx")>()),
	useWorkAreaWidth: () => measurement.width,
}));
vi.mock("../src/features/workbench/use-catalog-pages.ts", () => ({
	useCatalogPages: () => ({
		items: workspaces,
		hasData: true,
		hasMore: false,
		canRestart: false,
		isSuccess: true,
		isPending: false,
		isError: false,
		isFetching: false,
	}),
}));
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => client,
	useFiles: () => ({ files: fileFixture.files, fileAuthority }),
	useLocalState: () => local,
}));

class MemoryStorage implements BrowserStorage {
	values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
}
const workspaces: Workspace[] = [
	{ workspaceId: "current", name: "Current project" },
	{ workspaceId: "other", name: "Other project" },
	{ workspaceId: "empty", name: "Empty project" },
];
const conversation: Conversation = {
	workspaceId: "current",
	conversationId: "task",
	title: "Current task",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
const scope = `${conversation.workspaceId}.${conversation.conversationId}`;
const pending: Submit = {
	workspaceId: "current",
	conversationId: "task",
	requestId: "original",
	text: "Original submitted goal",
};
const draft = "Later draft must not replace the pending payload";
const catalogCommand: CatalogCommand = {
	version: PROTOCOL_VERSION,
	method: "renameConversation",
	params: {
		workspaceId: "current",
		conversationId: "task",
		requestId: "rename",
		expectedRevision: 1,
		title: "New title",
	},
};
const cache = {
	setQueryData: vi.fn(),
	invalidateQueries: vi.fn(async (_filters: { queryKey: readonly unknown[] }) => {}),
	fetchQuery: vi.fn(async ({ queryFn }: { queryFn: (context: { signal: AbortSignal }) => Promise<unknown> }) =>
		queryFn({ signal: new AbortController().signal }),
	),
};
const disconnect = vi.fn();
const client: AppClient = {
	call: vi.fn(async () => {
		throw new Error("Disclosure must not issue an application command");
	}),
	observe: vi.fn(async () => {
		throw new Error("Workbench must not create an execution observer");
	}),
};
const content = (text: string, revision = "a"): FileText => ({
	text,
	revision: revision.repeat(64),
	bytes: new TextEncoder().encode(text).length,
	encoding: "utf-8",
});
function createFileFixture() {
	const calls: FileRequest[] = [];
	let mode: "complete" | "saving" | "unknown" | "conflict" = "complete";
	let finish: ((value: FileText) => void) | undefined;
	let saveSignal: AbortSignal | undefined;
	const files = createFileClient({
		storeId: "store",
		request: async (request, signal) => {
			calls.push(request);
			const response = {
				version: 1,
				storeId: "store",
				method: request.method,
				target: fileRequestTarget(request),
			};
			if (request.method === "listRoots")
				return {
					...response,
					ok: true,
					result: [{ workspaceId: request.params.workspaceId, rootId: "root", writable: true }],
				};
			let result: FileText;
			if (request.method === "readText") result = content("Original file");
			else if (request.method === "saveText") {
				saveSignal = signal;
				if (mode === "unknown") throw new Error("Lost save reply");
				if (mode === "conflict") return { ...response, ok: false, error: "VERSION_CONFLICT" };
				result =
					mode === "saving"
						? await new Promise<FileText>((resolve) => {
								finish = resolve;
							})
						: content(request.params.text, "b");
			} else throw new Error(`Unexpected file request: ${request.method}`);
			return { ...response, ok: true, result };
		},
	});
	return {
		files,
		calls,
		setMode: (value: typeof mode) => {
			mode = value;
		},
		saveSignal: () => saveSignal,
		finish: () => {
			assert.ok(finish);
			finish(content("Unsaved file input", "b"));
		},
	};
}
let storage = new MemoryStorage();
let local = new LocalState("store", storage);
let fileFixture = createFileFixture();
let fileAuthority: FileAuthority | undefined;

function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function element<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const found = elements(node, type);
	assert.equal(found.length, 1);
	const only = found[0];
	assert.ok(only);
	return only;
}
function press(button: React.ReactElement<React.ComponentProps<typeof Button>>) {
	assert.ok(button.props.onClick);
	// The selected production handlers do not consume a mouse event.
	Reflect.apply(button.props.onClick, undefined, []);
}
function drive(keybindings?: AppKeybindings) {
	for (let attempt = 0; attempt < 5; attempt++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const content = Workbench({ disconnect, keybindings });
		for (const commit of hooks.commits.splice(0)) commit();
		if (hooks.changed) continue;
		const tree = element(content, WorkspaceTree);
		const file = element(content, FilePanel);
		const leave = element(content, Dialog);
		assert.ok(file.props.session instanceof FileWorkspaceSession);
		assert.ok(tree.props.catalog instanceof CatalogSession);
		return {
			content,
			tree: tree.props,
			file: file.props,
			session: file.props.session,
			get editor() {
				const owner = file.props.session;
				assert.ok(owner);
				const state = owner.snapshot();
				const active = state.tabs.find((tab) => tab.id === state.activeId);
				assert.equal(active?.kind, "editor");
				assert.ok(active?.kind === "editor");
				return active.editor;
			},
			leave,
			pane: elements(content, ConversationPane)[0],
		};
	}
	throw new Error("Workbench did not settle after committed effects");
}
function assertPreserved(current: ReturnType<typeof drive>, initial: ReturnType<typeof drive>) {
	assert.equal(current.tree.selectedWorkspace, "current");
	assert.equal(current.tree.selectedConversation, "task");
	assert.equal(current.pane?.type, ConversationPane);
	assert.equal(current.pane?.key, initial.pane?.key);
	assert.equal(current.pane?.props.conversation, conversation);
	assert.equal(current.file.workspaceId, "current");
	assert.equal(current.session, initial.session);
	assert.equal(current.tree.catalog, initial.tree.catalog);
	assert.equal(current.leave.props.open, false);
	for (const state of [local, new LocalState("store", storage)]) {
		assert.equal(state.read("workspace"), "current");
		assert.equal(state.read("conversation"), "task");
		assert.equal(state.read(`draft.${scope}`), draft);
		assert.deepEqual(state.pending(scope), pending);
		assert.equal(state.hasUnsavedWork(), true);
	}
	assert.deepEqual(current.tree.catalog.getSnapshot().pending, catalogCommand);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
	assert.equal(vi.mocked(client.observe).mock.calls.length, 0);
	assert.equal(cache.setQueryData.mock.calls.length, 0);
	assert.equal(cache.invalidateQueries.mock.calls.length, 0);
}

let windowEvents: EventTarget;
beforeEach(() => {
	measurement.width = 1000;
	hooks.cells = [];
	hooks.commits = [];
	vi.clearAllMocks();
	windowEvents = new EventTarget();
	vi.stubGlobal("window", {
		innerWidth: 390,
		matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
		addEventListener: windowEvents.addEventListener.bind(windowEvents),
		removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
	});
	storage = new MemoryStorage();
	local = new LocalState("store", storage);
	fileFixture = createFileFixture();
	fileAuthority = undefined;
	local.write("workspace", "current");
	local.write("conversation", "task");
	local.write(`draft.${scope}`, draft);
	local.remember(scope, pending);
	saveCommand(local, "catalog", catalogCommand);
});
afterEach(() => {
	for (const entry of hooks.cells) entry?.cleanup?.();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("other/current disclosure preserves the selected task, clean file, drafts and immutable recovery payloads", async () => {
	const initial = drive();
	assert.equal(initial.pane?.key, "current.task");
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
	const snapshot = initial.editor.snapshot();
	const catalogState = initial.tree.catalog.getSnapshot();
	const protectedValues = [...storage.values].filter(([key]) => !key.includes("workspace-expanded."));
	for (const [id, expanded] of [
		["other", true],
		["other", false],
		["current", false],
		["current", true],
	] as const) {
		drive().tree.onToggle(id);
		const current = drive();
		assert.equal(current.tree.isExpanded(id), expanded);
		assert.equal(new LocalState("store", storage).read(`workspace-expanded.${id}`), String(expanded));
		assertPreserved(current, initial);
		assert.equal(current.editor.snapshot(), snapshot);
		assert.equal(current.tree.catalog.getSnapshot(), catalogState);
		assert.deepEqual(
			[...storage.values].filter(([key]) => !key.includes("workspace-expanded.")),
			protectedValues,
		);
	}
	assert.equal(fileFixture.calls.length, 1);
	assert.throws(() => local.remember(scope, { ...pending, text: "Replacement" }), /immutable/);
});

test("shared search opens without filtering navigation or changing draft/file owners, and cancellation restores exact opener", async () => {
	const initial = drive();
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
	initial.editor.edit("Keep this exact file input");
	const snapshot = initial.editor.snapshot();
	const navigation = elements(initial.content, Button).find((button) => button.props.className === "navigation-toggle");
	assert.ok(navigation);
	press(navigation);
	const trigger = elements(initial.content, Button).find(
		(button) => button.props.className === "sidebar-search-trigger",
	);
	assert.ok(trigger?.props.onClick);
	const opener = { isConnected: true, getClientRects: () => [{}], focus: vi.fn() };
	Reflect.apply(trigger.props.onClick, undefined, [{ currentTarget: opener }]);
	const search = element(drive().content, ConversationSearch);
	assert.equal(search.props.open, true);
	assert.equal("search" in drive().tree, false, "Sidebar no longer filters only loaded titles");
	assertPreserved(drive(), initial);
	search.props.onOpenChange(false);
	search.props.onRestoreFocus();
	const closed = drive();
	assert.equal(element(closed.content, ConversationSearch).props.open, false);
	assert.deepEqual(opener.focus.mock.calls, [[{ preventScroll: true }]]);
	assert.equal(
		closed.content.props["data-navigation-open"],
		true,
		"Search cancellation does not close the mobile sidebar",
	);
	assert.equal(closed.editor.snapshot(), snapshot);
	assertPreserved(closed, initial);
});

test.each(["dirty", "saving", "unknown"] as const)(
	"disclosure never prompts, clears or cancels a %s editor",
	async (state) => {
		const initial = drive();
		await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
		initial.editor.edit(state === "unknown" ? "" : "Unsaved file input");
		let saving: Promise<void> | undefined;
		if (state !== "dirty") {
			fileFixture.setMode(state);
			saving = initial.editor.save();
			if (state === "unknown") await saving;
			else await vi.waitFor(() => assert.ok(fileFixture.saveSignal()));
		}
		const snapshot = initial.editor.snapshot();
		assert.equal(initial.editor.protected, true);
		if (state === "saving") assert.equal(snapshot.operation, "save");
		if (state === "unknown") assert.equal(snapshot.unknown, "");
		const requests = fileFixture.calls.length;
		try {
			for (const id of ["other", "other", "current", "current"]) {
				drive().tree.onToggle(id);
				const current = drive();
				assertPreserved(current, initial);
				assert.equal(current.editor.snapshot(), snapshot);
				assert.equal(current.editor.protected, true);
				assert.equal(fileFixture.calls.length, requests);
				if (state === "saving") assert.equal(fileFixture.saveSignal()?.aborted, false);
			}
		} finally {
			if (state === "saving") fileFixture.finish();
			await saving;
		}
	},
);

test("disclosure preserves a version-conflicted buffer and baseline without save, reload or revision adoption", async () => {
	const initial = drive();
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
	initial.editor.edit("Unsaved conflicted input");
	fileFixture.setMode("conflict");
	await initial.editor.save();
	const snapshot = initial.editor.snapshot();
	assert.equal(snapshot.error, "VERSION_CONFLICT");
	const save = vi.spyOn(initial.editor, "save");
	const reload = vi.spyOn(initial.editor, "reload");
	const adopt = vi.spyOn(initial.editor, "adoptComparedRevision");
	for (const id of ["other", "other", "current", "current"]) {
		drive().tree.onToggle(id);
		const current = drive();
		assertPreserved(current, initial);
		assert.equal(current.editor.snapshot(), snapshot);
		assert.equal(current.editor.snapshot().error, "VERSION_CONFLICT");
		assert.equal(current.editor.snapshot().document?.text, "Unsaved conflicted input");
		assert.deepEqual(current.editor.snapshot().document?.baseline, content("Original file"));
		assert.equal(current.editor.protected, true);
		assert.equal(save.mock.calls.length, 0);
		assert.equal(reload.mock.calls.length, 0);
		assert.equal(adopt.mock.calls.length, 0);
		assert.deepEqual(
			fileFixture.calls.map((request) => request.method),
			["readText", "saveText"],
		);
	}
});

test.each(["dirty", "saving", "unknown", "conflict"] as const)(
	"explicit Open project retains every protected %s buffer without a destructive leave prompt",
	async (state) => {
		const initial = drive();
		await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
		const editor = initial.editor;
		editor.edit("Unsaved file input");
		let saving: Promise<void> | undefined;
		if (state !== "dirty") {
			fileFixture.setMode(state);
			saving = editor.save();
			if (state === "saving") await vi.waitFor(() => assert.ok(fileFixture.saveSignal()));
			else await saving;
		}
		const snapshot = editor.snapshot();
		initial.tree.onOpenProject("empty");
		const opened = drive();
		assert.equal(opened.leave.props.open, false);
		assert.equal(opened.tree.selectedWorkspace, "empty");
		assert.equal(opened.tree.selectedConversation, "");
		assert.equal(opened.tree.isExpanded("empty"), true);
		assert.equal(opened.pane, undefined);
		const welcome = element(opened.content, WorkbenchWelcome);
		assert.equal(welcome.props.workspaceName, "Empty project");
		assert.equal(typeof element(welcome.props.action, PreparedTaskEntry).props.onSend, "function");
		const settings = element(opened.content, SettingsDialog);
		assert.deepEqual(settings.props.workspace, { workspaceId: "empty", name: "Empty project" });
		assert.equal(settings.props.conversation, undefined);
		assert.equal(opened.file.workspaceId, "empty");
		assert.equal(opened.session, initial.session);
		assert.equal(editor.snapshot(), snapshot);
		assert.equal(opened.session.protected, true);
		assert.equal(opened.session.snapshot().tabs.length, 1);
		assert.equal(opened.session.snapshot().activeId, undefined);
		assert.equal(local.read("workspace"), "empty");
		assert.equal(local.read("conversation"), "");
		assert.equal(local.read(`draft.${scope}`), draft);
		assert.deepEqual(local.pending(scope), pending);
		if (state === "saving") {
			assert.equal(fileFixture.saveSignal()?.aborted, false);
			fileFixture.finish();
		}
		await saving;
		opened.tree.onSelect(conversation);
		const returned = drive();
		assert.equal(returned.editor, editor);
		assert.equal(returned.editor.snapshot().document?.text, "Unsaved file input");
		assert.equal(returned.leave.props.open, false);
	},
);

test("disclosure from home never selects a project or a task", () => {
	local.write("workspace", "");
	local.write("conversation", "");
	for (const expanded of [true, false]) {
		drive().tree.onToggle("other");
		const current = drive();
		assert.equal(current.tree.isExpanded("other"), expanded);
		assert.equal(current.tree.selectedWorkspace, "");
		assert.equal(current.tree.selectedConversation, "");
		assert.equal(current.pane, undefined);
		assert.equal(current.file.workspaceId, "");
		assert.equal(current.leave.props.open, false);
		assert.equal(element(current.content, WorkbenchWelcome).props.workspaceName, undefined);
		assert.equal(local.read("workspace"), "");
		assert.equal(local.read("conversation"), "");
	}
});

test("narrow navigation stays open while other and current project branches expand or collapse", () => {
	const initial = drive();
	assert.equal(initial.content.props["data-navigation-mode"], "narrow");
	const toggle = elements(initial.content, Button).find((button) => button.props.className === "navigation-toggle");
	assert.ok(toggle);
	assert.equal(toggle.props["aria-expanded"], false);
	press(toggle);
	for (const id of ["other", "other", "current", "current"]) {
		drive().tree.onToggle(id);
		const current = drive();
		assertPreserved(current, initial);
		const navigation = elements(current.content, Button).find(
			(button) => button.props.className === "navigation-toggle",
		);
		assert.equal(navigation?.props["aria-expanded"], true);
		const sidebar = element(current.content, "aside");
		assert.equal(sidebar.props.inert, false);
		const main = elements(current.content, "div").find((node) => node.props.className === "main-shell");
		assert.equal(main?.props.inert, true);
	}
});

test("full-width file presentation retains conversation and protected file owners, restoring the same split", async () => {
	const initial = drive();
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
	initial.editor.edit("Keep the exact full-width editor input");
	const snapshot = initial.editor.snapshot();
	const panel = initial.file.controller;
	panel.setOpen(true);
	const split = panel.snapshot();
	panel.beginResize();
	panel.resizeFromSplitter(950, measurement.width, false);
	panel.finishResize();
	assert.equal(panel.snapshot().fullWidth, true);
	assert.equal(panel.snapshot().width, split.width);
	assert.equal(panel.snapshot().ratio, split.ratio);
	const full = drive();
	const frame = elements(full.content, "div").find((node) => node.props.className === "work-conversation-frame");
	assert.ok(frame);
	assert.equal(frame.props.inert, true);
	assert.equal(frame.props["aria-hidden"], true);
	assert.equal(frame.props.style?.width, 359, "The hidden viewport retains its normal split width, never zero");
	assert.equal(element(frame, ConversationPane).key, initial.pane?.key);
	assertPreserved(full, initial);
	assert.equal(full.editor.snapshot(), snapshot);
	// Responsive modal presentation does not inherit the desktop full-width
	// hiding state. This adapter checks JSX ownership, not mounted DOM geometry.
	measurement.width = 640;
	const overlay = drive();
	const overlayFrame = elements(overlay.content, "div").find(
		(node) => node.props.className === "work-conversation-frame",
	);
	assert.equal(overlayFrame?.props.inert, false);
	assert.equal(overlayFrame?.props["aria-hidden"], undefined);
	assert.equal(overlayFrame?.props.style?.width, undefined);
	assertPreserved(overlay, initial);
	measurement.width = 1000;
	panel.restoreSplit();
	const restored = drive();
	const restoredFrame = elements(restored.content, "div").find(
		(node) => node.props.className === "work-conversation-frame",
	);
	assert.equal(restoredFrame?.props.inert, false);
	assert.equal(restoredFrame?.props.style?.width, undefined);
	assertPreserved(restored, initial);
	assert.equal(restored.editor.snapshot(), snapshot);
	assert.equal(fileFixture.calls.length, 1);
});

test.each([
	[false, false, false],
	[true, false, false],
	[false, true, false],
	[false, true, true],
] as const)(
	"one home Send creates/submits once without replacing later navigation (lost receipt=%s, navigate away=%s, return=%s)",
	async (lostReceipt, navigateAway, returnToOrigin) => {
		saveCommand(local, "catalog", null);
		vi.stubGlobal("navigator", { locks: { request: async (_key: string, action: () => unknown) => action() } });
		const goal = "Prepare a plan";
		const target = { ...conversation, conversationId: "created", title: goal };
		let release: (() => void) | undefined;
		const dispatched = new Promise<void>((resolve) => {
			release = resolve;
		});
		local.write("task-draft.current", goal);
		local.write("conversation", "");
		vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M, input: unknown) => {
			if (method === "getWorkspace") return parseResult(method, workspaces[0]);
			if (method === "getReceipt") return parseResult(method, null);
			if (method === "getConversationModel")
				return parseResult(method, {
					model: { provider: "faux", modelId: "one" },
					credentialState: "configured",
					executionState: "ready",
				});
			if (method === "submit") {
				await dispatched;
				if (lostReceipt) throw new Error("Lost submit reply");
				assert.ok(typeof input === "object" && input && "requestId" in input);
				return parseResult(method, {
					workspaceId: target.workspaceId,
					conversationId: target.conversationId,
					requestId: input.requestId,
					receiptId: "receipt",
					state: "accepted",
				});
			}
			assert.ok(["createConversation", "getConversation", "getConversationCommandResult"].includes(method));
			return parseResult(
				method,
				method === "getConversationCommandResult" ? { method: "createConversation", result: target } : target,
			);
		});
		const initial = drive();
		const entry = element(element(initial.content, WorkbenchWelcome).props.action, PreparedTaskEntry);
		const sending = entry.props.onSend(goal, { provider: "faux", modelId: "one" });
		await vi.waitFor(() => assert.ok(initial.tree.catalog.getSnapshot().submission));
		const during = drive();
		assert.equal(during.tree.catalog.getSnapshot().busy, true);
		assert.equal(during.tree.selectedConversation, "", "No second recovery owner mounts during the live chain");
		assert.equal(during.pane, undefined);
		assert.equal(
			element(element(during.content, WorkbenchWelcome).props.action, PreparedTaskEntry).props.disabled,
			true,
		);
		assert.equal(PreparedTaskRecovery({ session: during.tree.catalog, onResolve: async () => {} }), null);
		if (navigateAway) {
			during.tree.onOpenProject("other");
			await during.session.open({ workspaceId: "other", rootId: "root", path: "later.txt" }, true);
			during.editor.edit("Keep this later editor buffer");
			if (returnToOrigin) drive().tree.onOpenProject("current");
		}
		assert.ok(release);
		release();
		await sending;
		const current = drive();
		assert.equal(current.tree.selectedConversation, navigateAway ? "" : "created");
		assert.equal(current.tree.selectedWorkspace, navigateAway && !returnToOrigin ? "other" : "current");
		if (navigateAway) {
			const retained = current.session.snapshot().tabs.find((tab) => tab.target.workspaceId === "other");
			assert.ok(retained?.kind === "editor");
			assert.equal(retained.editor.snapshot().document?.text, "Keep this later editor buffer");
			assert.equal(current.session.protected, true);
			assert.equal(current.leave.props.open, false);
		}
		assert.equal(current.tree.catalog.getSnapshot().busy, false);
		assert.equal(local.read("task-draft.current"), "");
		assert.equal(vi.mocked(client.call).mock.calls.filter(([method]) => method === "createConversation").length, 1);
		assert.equal(vi.mocked(client.call).mock.calls.filter(([method]) => method === "submit").length, 1);
		assert.equal(local.pending("current.created")?.text, goal);
		assert.equal(local.isConfirmed(current.tree.catalog.getSnapshot().submission?.requestId ?? ""), !lostReceipt);
		assert.equal(PreparedTaskRecovery({ session: current.tree.catalog, onResolve: async () => {} }), null);
		assert.equal(local.read(`draft.${scope}`), draft);
	},
);

test("New chat opens the scoped composer without creating objects or discarding same-project file work", async () => {
	local.write("conversation", "");
	const home = () => element(element(drive().content, WorkbenchWelcome).props.action, PreparedTaskEntry).props;
	home().onDraftChange("Written at project home");
	const initial = drive();
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
	initial.editor.edit("Unsaved file input");
	const snapshot = initial.editor.snapshot();
	initial.tree.onNewConversation("current");
	assert.equal(drive().leave.props.open, false);
	assert.equal(drive().editor.snapshot(), snapshot);
	assert.equal(home().draft, "Written at project home");
	drive().tree.onNewConversation("other");
	home().onDraftChange("Other project's goal");
	assert.equal(home().draft, "Other project's goal");
	drive().tree.onNewConversation("current");
	assert.equal(home().draft, "Written at project home");
	for (const state of [local, new LocalState("store", storage)]) {
		assert.equal(state.read("task-draft.current"), "Written at project home");
		assert.equal(state.read("task-draft.other"), "Other project's goal");
	}
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
});

test.each([false, true])(
	"prepared project consent stays with its owner until confirmed submission, including unknown grant=%s",
	async (unknownGrant) => {
		saveCommand(local, "catalog", null);
		vi.stubGlobal("navigator", { locks: { request: async (_key: string, action: () => unknown) => action() } });
		const goal = "Inspect the selected project";
		const model = { provider: "faux", modelId: "one" };
		const target = { ...conversation, conversationId: "consented", title: goal };
		const folder: ProjectFolder = {
			workspaceId: "current",
			bindingId: "bound-project",
			revision: 1,
			displayName: "Project source",
			status: "available",
			root: { workspaceId: "current", rootId: "project-root", writable: false, displayName: "Project source" },
		};
		fileAuthority = {
			chooseRoot: async () => {},
			revokeRoot: async () => {},
			getProject: async () => folder,
		};
		local.write("task-draft.current", goal);
		local.write("conversation", "");
		const waiting = Promise.withResolvers<void>();
		let grant: AgentContext | undefined;
		vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M, params: unknown) => {
			const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
			if (request.method === "getWorkspace") return parseResult(method, workspaces[0]);
			if (request.method === "getConversationModel")
				return parseResult(method, { model, credentialState: "configured", executionState: "ready" });
			if (request.method === "getConversationCommandResult")
				return parseResult(method, { method: "createConversation", result: target });
			if (request.method === "createConversation" || request.method === "getConversation")
				return parseResult(method, target);
			if (request.method === "authorizeAgentContext") {
				await waiting.promise;
				if (unknownGrant) throw new Error("Unknown grant outcome");
				grant = { ...request.params, grantId: "grant", revision: 1, purpose: "live-files", status: "active" };
				return parseResult(method, grant);
			}
			if (request.method === "getAgentCommandResult")
				return parseResult(method, grant ? { method: "authorizeAgentContext", result: grant } : null);
			if (request.method === "listActiveAgentContexts") return parseResult(method, grant ? [grant] : []);
			if (request.method === "submit")
				return parseResult(method, {
					workspaceId: request.params.workspaceId,
					conversationId: request.params.conversationId,
					requestId: request.params.requestId,
					receiptId: "receipt",
					state: "accepted",
				});
			throw new Error(`Unexpected ${method}`);
		});
		const initial = drive();
		const entry = element(element(initial.content, WorkbenchWelcome).props.action, PreparedTaskEntry);
		assert.equal(entry.props.workspaceId, "current");
		const sending = entry.props
			.onSend(goal, model, {
				workspaceId: "current",
				bindingId: "bound-project",
				bindingRevision: 1,
				rootId: "project-root",
				model,
				pathPrefixes: ["src"],
				expiresAt: Date.now() + 60000,
				disclosureVersion: 1,
			})
			.then(
				() => null,
				(error: unknown) => error,
			);
		await vi.waitFor(() =>
			assert.ok(vi.mocked(client.call).mock.calls.some(([method]) => method === "authorizeAgentContext")),
		);
		const during = drive();
		assert.equal(during.tree.selectedConversation, "");
		assert.equal(during.pane, undefined);
		assert.equal(local.pending("current.consented"), null);
		assert.equal(vi.mocked(client.call).mock.calls.filter(([method]) => method === "submit").length, 0);
		assert.equal(
			element(element(during.content, WorkbenchWelcome).props.action, PreparedTaskEntry).props.disabled,
			true,
		);
		waiting.resolve();
		const error = await sending;
		assert.equal(error instanceof Error, unknownGrant);
		const after = drive();
		assert.equal(after.tree.selectedConversation, unknownGrant ? "" : "consented");
		assert.equal(vi.mocked(client.call).mock.calls.filter(([method]) => method === "createConversation").length, 1);
		assert.equal(
			vi.mocked(client.call).mock.calls.filter(([method]) => method === "submit").length,
			unknownGrant ? 0 : 1,
		);
		assert.equal(Boolean(after.tree.catalog.getSnapshot().initialSend), unknownGrant);
		assert.equal(local.pending("current.consented")?.text, unknownGrant ? undefined : goal);
		assert.equal(local.read("task-draft.current"), unknownGrant ? goal : "");
	},
);

test("explicit conflict combine refreshes the project composer with both exact texts and never sends", async () => {
	saveCommand(local, "catalog", null);
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, action: () => unknown) => action() } });
	const original = "  Original unsent project question\n";
	const later = "\nNewer project draft  ";
	const model = { provider: "faux", modelId: "one" };
	local.write("task-draft.current", original);
	local.write("conversation", "");
	fileAuthority = {
		chooseRoot: async () => {},
		revokeRoot: async () => {},
		getProject: async () => ({
			workspaceId: "current",
			bindingId: "bound-project",
			revision: 2,
			displayName: "Project source",
			status: "available",
			root: { workspaceId: "current", rootId: "project-root", writable: false, displayName: "Project source" },
		}),
	};
	vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M) => {
		assert.equal(method, "getWorkspace");
		return parseResult(method, workspaces[0]);
	});
	const initial = drive();
	const home = () => element(element(drive().content, WorkbenchWelcome).props.action, PreparedTaskEntry).props;
	await assert.rejects(
		home().onSend(original, model, {
			workspaceId: "current",
			bindingId: "bound-project",
			bindingRevision: 1,
			rootId: "project-root",
			model,
			pathPrefixes: [""],
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		}),
		/UNCONFIRMED/,
	);
	assert.equal(initial.tree.catalog.getSnapshot().initialSend?.context?.createAttempted, false);
	home().onDraftChange(later);
	const recovery = () => {
		const props = element(drive().content, PreparedTaskRecovery).props;
		return PreparedTaskRecovery(props);
	};
	const keep = elements(recovery(), Button).find(
		(button) => button.props.children === "Keep message and review permissions",
	);
	assert.ok(keep);
	press(keep);
	await vi.waitFor(() => assert.equal(initial.tree.catalog.getSnapshot().handoffConflict, true));
	const conflict = recovery();
	assert.ok(
		elements(conflict, "p").some(
			(item) => typeof item.props.children === "string" && item.props.children.includes("that draft first"),
		),
	);
	const combine = elements(conflict, Button).find(
		(button) => button.props.children === "Combine both texts into a draft",
	);
	assert.ok(combine);
	assert.equal(
		elements(conflict, Button).some((button) => button.props.children === "Keep the existing conversation draft"),
		false,
	);
	press(combine);
	await vi.waitFor(() => assert.equal(initial.tree.catalog.getSnapshot().initialSend, null));
	assert.equal(home().draft, `${later}\n\n---\n\n${original}`);
	assert.equal(local.read("task-draft.current"), home().draft);
	assert.equal(drive().tree.selectedConversation, "");
	assert.deepEqual(
		vi.mocked(client.call).mock.calls.map(([method]) => method),
		["getWorkspace"],
	);
	assert.equal(local.pending("current.consented"), null);
});

test("combining into the already selected created chat signals only its draft, without remounting the pane", async () => {
	storage = new MemoryStorage();
	local = new LocalState("store", storage);
	local.write("workspace", "current");
	local.write("conversation", "");
	vi.stubGlobal("navigator", { locks: { request: async (_key: string, action: () => unknown) => action() } });
	const original = conversation.title;
	const model = { provider: "faux", modelId: "one" };
	local.write("task-draft.current", original);
	let reads = 0;
	fileAuthority = {
		chooseRoot: async () => {},
		revokeRoot: async () => {},
		getProject: async () => ({
			workspaceId: "current",
			bindingId: "bound-project",
			revision: ++reads === 1 ? 1 : 2,
			displayName: "Project source",
			status: "available",
			root: { workspaceId: "current", rootId: "project-root", writable: false, displayName: "Project source" },
		}),
	};
	vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M) => {
		if (method === "getWorkspace") return parseResult(method, workspaces[0]);
		if (method === "getConversationCommandResult")
			return parseResult(method, { method: "createConversation", result: conversation });
		assert.ok(method === "createConversation" || method === "getConversation");
		return parseResult(method, conversation);
	});
	const initial = drive();
	const home = element(element(initial.content, WorkbenchWelcome).props.action, PreparedTaskEntry);
	await assert.rejects(
		home.props.onSend(original, model, {
			workspaceId: "current",
			bindingId: "bound-project",
			bindingRevision: 1,
			rootId: "project-root",
			model,
			pathPrefixes: [""],
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		}),
		/UNCONFIRMED/,
	);
	initial.tree.onSelect(conversation);
	const selected = drive();
	assert.ok(selected.pane);
	local.write(`draft.${scope}`, "Newer selected chat draft");
	await initial.tree.catalog.recoverInitialDraft();
	assert.equal(initial.tree.catalog.getSnapshot().handoffConflict, true);
	const recovery = element(drive().content, PreparedTaskRecovery);
	const combine = elements(PreparedTaskRecovery(recovery.props), Button).find(
		(button) => button.props.children === "Combine both texts into a draft",
	);
	assert.ok(combine);
	press(combine);
	await vi.waitFor(() => assert.equal(initial.tree.catalog.getSnapshot().initialSend, null));
	const result = drive();
	assert.equal(result.pane?.key, selected.pane.key);
	assert.equal(result.pane?.props.conversation, selected.pane.props.conversation);
	assert.equal(result.pane?.props.draftRecoveryRevision, local.valueSnapshot(`draft.${scope}`)?.revision);
	assert.ok(result.pane?.props.draftRecoveryRevision);
	assert.equal(local.read(`draft.${scope}`), `Newer selected chat draft\n\n---\n\n${original}`);
	assert.equal(
		vi.mocked(client.call).mock.calls.filter(([method]) => ["submit", "authorizeAgentContext"].includes(method)).length,
		0,
	);
	assert.equal(vi.mocked(client.call).mock.calls.filter(([method]) => method === "createConversation").length, 1);
});

test.each([
	["check", "stay"],
	["check", "away"],
	["check", "away-back"],
	["retry", "stay"],
	["retry", "away"],
	["retry", "away-back"],
] as const)(
	"initial Send recovery %s respects later %s navigation without changing request ownership",
	async (action, navigation) => {
		saveCommand(local, "catalog", null);
		vi.stubGlobal("navigator", { locks: { request: async (_key: string, operation: () => unknown) => operation() } });
		const goal = "Recover the original goal";
		const target = { ...conversation, conversationId: "recovered", title: goal };
		local.write("task-draft.current", goal);
		local.write("conversation", "");
		await admitInitialSend(
			local,
			{
				workspaceId: "current",
				text: goal,
				title: goal,
				model: { provider: "faux", modelId: "one" },
				sourceKey: "task-draft.current",
			},
			new AbortController().signal,
		);
		let notFound = action === "retry";
		let waiting = false;
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M, input: unknown) => {
			if (method === "getConversationCommandResult") {
				if (notFound) return parseResult(method, null);
				if (action === "check" && !waiting) {
					waiting = true;
					await blocked;
				}
				return parseResult(method, { method: "createConversation", result: target });
			}
			if (method === "createConversation") {
				waiting = true;
				await blocked;
				return parseResult(method, target);
			}
			if (method === "getWorkspace") return parseResult(method, workspaces[0]);
			if (method === "getConversation") return parseResult(method, target);
			if (method === "getConversationModel")
				return parseResult(method, {
					model: { provider: "faux", modelId: "one" },
					credentialState: "configured",
					executionState: "ready",
				});
			if (method === "submit") {
				assert.ok(input && typeof input === "object" && "requestId" in input);
				return parseResult(method, {
					workspaceId: "current",
					conversationId: "recovered",
					requestId: input.requestId,
					receiptId: "receipt",
					state: "accepted",
				});
			}
			throw new Error(`Unexpected recovery command ${method}`);
		});
		const initial = drive();
		if (notFound) {
			await initial.tree.catalog.check();
			assert.equal(initial.tree.catalog.getSnapshot().notFound, true);
			notFound = false;
		}
		const recovery = element(drive().content, PreparedTaskRecovery);
		const buttons = elements(PreparedTaskRecovery(recovery.props), Button);
		const button = buttons[action === "check" ? 0 : 1];
		assert.ok(button);
		press(button);
		await vi.waitFor(() => assert.equal(waiting, true));
		if (navigation !== "stay") {
			drive().tree.onOpenProject("other");
			await initial.session.open({ workspaceId: "other", rootId: "root", path: "later.txt" }, true);
			drive().editor.edit("Later recovery-time edit");
			if (navigation === "away-back") drive().tree.onOpenProject("current");
		}
		assert.ok(release);
		release();
		await vi.waitFor(() => assert.equal(initial.tree.catalog.getSnapshot().busy, false));
		await Promise.resolve();
		const resolved = drive();
		assert.equal(resolved.tree.selectedWorkspace, navigation === "away" ? "other" : "current");
		assert.equal(resolved.tree.selectedConversation, navigation === "stay" ? "recovered" : "");
		assert.equal(local.pending("current.recovered")?.text, goal);
		assert.equal(
			vi.mocked(client.call).mock.calls.filter(([method]) => method === "submit").length,
			action === "retry" ? 1 : 0,
		);
		if (navigation !== "stay") {
			const tab = resolved.session.snapshot().tabs.find((item) => item.target.path === "later.txt");
			assert.ok(tab?.kind === "editor");
			assert.equal(tab.editor.snapshot().document?.text, "Later recovery-time edit");
		}
	},
);

function prepareDisconnect() {
	const settings = element(drive().content, SettingsDialog);
	const actions = element(settings.props.runtimeActions, ConnectionActions);
	assert.ok(actions.props.prepareDisconnect);
	return actions.props.prepareDisconnect();
}
test("one disconnect confirmation captures protected owners; cancel leaves all work and dispatch untouched", async () => {
	const initial = drive();
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "first.txt" }, true);
	initial.editor.edit("Keep this draft");
	const before = initial.editor.snapshot();
	const confirmation = prepareDisconnect();
	assert.ok(confirmation.warning);
	assert.equal(initial.editor.snapshot(), before);
	assert.equal(initial.session.protected, true);
	assert.equal(disconnect.mock.calls.length, 0);
});
test("new edits and newly protected tabs require a refreshed disconnect confirmation, never a second generic guard", async () => {
	const initial = drive();
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "first.txt" }, true, { pinned: true });
	initial.editor.edit("First draft");
	const original = prepareDisconnect();
	initial.editor.edit("A later draft");
	assert.equal(original.commit(), false);
	assert.equal(disconnect.mock.calls.length, 0);
	const refreshed = prepareDisconnect();
	await initial.session.open({ workspaceId: "other", rootId: "root", path: "second.txt" }, true, { pinned: true });
	initial.editor.edit("Another protected tab");
	assert.equal(refreshed.commit(), false);
	assert.equal(disconnect.mock.calls.length, 0);
	const final = prepareDisconnect();
	assert.equal(final.commit(), true);
	assert.equal(final.commit(), true);
	assert.equal(disconnect.mock.calls.length, 1);
	assert.equal(drive().leave.props.open, false);
});
test("save-to-unknown transition and retired connection cannot silently reuse an earlier disconnect confirmation", async () => {
	const initial = drive();
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
	initial.editor.edit("Pending write");
	const beforeSave = prepareDisconnect();
	fileFixture.setMode("unknown");
	await initial.editor.save();
	assert.equal(beforeSave.commit(), false);
	assert.equal(disconnect.mock.calls.length, 0);
	const beforeRetirement = prepareDisconnect();
	for (const cell of hooks.cells) cell?.cleanup?.();
	assert.equal(beforeRetirement.commit(), false);
	assert.equal(disconnect.mock.calls.length, 0);
});

test.each([false, true])(
	"project creation retains the same project on lost binding response without stealing later navigation=%s",
	async (navigateAway) => {
		saveCommand(local, "catalog", null);
		const binding = Promise.withResolvers<never>();
		let created: Workspace | undefined;
		vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M, input: unknown) => {
			assert.equal(method, "createWorkspace");
			assert.ok(input && typeof input === "object" && "workspaceId" in input && "name" in input);
			created = { workspaceId: String(input.workspaceId), name: String(input.name) };
			return parseResult(method, created);
		});
		const attach = vi.fn(() => binding.promise);
		fileAuthority = {
			chooseRoot: async () => {},
			revokeRoot: async () => {},
			attachProject: attach,
		};
		const initial = drive();
		const creating = element(initial.content, CreateDialog).props.onCreate("Created project", {
			selectionId: "opaque-selection",
			displayName: "Chosen folder",
		});
		await vi.waitFor(() => assert.equal(attach.mock.calls.length, 1));
		assert.ok(created);
		assert.equal(drive().tree.selectedWorkspace, created.workspaceId);
		if (navigateAway) drive().tree.onOpenProject("other");
		binding.reject(new Error("Binding response lost"));
		await creating;
		const current = drive();
		assert.equal(vi.mocked(client.call).mock.calls.filter(([method]) => method === "createWorkspace").length, 1);
		assert.deepEqual(attach.mock.calls, [[created.workspaceId, "opaque-selection"]]);
		assert.equal(current.tree.selectedWorkspace, navigateAway ? "other" : created.workspaceId);
		const manager = elements(current.content, ProjectFolderDialog)[0];
		if (navigateAway) {
			assert.equal(manager, undefined, "late failure must not open a modal over newer work");
			current.tree.onManageProjectFolder?.(created);
			assert.equal(elements(drive().content, ProjectFolderDialog)[0]?.props.initialFailure, true);
		} else {
			assert.equal(manager?.props.workspaceId, created.workspaceId);
			assert.equal(manager?.props.initialFailure, true);
		}
	},
);

test.each(["empty", "BUSY"] as const)(
	"confirmed delayed project attachment refreshes only its %s root lists",
	async (initialState) => {
		saveCommand(local, "catalog", null);
		const binding = Promise.withResolvers<ProjectFolder>();
		let created: Workspace | undefined;
		vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M, input: unknown) => {
			assert.equal(method, "createWorkspace");
			assert.ok(input && typeof input === "object" && "workspaceId" in input && "name" in input);
			created = { workspaceId: String(input.workspaceId), name: String(input.name) };
			return parseResult(method, created);
		});
		const attach = vi.fn(() => binding.promise);
		fileAuthority = { chooseRoot: async () => {}, revokeRoot: async () => {}, attachProject: attach };
		const initial = drive();
		const creating = element(initial.content, CreateDialog).props.onCreate("Created project", {
			selectionId: "opaque-selection",
			displayName: "Chosen folder",
		});
		await vi.waitFor(() => assert.equal(attach.mock.calls.length, 1));
		assert.ok(created);
		const workspaceId = created.workspaceId;
		assert.equal(drive().tree.selectedWorkspace, workspaceId);
		// These two active queries may have observed unbound [] or BUSY while attachment was exclusive.
		const rootRefreshes = () =>
			cache.invalidateQueries.mock.calls
				.map(([options]) => options)
				.filter(({ queryKey }) => ["fileRoots", "agent-context-roots"].includes(String(queryKey[0])));
		assert.deepEqual(rootRefreshes(), []);
		const result: ProjectFolder = {
			workspaceId,
			bindingId: "bound-project",
			revision: 1,
			displayName: "Chosen folder",
			status: "available",
			root: { workspaceId, rootId: "new-project-root", writable: false },
		};
		const queryCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryCache.setQueryData(["fileRoots", "other"], []);
		queryCache.setQueryData(["agent-context-roots", "other"], []);
		cache.invalidateQueries.mockImplementation((filters) => queryCache.invalidateQueries(filters));
		let ready = false;
		const observers = ["fileRoots", "agent-context-roots"].map(
			(kind) =>
				new QueryObserver(queryCache, {
					queryKey: [kind, workspaceId],
					queryFn: async () => {
						if (!ready && initialState === "BUSY") throw new Error("BUSY");
						return ready ? [result.root] : [];
					},
				}),
		);
		const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
		try {
			await vi.waitFor(() => {
				for (const observer of observers) {
					assert.equal(observer.getCurrentResult().status, initialState === "BUSY" ? "error" : "success");
					assert.deepEqual(observer.getCurrentResult().data, initialState === "BUSY" ? undefined : []);
				}
			});
			ready = true;
			binding.resolve(result);
			await creating;
			assert.deepEqual(rootRefreshes(), [
				{ queryKey: ["fileRoots", workspaceId] },
				{ queryKey: ["agent-context-roots", workspaceId] },
			]);
			for (const observer of observers) {
				assert.equal(observer.getCurrentResult().status, "success");
				assert.deepEqual(observer.getCurrentResult().data, [result.root]);
			}
			assert.equal(queryCache.getQueryState(["fileRoots", "other"])?.isInvalidated, false);
			assert.equal(queryCache.getQueryState(["agent-context-roots", "other"])?.isInvalidated, false);
			assert.ok(
				cache.setQueryData.mock.calls.some(
					([key, value]) => JSON.stringify(key) === JSON.stringify(["projectFolder", workspaceId]) && value === result,
				),
			);
			assert.equal(attach.mock.calls.length, 1);
		} finally {
			for (const close of unsubscribe) close();
			queryCache.clear();
			cache.invalidateQueries.mockImplementation(async () => {});
		}
	},
);

function appKey(overrides: Partial<KeyboardEvent> = {}) {
	const event = new Event("keydown", { cancelable: true });
	Object.assign(event, {
		key: "t",
		ctrlKey: true,
		metaKey: false,
		shiftKey: true,
		altKey: false,
		isComposing: false,
		keyCode: 84,
		repeat: false,
		...overrides,
	});
	windowEvents.dispatchEvent(event);
	return event;
}

test("global Reopen works with the IDE hidden and no tabs, preserves the task and reveals only an authorized result", async () => {
	vi.stubGlobal("navigator", { platform: "Linux" });
	vi.stubGlobal("document", { querySelector: () => null });
	const initial = drive();
	initial.file.controller.setOpen(false);
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "closed.txt" }, true);
	const id = initial.session.snapshot().activeId;
	assert.ok(id);
	assert.deepEqual(await initial.session.close([id]), []);
	assert.equal(initial.session.snapshot().tabs.length, 0);
	const event = appKey();
	assert.equal(event.defaultPrevented, true);
	await vi.waitFor(() => assert.equal(initial.file.controller.snapshot().open, true));
	const current = drive();
	assert.equal(current.tree.selectedConversation, "task");
	assert.equal(current.pane?.key, initial.pane?.key);
	assert.equal(local.read(`draft.${scope}`), draft);
	assert.ok(current.session.snapshot().focusId);
	assert.equal(current.editor.snapshot().document?.text, "Original file");
	assert.deepEqual(
		fileFixture.calls.map((request) => request.method),
		["readText", "listRoots", "readText"],
	);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
});

test.each(["ime", "229", "repeat", "overlay", "settings"] as const)(
	"global Reopen ignores %s ownership without reading or opening a file",
	async (kind) => {
		vi.stubGlobal("navigator", { platform: "Linux" });
		vi.stubGlobal("document", { querySelector: () => (kind === "overlay" ? {} : null) });
		const initial = drive();
		await initial.session.open({ workspaceId: "current", rootId: "root", path: "closed.txt" }, true);
		const id = initial.session.snapshot().activeId;
		assert.ok(id);
		await initial.session.close([id]);
		if (kind === "settings") {
			element(initial.content, SettingsDialog).props.onOpenChange(true);
			drive();
		}
		const event = appKey({
			isComposing: kind === "ime",
			keyCode: kind === "229" ? 229 : 84,
			repeat: kind === "repeat",
		});
		assert.equal(event.defaultPrevented, false);
		assert.equal(initial.session.snapshot().tabs.length, 0);
		assert.equal(fileFixture.calls.length, 1);
	},
);

test.each(["away", "away-back", "retired"] as const)(
	"late global Reopen cannot reveal or focus after %s navigation",
	async (kind) => {
		vi.stubGlobal("navigator", { platform: "Linux" });
		vi.stubGlobal("document", { querySelector: () => null });
		const initial = drive();
		initial.file.controller.setOpen(false);
		vi.spyOn(initial.session, "canReopen").mockReturnValue(true);
		const pending = Promise.withResolvers<{ id: string; request: number }>();
		let owns: (() => boolean) | undefined;
		vi.spyOn(initial.session, "reopen").mockImplementation((_workspaceId, current) => {
			owns = current;
			return pending.promise;
		});
		assert.equal(appKey().defaultPrevented, true);
		assert.equal(owns?.(), true);
		if (kind === "retired") for (const cell of hooks.cells) cell?.cleanup?.();
		else {
			initial.tree.onOpenProject("other");
			if (kind === "away-back") drive().tree.onSelect(conversation);
		}
		assert.equal(owns?.(), false);
		pending.resolve({ id: "restored", request: 1 });
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(initial.file.controller.snapshot().open, false);
	},
);

test("hidden Reopen reports the real 16-tab capacity refusal and preserves the closed descriptor", async () => {
	vi.stubGlobal("navigator", { platform: "Linux" });
	vi.stubGlobal("document", { querySelector: () => null });
	const initial = drive();
	initial.file.controller.setOpen(false);
	await initial.session.open({ workspaceId: "current", rootId: "root", path: "closed.txt" }, true);
	const id = initial.session.snapshot().activeId;
	assert.ok(id);
	await initial.session.close([id]);
	for (let index = 0; index < 16; index++)
		await initial.session.open({ workspaceId: "current", rootId: "root", path: `${index}.txt` }, true, {
			pinned: true,
		});
	const requests = fileFixture.calls.length;
	appKey();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(initial.file.controller.snapshot().open, false);
	assert.equal(initial.session.snapshot().limitReached, true);
	assert.equal(initial.session.canReopen("current"), true);
	assert.equal(fileFixture.calls.length, requests);
	await vi.waitFor(() =>
		assert.ok(elements(drive().content, "p").some((item) => String(item.props.children).includes("16-file limit"))),
	);
});

test("app bindings are configurable, while pin is unbound by default and keeps execution identity when explicitly bound", async () => {
	saveCommand(local, "catalog", null);
	vi.stubGlobal("navigator", {
		platform: "Linux",
		locks: { request: async (_key: string, work: () => unknown) => work() },
	});
	vi.stubGlobal("document", { querySelector: () => null });
	let pinned = false;
	let revision = 0;
	vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M, params: unknown) => {
		if (method === "setConversationPinned") {
			assert.ok(params && typeof params === "object" && "pinned" in params);
			pinned = Boolean(params.pinned);
			revision++;
		} else assert.equal(method, "getConversationPresentation");
		return parseResult(method, { workspaceId: "current", conversationId: "task", pinned, revision });
	});
	const initial = drive();
	assert.equal(DEFAULT_APP_KEYBINDINGS.pinConversation, "");
	assert.equal(appKey({ key: "p", shiftKey: false, altKey: true }).defaultPrevented, false);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
	const bindings = { ...DEFAULT_APP_KEYBINDINGS, pinConversation: "Mod-Alt-p" };
	drive(bindings);
	assert.equal(appKey({ key: "p", shiftKey: false, altKey: true }).defaultPrevented, true);
	await vi.waitFor(() => assert.equal(initial.tree.presentation?.getSnapshot().result?.pinned, true));
	const current = drive(bindings);
	assert.equal(current.tree.selectedConversation, initial.tree.selectedConversation);
	assert.equal(current.pane?.key, initial.pane?.key);
	assert.equal(local.read(`draft.${scope}`), draft);
	assert.deepEqual(local.pending(scope), pending);
	assert.deepEqual(
		vi.mocked(client.call).mock.calls.map(([method]) => method),
		["getConversationPresentation", "setConversationPinned", "getConversationPresentation"],
	);
	assert.equal(vi.mocked(client.observe).mock.calls.length, 0);
});

const searchHit: ConversationSearchHit = {
	workspaceId: "current",
	conversationId: "task",
	title: "Current task",
	workspaceName: "Current project",
	kind: "message",
	messageId: "1_0",
	locator: "opaque",
	snippet: "needle",
	snippetOffset: 9000,
	matchStart: 9000,
	matchEnd: 9006,
};
const searchWindow: SearchHistoryWindow = {
	workspaceId: "current",
	conversationId: "task",
	messages: [{ id: "1_0", role: "user", text: "preview", textLength: 10000, truncated: true }],
	target: {
		workspaceId: "current",
		conversationId: "task",
		messageId: "1_0",
		text: "needle",
		offset: 9000,
		nextOffset: 9006,
		textLength: 10000,
	},
	matchStart: 9000,
	matchEnd: 9006,
	olderCursor: "older",
	newerCursor: "newer",
};

test.each(["success", "away", "away-back", "retired", "aborted", "failure"] as const)(
	"search activation waits for exact hydration and preserves full-width buffers until %s outcome",
	async (outcome) => {
		const initial = drive();
		await initial.session.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
		initial.editor.edit("Protected search-time buffer");
		const editor = initial.editor;
		const editorState = editor.snapshot();
		const panel = initial.file.controller;
		panel.setOpen(true);
		panel.beginResize();
		panel.resizeFromSplitter(950, measurement.width, false);
		panel.finishResize();
		const hydration = Promise.withResolvers<SearchHistoryWindow>();
		vi.mocked(client.call).mockImplementation(async <M extends Method>(method: M, params: unknown) => {
			if (method === "getConversation") return parseResult(method, conversation);
			assert.equal(method, "getHistoryAroundMatch");
			assert.deepEqual(params, { workspaceId: "current", conversationId: "task", locator: "opaque" });
			return parseResult(method, await hydration.promise);
		});
		const request = new AbortController();
		const activation = element(drive().content, ConversationSearch).props.onActivate(searchHit, request.signal);
		assert.equal(panel.snapshot().fullWidth, true);
		assert.equal(drive().pane?.props.searchAnchor, undefined);
		assert.equal(editor.snapshot(), editorState);
		if (outcome === "retired") for (const cell of hooks.cells) cell?.cleanup?.();
		else if (outcome === "aborted") request.abort();
		else if (outcome === "away" || outcome === "away-back") {
			drive().tree.onOpenProject("other");
			if (outcome === "away-back") drive().tree.onSelect(conversation);
		}
		if (outcome === "failure") hydration.reject(new Error("Cannot hydrate stale result"));
		else hydration.resolve(searchWindow);
		if (outcome === "failure") await assert.rejects(activation);
		else assert.equal(await activation, outcome === "success");
		assert.equal(panel.snapshot().fullWidth, outcome !== "success");
		assert.equal(panel.snapshot().open, true);
		if (outcome !== "retired") assert.equal(editor.snapshot(), editorState);
		assert.equal(local.read(`draft.${scope}`), draft);
		assert.deepEqual(local.pending(scope), pending);
		assert.equal(vi.mocked(client.observe).mock.calls.length, 0);
		if (outcome === "retired") return;
		const current = drive();
		assert.equal(current.pane?.props.searchAnchor?.locator, outcome === "success" ? "opaque" : undefined);
		assert.equal(current.tree.selectedWorkspace, outcome === "away" ? "other" : "current");
		if (outcome === "success") {
			assert.equal(
				current.pane?.key,
				initial.pane?.key,
				"Activating a result in the same conversation preserves the composer owner",
			);
			const frame = elements(current.content, "div").find((node) => node.props.className === "work-conversation-frame");
			assert.equal(frame?.props.inert, false, "The result is visible even when the IDE was full width");
			current.pane?.props.onExitSearchAnchor?.();
			assert.equal(drive().pane?.props.searchAnchor, undefined);
		}
	},
);

test("search uses one configurable unbound desktop command and returns focus to the actual keyboard opener", () => {
	class FocusTarget {
		isConnected = true;
		getClientRects() {
			return [{}];
		}
		focus = vi.fn();
	}
	const opener = new FocusTarget();
	vi.stubGlobal("HTMLElement", FocusTarget);
	vi.stubGlobal("navigator", { platform: "Linux" });
	vi.stubGlobal("document", { activeElement: opener, querySelector: () => null });
	assert.equal(DEFAULT_APP_KEYBINDINGS.searchConversations, "");
	drive();
	assert.equal(appKey({ key: "k", shiftKey: false }).defaultPrevented, false);
	const bindings = { ...DEFAULT_APP_KEYBINDINGS, searchConversations: "Mod-Alt-f" };
	drive(bindings);
	assert.equal(appKey({ key: "f", shiftKey: false, altKey: true, isComposing: true }).defaultPrevented, false);
	assert.equal(appKey({ key: "f", shiftKey: false, altKey: true }).defaultPrevented, true);
	const search = element(drive(bindings).content, ConversationSearch);
	assert.equal(search.props.open, true);
	search.props.onOpenChange(false);
	search.props.onRestoreFocus();
	assert.deepEqual(opener.focus.mock.calls, [[{ preventScroll: true }]]);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
});
