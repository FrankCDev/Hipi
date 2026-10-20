import assert from "node:assert/strict";
import {
	type AppClient,
	type Conversation,
	type Method,
	PROTOCOL_VERSION,
	parseResult,
	type Submit,
	type Workspace,
} from "@hipi/work-runtime/contracts";
import type { FileText } from "@hipi/work-runtime/files";
import { createFileClient, type FileRequest, fileRequestTarget } from "@hipi/work-runtime/files/protocol";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { InputGroupInput } from "../src/components/ui/input-group.tsx";
import { FileWorkspaceSession } from "../src/features/files/file-workspace-session.ts";
import { SettingsDialog } from "../src/features/settings/index.ts";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import { type CatalogCommand, saveCommand } from "../src/features/workbench/command-recovery.ts";
import { ConnectionActions } from "../src/features/workbench/connection-actions.tsx";
import { ConversationPane } from "../src/features/workbench/conversation-pane.tsx";
import { FilePanel } from "../src/features/workbench/file-panel.tsx";
import { admitInitialSend } from "../src/features/workbench/initial-send.ts";
import type { BrowserStorage } from "../src/features/workbench/local-persistence.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { PreparedTaskEntry } from "../src/features/workbench/prepared-task-entry.tsx";
import { PreparedTaskRecovery } from "../src/features/workbench/prepared-task-recovery.tsx";
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
vi.mock("@tanstack/react-query", () => ({
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
	useFiles: () => ({ files: fileFixture.files }),
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
const cache = { setQueryData: vi.fn(), invalidateQueries: vi.fn(async () => {}) };
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
function drive() {
	for (let attempt = 0; attempt < 5; attempt++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const content = Workbench({ disconnect });
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

beforeEach(() => {
	measurement.width = 1000;
	hooks.cells = [];
	hooks.commits = [];
	vi.clearAllMocks();
	const events = new EventTarget();
	vi.stubGlobal("window", {
		innerWidth: 390,
		matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	});
	storage = new MemoryStorage();
	local = new LocalState("store", storage);
	fileFixture = createFileFixture();
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

test("other/current disclosure preserves the exact nonempty search entered through Workbench's input callback", () => {
	const initial = drive();
	const input = element(initial.content, InputGroupInput);
	const search = "  Current task / 草稿  ";
	assert.ok(input.props.onChange);
	Reflect.apply(input.props.onChange, undefined, [{ target: { value: search } }]);
	assert.equal(drive().tree.search, search);
	const snapshot = initial.session.snapshot();
	for (const id of ["other", "other", "current", "current"]) {
		drive().tree.onToggle(id);
		const current = drive();
		assertPreserved(current, initial);
		assert.equal(current.tree.search, search);
		assert.equal(element(current.content, InputGroupInput).props.value, search);
		assert.equal(current.session.snapshot(), snapshot);
	}
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
