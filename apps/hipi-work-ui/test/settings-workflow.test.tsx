import assert from "node:assert/strict";
import type { ModelCatalog } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { defaultConfig, type ThemeConfig } from "../src/app/theme/config.ts";
import type * as ThemeModule from "../src/app/theme/index.ts";
import { ThemeStore, themeStorageKey } from "../src/app/theme/store.ts";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog, DialogContent } from "../src/components/ui/dialog.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { SettingsForm } from "../src/features/settings/appearance-settings.tsx";
import { SettingsDialog } from "../src/features/settings/settings-dialog.tsx";
import { searchSettings, settingsSearchEntries } from "../src/features/settings/settings-search.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	commits: [] as (() => void)[],
	catalogEnabled: false,
}));
// Drive the real settings owners and their JSX callbacks using the production theme store.
// This bounded adapter does not replace native acceptance of focus trapping, portals, or layout.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	function cell() {
		const index = hooks.cursor++;
		return { index, previous: hooks.cells[index] };
	}
	return {
		...actual,
		useState: <T,>(initial?: T | (() => T)) => {
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
		useRef: <T,>(initial: T) => {
			const { index, previous } = cell();
			const current = previous ?? { value: { current: initial } };
			hooks.cells[index] = current;
			return current.value;
		},
		useId: () => `setting-${hooks.cursor++}`,
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const { index, previous } = cell();
			if (
				!previous ||
				!previous.deps ||
				deps.length !== previous.deps.length ||
				deps.some((value, index) => !Object.is(value, previous.deps?.[index]))
			) {
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
			}
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ enabled }: { enabled: boolean }) => {
		hooks.catalogEnabled = enabled;
		return { data: catalog, isFetching: false, isError: false, refetch: vi.fn() };
	},
}));
vi.mock("../src/app/client-provider.tsx", () => ({ useAppClient: () => ({ call: vi.fn() }) }));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: store.current.locale }) }));
vi.mock("../src/app/theme/index.ts", async (original) => ({
	...(await original<typeof ThemeModule>()),
	useThemeSettings: () => theme,
}));

const catalog: ModelCatalog = {
	providers: [{ provider: "openai", name: "OpenAI", credentialState: "missing" }],
	models: [{ provider: "openai", modelId: "runtime-model-1", name: "Runtime model one" }],
};
const saved = new Map<string, string>();
let store: ThemeStore;
const theme = {
	get config() {
		return store.current;
	},
	get status() {
		return store.status;
	},
	get original() {
		return store.rejectedOriginal;
	},
	preview: (value: unknown) => store.setPreview(value),
	cancel: vi.fn(() => store.cancel()),
	save: vi.fn(() => store.save()),
	export: () => store.export(),
};
class FocusTarget {
	isConnected = true;
	focus = vi.fn();
}
const active = new FocusTarget();
const changed = vi.fn();
const closed = vi.fn();
const restored = vi.fn();
type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function nodes(node: React.ReactNode): Node[] {
	if (Array.isArray(node)) return node.flatMap(nodes);
	if (!isValidElement<Record<string, unknown> & { children?: React.ReactNode }>(node)) return [];
	return [node, ...nodes(node.props.children)];
}
function find(tree: React.ReactNode, predicate: (node: Node) => boolean): Node {
	const result = nodes(tree).find(predicate);
	assert.ok(result, "Expected production control");
	return result;
}
function click(tree: React.ReactNode, predicate: (node: Node) => boolean) {
	const handler = find(tree, predicate).props.onClick;
	assert.equal(typeof handler, "function");
	(handler as () => void)();
}
function driveForm() {
	hooks.cursor = 0;
	const tree = SettingsForm({ onSave: theme.save, onCancel: theme.cancel, onDirtyChange: changed });
	for (const commit of hooks.commits.splice(0)) commit();
	return tree;
}
function driveDialog(open = true) {
	hooks.cursor = 0;
	const tree = SettingsDialog({
		open,
		onOpenChange: closed,
		onRestoreFocus: restored,
		credentialSettings: null,
		runtimeActions: null,
	});
	for (const commit of hooks.commits.splice(0)) commit();
	return tree;
}
function input(tree: React.ReactNode, value: string) {
	const node = find(tree, (node) => node.type === Input && node.props.type === "search");
	(node.props.onChange as React.ChangeEventHandler<HTMLInputElement>)({
		target: { value },
	} as React.ChangeEvent<HTMLInputElement>);
}
function markDirty(tree: React.ReactNode) {
	const owner = find(tree, (node) => typeof node.props.onDirtyChange === "function");
	(owner.props.onDirtyChange as (dirty: boolean) => void)(true);
}
function selectTheme(tree: React.ReactNode, value: string) {
	const choice = find(tree, (node) => node.props.settingId === "theme");
	(choice.props.onChange as (value: string) => void)(value);
}
function editJson(tree: React.ReactNode, value: string) {
	const textarea = find(tree, (node) => node.type === Textarea);
	(textarea.props.onChange as React.ChangeEventHandler<HTMLTextAreaElement>)({
		target: { value },
	} as React.ChangeEvent<HTMLTextAreaElement>);
}
function cleanup() {
	for (const cell of hooks.cells) cell?.cleanup?.();
	hooks.cells = [];
	hooks.commits = [];
}
beforeEach(() => {
	hooks.cells = [];
	hooks.commits = [];
	saved.clear();
	saved.set(themeStorageKey, JSON.stringify({ ...defaultConfig(), locale: "en" }));
	store = new ThemeStore({
		getItem: (key) => saved.get(key) ?? null,
		setItem: (key, value) => {
			saved.set(key, value);
		},
	});
	vi.clearAllMocks();
	vi.stubGlobal("HTMLElement", FocusTarget);
	vi.stubGlobal("document", { activeElement: active });
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

test("search indexes actual localized settings and returned model identities, not invented account controls", () => {
	const entries = settingsSearchEntries(store.current, catalog);
	assert.equal(searchSettings(entries, "  ＴＨＥＭＥ  ")[0]?.id, "theme");
	assert.ok(searchSettings(entries, "appearance code").some((entry) => entry.id === "codeFont"));
	assert.equal(searchSettings(entries, "runtime-model-1")[0]?.label, "Runtime model one");
	assert.equal(searchSettings(entries, "English")[0]?.value, "English");
	assert.equal(searchSettings(entries, " ").length, 0);
	assert.deepEqual(
		searchSettings(entries, "billing").map((entry) => entry.id),
		["providers"],
	);
	for (const query of ["subscription", "password", "nonexistent-setting"])
		assert.equal(searchSettings(entries, query).length, 0);
	const chinese = settingsSearchEntries(defaultConfig());
	assert.equal(searchSettings(chinese, "代码字体")[0]?.id, "codeFont");
	assert.equal(searchSettings(chinese, "凭据")[0]?.category, "models");
});

test("appearance preview is dirty until save, save updates the baseline, and unmount cancels only later preview", () => {
	selectTheme(driveForm(), "dark");
	let tree = driveForm();
	assert.equal(store.current.mode, "dark");
	assert.equal(changed.mock.lastCall?.[0], true);
	assert.equal(JSON.parse(saved.get(themeStorageKey) ?? "").mode, "system");
	click(tree, (node) => node.props.className === "settings-save");
	tree = driveForm();
	assert.equal(changed.mock.lastCall?.[0], false);
	assert.equal(JSON.parse(saved.get(themeStorageKey) ?? "").mode, "dark");
	selectTheme(tree, "light");
	driveForm();
	cleanup();
	assert.equal(store.current.mode, "dark");
	assert.equal(theme.save.mock.calls.length, 1);
});

test("inline appearance Cancel restores focus to its replacement button after resetting the form", () => {
	const owner = find(driveDialog(), (node) => typeof node.props.onDirtyChange === "function");
	assert.equal(typeof owner.type, "function");
	const appearance = owner.type as (props: {
		revision: number;
		onDirtyChange: (dirty: boolean) => void;
	}) => React.ReactNode;
	cleanup();
	const render = (button: FocusTarget) => {
		hooks.cursor = 0;
		const tree = appearance({ revision: 0, onDirtyChange: changed });
		const form = find(tree, (node) => node.type === SettingsForm);
		const ref = form.props.cancelRef as React.RefObject<FocusTarget>;
		ref.current = button;
		for (const commit of hooks.commits.splice(0)) commit();
		return form;
	};
	const oldButton = new FocusTarget();
	const original = render(oldButton);
	assert.equal(oldButton.focus.mock.calls.length, 0);
	store.setPreview({ ...store.current, mode: "dark" });
	(original.props.onCancel as () => void)();
	oldButton.isConnected = false;
	const newButton = new FocusTarget();
	const replacement = render(newButton);
	assert.notEqual(original.key, replacement.key);
	assert.equal(store.current.mode, "system");
	assert.equal(oldButton.focus.mock.calls.length, 0);
	assert.deepEqual(newButton.focus.mock.calls, [[{ preventScroll: true }]]);
	assert.equal(closed.mock.calls.length, 0);
});

test("unapplied JSON cannot be silently saved or cleared by an unrelated appearance preview", () => {
	const next: ThemeConfig = { ...store.current, mode: "dark" };
	editJson(driveForm(), JSON.stringify(next));
	let tree = driveForm();
	assert.equal(changed.mock.lastCall?.[0], true);
	assert.equal(find(tree, (node) => node.props.className === "settings-save").props.disabled, true);
	selectTheme(tree, "light");
	tree = driveForm();
	assert.equal(find(tree, (node) => node.props.className === "settings-save").props.disabled, true);
	click(tree, (node) => node.type === Button && node.props.children === "Preview JSON");
	tree = driveForm();
	assert.equal(store.current.mode, "dark");
	assert.equal(find(tree, (node) => node.props.className === "settings-save").props.disabled, false);
	click(tree, (node) => node.props.className === "settings-save");
	driveForm();
	assert.equal(changed.mock.lastCall?.[0], false);
});

test("invalid regional inputs remain dirty without changing the applied theme or allowing save", () => {
	const tree = driveForm();
	const field = find(tree, (node) => node.type === Input && node.props.placeholder === "#RRGGBB");
	(field.props.onChange as React.ChangeEventHandler<HTMLInputElement>)({
		target: { value: "#000000" },
	} as React.ChangeEvent<HTMLInputElement>);
	const invalid = driveForm();
	assert.deepEqual(store.current.regions, {});
	assert.equal(changed.mock.lastCall?.[0], true);
	assert.equal(find(invalid, (node) => node.props.className === "settings-save").props.disabled, true);
	click(invalid, (node) => node.props.className === "settings-save");
	assert.equal(theme.save.mock.calls.length, 0);
});

test("an imported file completing after the form unmounts cannot apply a stale theme", async () => {
	let resolveFile: ((value: string) => void) | undefined;
	const text = new Promise<string>((resolve) => {
		resolveFile = resolve;
	});
	const field = find(driveForm(), (node) => node.type === Input && node.props.type === "file");
	(field.props.onChange as React.ChangeEventHandler<HTMLInputElement>)({
		target: { value: "selected.json", files: [{ size: 100, text: () => text }] },
	} as unknown as React.ChangeEvent<HTMLInputElement>);
	assert.equal(changed.mock.lastCall?.[0], false);
	driveForm();
	assert.equal(changed.mock.lastCall?.[0], true);
	cleanup();
	assert.ok(resolveFile);
	resolveFile(JSON.stringify({ ...store.current, mode: "dark" }));
	await text;
	await Promise.resolve();
	assert.equal(store.current.mode, "system");
	assert.equal(theme.save.mock.calls.length, 0);
});

test("category navigation keeps edits on cancellation and discards only after an explicit choice", () => {
	markDirty(driveDialog());
	click(driveDialog(), (node) => node.type === Button && node.props["data-category"] === "models");
	let tree = driveDialog();
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "appearance").props["aria-current"],
		"page",
	);
	assert.ok(find(tree, (node) => node.props.className === "settings-unsaved-dialog"));
	click(tree, (node) => node.type === Button && node.props.children === "Keep editing");
	tree = driveDialog();
	assert.equal(
		nodes(tree).some((node) => node.props.className === "settings-unsaved-dialog"),
		false,
	);
	assert.equal(theme.cancel.mock.calls.length, 0);
	click(tree, (node) => node.type === Button && node.props["data-category"] === "models");
	click(driveDialog(), (node) => node.type === Button && node.props.children === "Discard changes");
	tree = driveDialog();
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
	assert.equal(theme.cancel.mock.calls.length, 1);
	assert.equal(closed.mock.calls.length, 0);
	assert.equal(hooks.catalogEnabled, true);
});

test("close is guarded, rejecting the guard retains settings, and discard closes exactly once", () => {
	markDirty(driveDialog());
	let tree = driveDialog();
	(tree.props.onOpenChange as (open: boolean) => void)(false);
	tree = driveDialog();
	const nested = nodes(tree)
		.filter((node) => node.type === Dialog)
		.at(-1);
	assert.ok(nested);
	(nested.props.onOpenChange as (open: boolean) => void)(false);
	assert.equal(closed.mock.calls.length, 0);
	tree = driveDialog();
	(tree.props.onOpenChange as (open: boolean) => void)(false);
	click(driveDialog(), (node) => node.type === Button && node.props.children === "Discard changes");
	assert.deepEqual(closed.mock.calls, [[false]]);
	assert.equal(theme.cancel.mock.calls.length, 1);
});

test("search preserves pending navigation and Escape clears search before dismissal, without swallowing IME text", () => {
	markDirty(driveDialog());
	input(driveDialog(), "credentials");
	let tree = driveDialog();
	click(
		tree,
		(node) => node.props.className === "settings-search-result" && node.props["data-setting"] === "credentials",
	);
	tree = driveDialog();
	click(tree, (node) => node.type === Button && node.props.children === "Keep editing");
	tree = driveDialog();
	assert.equal(find(tree, (node) => node.type === Input).props.value, "credentials");
	const modal = find(tree, (node) => node.type === DialogContent && node.props.className === "unified-settings-dialog");
	const preventDefault = vi.fn();
	(modal.props.onEscapeKeyDown as (event: Partial<KeyboardEvent>) => void)({ preventDefault, isComposing: true });
	assert.equal(find(driveDialog(), (node) => node.type === Input).props.value, "credentials");
	(modal.props.onEscapeKeyDown as (event: Partial<KeyboardEvent>) => void)({ preventDefault, isComposing: false });
	assert.equal(find(driveDialog(), (node) => node.type === Input).props.value, "");
	assert.equal(preventDefault.mock.calls.length, 2);
	assert.equal(closed.mock.calls.length, 0);
});

test("unmodified category changes and same-category search jumps keep the modal open", () => {
	input(driveDialog(), "regional");
	click(
		driveDialog(),
		(node) => node.props.className === "settings-search-result" && node.props["data-setting"] === "regions",
	);
	let tree = driveDialog();
	assert.equal(find(tree, (node) => node.type === Input).props.value, "");
	assert.equal(
		nodes(tree).some((node) => node.props.className === "settings-unsaved-dialog"),
		false,
	);
	click(tree, (node) => node.type === Button && node.props["data-category"] === "runtime");
	tree = driveDialog();
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "runtime").props["aria-current"],
		"page",
	);
	assert.equal(closed.mock.calls.length, 0);
	assert.equal(theme.cancel.mock.calls.length, 0);
});

test("modal lifecycle restores its caller focus and clearing a search preserves the current category", () => {
	let tree = driveDialog();
	click(tree, (node) => node.type === Button && node.props["data-category"] === "models");
	input(driveDialog(), "unmatched-query");
	tree = driveDialog();
	assert.ok(find(tree, (node) => node.props.className === "settings-search-empty"));
	click(tree, (node) => node.type === Button && node.props["aria-label"] === "Clear search");
	tree = driveDialog();
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
	const modal = find(tree, (node) => node.type === DialogContent && node.props.className === "unified-settings-dialog");
	const preventDefault = vi.fn();
	(modal.props.onCloseAutoFocus as (event: { preventDefault: () => void }) => void)({ preventDefault });
	assert.equal(preventDefault.mock.calls.length, 1);
	assert.equal(restored.mock.calls.length, 1);
	driveDialog(false);
	tree = driveDialog();
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
});
