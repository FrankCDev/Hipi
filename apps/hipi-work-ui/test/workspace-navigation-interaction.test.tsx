import assert from "node:assert/strict";
import {
	type AppClient,
	type Conversation,
	PROTOCOL_VERSION,
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
import { EditorSession } from "../src/features/files/editor-session.ts";
import { fileLabels } from "../src/features/files/file-labels.ts";
import { SettingsDialog } from "../src/features/settings/index.ts";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import { type CatalogCommand, saveCommand } from "../src/features/workbench/command-recovery.ts";
import { ConversationPane } from "../src/features/workbench/conversation-pane.tsx";
import { CreateDialog } from "../src/features/workbench/create-dialog.tsx";
import { FilePanel } from "../src/features/workbench/file-panel.tsx";
import type { BrowserStorage } from "../src/features/workbench/local-persistence.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { Workbench } from "../src/features/workbench/workbench.tsx";
import { WorkbenchWelcome } from "../src/features/workbench/workbench-welcome.tsx";
import { WorkspaceTree } from "../src/features/workbench/workspace-tree.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
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
		const content = Workbench({ disconnect: () => {} });
		for (const commit of hooks.commits.splice(0)) commit();
		if (hooks.changed) continue;
		const tree = element(content, WorkspaceTree);
		const file = element(content, FilePanel);
		const leave = element(content, Dialog);
		assert.ok(file.props.session instanceof EditorSession);
		assert.ok(tree.props.catalog instanceof CatalogSession);
		return {
			content,
			tree: tree.props,
			file: file.props,
			editor: file.props.session,
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
	assert.equal(current.editor, initial.editor);
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
	await initial.editor.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
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
	const snapshot = initial.editor.snapshot();
	for (const id of ["other", "other", "current", "current"]) {
		drive().tree.onToggle(id);
		const current = drive();
		assertPreserved(current, initial);
		assert.equal(current.tree.search, search);
		assert.equal(element(current.content, InputGroupInput).props.value, search);
		assert.equal(current.editor.snapshot(), snapshot);
	}
});

test.each(["dirty", "saving", "unknown"] as const)(
	"disclosure never prompts, clears or cancels a %s editor",
	async (state) => {
		const initial = drive();
		await initial.editor.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
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
	await initial.editor.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
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

test("explicit Open project keeps the dirty-file guard: cancel preserves work; confirm opens an empty project", async () => {
	const initial = drive();
	await initial.editor.open({ workspaceId: "current", rootId: "root", path: "work.txt" }, true);
	initial.editor.edit("Unsaved file input");
	const snapshot = initial.editor.snapshot();
	initial.tree.onOpenProject("empty");
	const prompted = drive();
	assert.equal(prompted.leave.props.open, true);
	assert.equal(prompted.tree.selectedWorkspace, "current");
	assert.equal(prompted.pane?.key, initial.pane?.key);
	assert.equal(prompted.editor.snapshot(), snapshot);
	const cancel = elements(prompted.leave, Button).find((button) => button.props.children === fileLabels("en").stay);
	assert.ok(cancel);
	press(cancel);
	assertPreserved(drive(), initial);
	assert.equal(initial.editor.snapshot(), snapshot);
	drive().tree.onOpenProject("empty");
	const confirm = elements(drive().leave, Button).find((button) => button.props.children === fileLabels("en").discard);
	assert.ok(confirm);
	press(confirm);
	const opened = drive();
	assert.equal(opened.leave.props.open, false);
	assert.equal(opened.tree.selectedWorkspace, "empty");
	assert.equal(opened.tree.selectedConversation, "");
	assert.equal(opened.tree.isExpanded("empty"), true);
	assert.equal(opened.pane, undefined);
	const welcome = element(opened.content, WorkbenchWelcome);
	assert.equal(welcome.props.workspaceName, "Empty project");
	assert.equal(element(welcome.props.action, CreateDialog).props.kind, "conversation");
	const settings = element(opened.content, SettingsDialog);
	assert.deepEqual(settings.props.workspace, { workspaceId: "empty", name: "Empty project" });
	assert.equal(settings.props.conversation, undefined);
	assert.equal(opened.file.workspaceId, "empty");
	assert.equal(opened.editor, initial.editor);
	assert.deepEqual(opened.editor.snapshot(), {});
	assert.equal(local.read("workspace"), "empty");
	assert.equal(local.read("conversation"), "");
	assert.equal(local.read(`draft.${scope}`), draft);
	assert.deepEqual(local.pending(scope), pending);
	assert.equal(fileFixture.calls.length, 1);
});

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
