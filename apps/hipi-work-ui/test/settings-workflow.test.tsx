import assert from "node:assert/strict";
import {
	type AppearanceClient,
	AppearanceError,
	type AppearanceStatus,
	type InstalledFontCatalog,
} from "@hipi/work-runtime/appearance";
import type { ModelCatalog } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { defaultAppearance, defaultConfig, exportAppearanceShare } from "../src/app/theme/config.ts";
import type * as ThemeModule from "../src/app/theme/index.ts";
import { ThemeStore, themeStorageKey } from "../src/app/theme/store.ts";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { Select, SelectContent, SelectItem } from "../src/components/ui/select.tsx";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { SettingsForm } from "../src/features/settings/appearance-settings.tsx";
import { ModelSettingsContent } from "../src/features/settings/model-settings-content.tsx";
import { SettingsDialog } from "../src/features/settings/settings-dialog.tsx";
import { searchSettings, settingsSearchEntries } from "../src/features/settings/settings-search.ts";
import { SettingsSurface } from "../src/features/settings/settings-surface.tsx";

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
		useCallback: <T,>(callback: T) => callback,
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
vi.mock("../src/app/appearance-provider.tsx", () => ({ useAppearance: () => appearance }));
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
let appearance: { client?: AppearanceClient; status?: AppearanceStatus } = {};
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
	update: vi.fn((value: unknown) => store.update(value)),
	export: () => exportAppearanceShare(store.current),
};
class FocusTarget {
	isConnected = true;
	focus = vi.fn();
}
const active = new FocusTarget();
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
	const tree = SettingsForm();
	for (const commit of hooks.commits.splice(0)) commit();
	return tree;
}
function driveDialog(open = true, initialCategory?: "general" | "appearance" | "models" | "runtime") {
	hooks.cursor = 0;
	const tree = SettingsDialog({
		open,
		initialCategory,
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
function selectTheme(tree: React.ReactNode, mode: string) {
	const control = find(
		tree,
		(node) => node.type === "input" && node.props.type === "radio" && node.props.value === mode,
	);
	(control.props.onChange as () => void)();
}
function cleanup() {
	for (const cell of hooks.cells) cell?.cleanup?.();
	hooks.cells = [];
	hooks.commits = [];
	appearance = {};
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
	vi.stubGlobal("window", {});
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

test("search indexes only localized supported settings and runtime identities", () => {
	const entries = settingsSearchEntries(store.current, catalog);
	assert.equal(searchSettings(entries, "  ＴＨＥＭＥ  ")[0]?.id, "theme");
	assert.ok(searchSettings(entries, "appearance code").some((entry) => entry.id === "codeFont"));
	assert.equal(searchSettings(entries, "runtime-model-1")[0]?.label, "Runtime model one");
	assert.equal(searchSettings(entries, "runtime-model-1")[0]?.target, "custom-providers");
	assert.match(searchSettings(entries, "runtime-model-1")[0]?.description ?? "", /OpenAI/);
	assert.equal(searchSettings(entries, "English")[0]?.value, "English");
	assert.equal(searchSettings(entries, " ").length, 0);
	for (const query of ["subscription", "password", "nonexistent-setting", "JSON"])
		assert.equal(searchSettings(entries, query).length, 0);
	const chinese = settingsSearchEntries(defaultConfig());
	assert.equal(searchSettings(chinese, "代码字体")[0]?.id, "codeFont");
	assert.equal(searchSettings(chinese, "凭据")[0]?.category, "models");
});

test("theme changes persist immediately and neither page navigation nor unmount rolls them back", () => {
	selectTheme(driveForm(), "dark");
	assert.equal(store.current.mode, "dark");
	assert.equal(JSON.parse(saved.get(themeStorageKey) ?? "").mode, "dark");
	const tree = driveForm();
	assert.equal(
		nodes(tree).some((node) => node.props.className === "settings-savebar"),
		false,
	);
	assert.equal(theme.cancel.mock.calls.length, 0);
	cleanup();
	assert.equal(store.current.mode, "dark");
	assert.equal(new ThemeStore({ getItem: (key) => saved.get(key) ?? null, setItem: () => {} }).current.mode, "dark");
});

test("invalid color picks revert the native control without persisting an unreadable palette", () => {
	const tree = driveForm();
	const picker = find(tree, (node) => node.type === "input" && node.props["aria-label"] === "Light Foreground");
	const value = defaultAppearance("light").background;
	const target = { value };
	(picker.props.onChange as (event: { target: { value: string }; currentTarget: { value: string } }) => void)({
		target,
		currentTarget: target,
	});
	assert.deepEqual(store.current.appearance, {});
	assert.equal(target.value, defaultAppearance("light").foreground);
	assert.equal(JSON.parse(saved.get(themeStorageKey) ?? "").appearance.light, undefined);
	assert.ok(find(driveForm(), (node) => node.props.role === "alert"));
});

test("font-size input commits on blur, Enter and completed spinner changes; invalid input reverts", () => {
	const owner = find(driveForm(), (node) => node.props.type === "number" && node.props.label === "UI font size");
	assert.equal(typeof owner.type, "function");
	const component = owner.type as (props: Record<string, unknown>) => React.ReactNode;
	cleanup();
	const render = () => {
		hooks.cursor = 0;
		const tree = component({ ...owner.props, value: String(store.current.uiFontSize) });
		for (const commit of hooks.commits.splice(0)) commit();
		return find(tree, (node) => node.type === Input);
	};
	let control = render();
	assert.equal(control.props.min, 11);
	assert.equal(control.props.max, 16);
	assert.equal(control.props.step, 1);
	const change = (value: string) => {
		(control.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
		control = render();
	};
	change("15");
	assert.equal(store.current.uiFontSize, 14);
	(control.props.onBlur as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: "15" } });
	assert.equal(store.current.uiFontSize, 15);
	assert.equal(JSON.parse(saved.get(themeStorageKey) ?? "").uiFontSize, 15);
	change("99999");
	(control.props.onBlur as (event: { currentTarget: { value: string } }) => void)({
		currentTarget: { value: "99999" },
	});
	assert.equal(store.current.uiFontSize, 15);
	assert.equal(render().props.value, "15");
	const preventDefault = vi.fn();
	(control.props.onKeyDown as (event: Record<string, unknown>) => void)({
		key: "Enter",
		nativeEvent: { isComposing: true },
		preventDefault,
		currentTarget: { value: "15.5" },
	});
	assert.equal(store.current.uiFontSize, 15);
	(control.props.onKeyDown as (event: Record<string, unknown>) => void)({
		key: "Enter",
		nativeEvent: { isComposing: false },
		preventDefault,
		currentTarget: { value: "15.5" },
	});
	assert.equal(store.current.uiFontSize, 15.5);
	(control.props.onPointerDown as (event: { currentTarget: { value: string } }) => void)({
		currentTarget: { value: "15.5" },
	});
	(control.props.onPointerUp as (event: { currentTarget: { value: string } }) => void)({
		currentTarget: { value: "16" },
	});
	assert.equal(store.current.uiFontSize, 16);
});

test("validated share import persists without global save and never imports the source locale", () => {
	let tree = driveForm();
	click(tree, (node) => node.type === Button && node.props["aria-label"] === "Import theme");
	tree = driveForm();
	const textarea = find(tree, (node) => node.type === Textarea);
	(textarea.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "invalid" } });
	tree = driveForm();
	assert.equal(find(tree, (node) => node.type === Button && node.props.children === "Import").props.disabled, true);
	(find(tree, (node) => node.type === Textarea).props.onChange as (event: { target: { value: string } }) => void)({
		target: { value: exportAppearanceShare({ ...defaultConfig(), mode: "dark", uiFontSize: 15 }) },
	});
	tree = driveForm();
	click(tree, (node) => node.type === Button && node.props.children === "Import");
	assert.equal(store.current.mode, "dark");
	assert.equal(store.current.uiFontSize, 15);
	assert.equal(store.current.locale, "en");
	assert.equal(JSON.parse(saved.get(themeStorageKey) ?? "").mode, "dark");
	assert.equal(find(driveForm(), (node) => node.type === Dialog).props.open, false);
});

test("copy does not report success before clipboard write completes and reports denial honestly", async () => {
	let finish: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => pending) } });
	click(driveForm(), (node) => node.type === Button && node.props["aria-label"] === "Copy theme");
	assert.equal(
		nodes(driveForm()).some((node) => node.props.children === "Theme copied"),
		false,
	);
	assert.ok(finish);
	finish();
	await pending;
	await Promise.resolve();
	assert.ok(find(driveForm(), (node) => node.props.children === "Theme copied"));
	vi.stubGlobal("navigator", {
		clipboard: {
			writeText: vi.fn(async () => {
				throw new Error("denied");
			}),
		},
	});
	click(driveForm(), (node) => node.type === Button && node.props["aria-label"] === "Copy theme");
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(
		find(
			driveForm(),
			(node) => node.props.children === "Could not copy the theme. Try again when clipboard access is available.",
		),
	);
});

test("category navigation and closing never add a dirty guard or cancel committed preferences", () => {
	click(driveDialog(), (node) => node.type === Button && node.props["data-category"] === "models");
	let tree = driveDialog();
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
	assert.equal(hooks.catalogEnabled, true);
	(find(tree, (node) => node.type === SettingsSurface).props.onOpenChange as (open: boolean) => void)(false);
	assert.deepEqual(closed.mock.calls, [[false]]);
	assert.equal(theme.cancel.mock.calls.length, 0);
	driveDialog(false);
	assert.equal(restored.mock.calls.length, 0, "Focus is restored by modal teardown, not before the app is interactive");
	(find(tree, (node) => node.type === SettingsSurface).props.onRestoreFocus as () => void)();
	assert.equal(restored.mock.calls.length, 1);
	tree = driveDialog();
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
});

test("search replaces the category list and chooses an exact destination with no default keyboard selection", () => {
	input(driveDialog(), "credentials");
	let tree = driveDialog();
	assert.equal(
		nodes(tree).some((node) => node.props.className === "settings-page-nav"),
		false,
	);
	assert.equal(find(tree, (node) => node.type === Input).props["aria-activedescendant"], undefined);
	const key = (key: string) => {
		(find(tree, (node) => node.type === Input).props.onKeyDown as (event: Record<string, unknown>) => void)({
			key,
			nativeEvent: { isComposing: false },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});
		tree = driveDialog();
	};
	key("Enter");
	assert.equal(find(tree, (node) => node.type === Input).props.value, "credentials");
	click(
		tree,
		(node) => node.props.className === "settings-search-result" && node.props["data-setting"] === "custom-providers",
	);
	tree = driveDialog();
	assert.equal(find(tree, (node) => node.type === Input).props.value, "");
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
	assert.equal(find(tree, (node) => node.type === SettingsForm).props.selectedSetting, "custom-providers");
	assert.equal(closed.mock.calls.length, 0);
});

test("an inline model mutation blocks stale close and category callbacks until its owner settles", () => {
	const tree = driveDialog(true, "models");
	const changed = find(tree, (node) => node.type === ModelSettingsContent).props.onBusy as (busy: boolean) => void;
	changed(true);
	(find(tree, (node) => node.type === SettingsSurface).props.onOpenChange as (open: boolean) => void)(false);
	click(tree, (node) => node.type === Button && node.props["data-category"] === "appearance");
	assert.equal(closed.mock.calls.length, 0);
	let current = driveDialog();
	assert.equal(find(current, (node) => node.type === SettingsSurface).props.busy, true);
	assert.equal(
		find(current, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
	assert.equal(find(current, (node) => node.type === Input).props.disabled, true);
	changed(false);
	current = driveDialog();
	click(current, (node) => node.type === Button && node.props["data-category"] === "appearance");
	assert.equal(
		find(driveDialog(), (node) => node.type === Button && node.props["data-category"] === "appearance").props[
			"aria-current"
		],
		"page",
	);
});

test("modal capture clears a populated search before Escape can dismiss settings", () => {
	input(driveDialog(), "font");
	let tree = driveDialog();
	const preventDefault = vi.fn();
	(
		find(tree, (node) => node.type === SettingsSurface).props.onEscapeKeyDown as (
			event: Record<string, unknown>,
		) => void
	)({ preventDefault });
	assert.equal(preventDefault.mock.calls.length, 1);
	assert.equal(closed.mock.calls.length, 0);
	tree = driveDialog();
	assert.equal(find(tree, (node) => node.type === Input).props.value, "");
	(
		find(tree, (node) => node.type === SettingsSurface).props.onEscapeKeyDown as (
			event: Record<string, unknown>,
		) => void
	)({ preventDefault });
	assert.equal(preventDefault.mock.calls.length, 1, "An empty search leaves dismissal to the actual Radix layer");
});

test("Escape clears search without leaving the page and does not swallow IME composition", () => {
	input(driveDialog(), "font");
	let tree = driveDialog();
	const search = find(tree, (node) => node.type === Input);
	const preventDefault = vi.fn();
	const onKeyDown = search.props.onKeyDown as (event: Record<string, unknown>) => void;
	onKeyDown({ key: "Escape", nativeEvent: { isComposing: true }, preventDefault, stopPropagation: vi.fn() });
	assert.equal(find(driveDialog(), (node) => node.type === Input).props.value, "font");
	onKeyDown({ key: "Escape", nativeEvent: { isComposing: false }, preventDefault, stopPropagation: vi.fn() });
	tree = driveDialog();
	assert.equal(find(tree, (node) => node.type === Input).props.value, "");
	assert.equal(preventDefault.mock.calls.length, 1);
	assert.equal(closed.mock.calls.length, 0);
});

test("opening from a model command uses its explicit category while preserving category scroll offsets", () => {
	let tree = driveDialog(true, "models");
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "models").props["aria-current"],
		"page",
	);
	const pane = { scrollTop: 125, querySelectorAll: () => [] };
	const content = find(tree, (node) => node.props.className === "settings-page-content");
	(content.props.ref as React.RefObject<typeof pane>).current = pane;
	click(tree, (node) => node.type === Button && node.props["data-category"] === "runtime");
	tree = driveDialog();
	assert.equal(pane.scrollTop, 0);
	pane.scrollTop = 80;
	click(tree, (node) => node.type === Button && node.props["data-category"] === "models");
	driveDialog();
	assert.equal(pane.scrollTop, 125);
	driveDialog(false);
	tree = driveDialog(true, "appearance");
	tree = driveDialog(true, "appearance");
	assert.equal(
		find(tree, (node) => node.type === Button && node.props["data-category"] === "appearance").props["aria-current"],
		"page",
	);
});

test("Advanced reset is conditional and preserves visual mode, colors, UI font and language", () => {
	assert.equal(
		nodes(driveForm()).some((node) => node.props.className === "settings-advanced-reset"),
		false,
	);
	const colors = defaultAppearance("dark");
	store.update({
		...store.current,
		mode: "dark",
		uiFont: "serif",
		customUiFont: "Georgia",
		uiFontSize: 15,
		codeFontSize: 17,
		contentFont: "mono",
		reducedMotion: "on",
		appearance: { dark: colors },
	});
	click(driveForm(), (node) => node.props.className === "settings-advanced-reset");
	assert.equal(store.current.uiFontSize, defaultConfig().uiFontSize);
	assert.equal(store.current.codeFontSize, defaultConfig().codeFontSize);
	assert.equal(store.current.contentFont, "inherit");
	assert.equal(store.current.reducedMotion, "system");
	assert.equal(store.current.mode, "dark");
	assert.equal(store.current.uiFont, "serif");
	assert.equal(store.current.customUiFont, "Georgia");
	assert.deepEqual(store.current.appearance, { dark: colors });
	assert.equal(store.current.locale, "en");
	assert.equal(
		nodes(driveForm()).some((node) => node.props.className === "settings-advanced-reset"),
		false,
	);
});

test("browser installed font selection stays explicit and persists exact family/style without a Save step", async () => {
	const regular = {
		family: "Example Mono",
		fullName: "Example Mono Regular",
		postscriptName: "ExampleMono-Regular",
		style: "Regular",
	};
	const bold = { ...regular, fullName: "Example Mono Bold", postscriptName: "ExampleMono-Bold", style: "Bold" };
	let calls = 0;
	appearance = {
		status: { ...nativeStatus, platform: "web" },
		client: {
			localFontsSupported: true,
			status: async () => {
				throw new Error("not called by form");
			},
			setBackdrop: async () => {
				throw new Error("not called by form");
			},
			setThemeMode: async () => {
				throw new Error("not called by form");
			},
			subscribe: () => () => {},
			listFonts: async () => {
				calls++;
				return {
					truncated: false,
					families: [
						{ family: "Example Mono", faces: [regular, bold], monospace: true },
						{
							family: "Example Sans",
							faces: [{ ...regular, family: "Example Sans", postscriptName: "ExampleSans" }],
							monospace: false,
						},
					],
				};
			},
		},
	};
	let tree = driveForm();
	assert.equal(calls, 0);
	assert.equal(
		find(tree, (node) => node.props.settingId === "installedFonts").props.description,
		"Read font names and styles on this device. Browsers may ask permission. Nothing is uploaded.",
	);
	const unopened = find(tree, (node) => node.props.label === "Font" && Array.isArray(node.props.options));
	(unopened.props.onOpenChange as (open: boolean) => void)(true);
	tree = driveForm();
	await Promise.resolve();
	assert.equal(calls, 0);
	click(tree, (node) => node.type === Button && node.props.children === "Choose installed fonts");
	await Promise.resolve();
	await Promise.resolve();
	tree = driveForm();
	assert.equal(calls, 1);
	const font = find(tree, (node) => node.props.label === "Font" && Array.isArray(node.props.options));
	(font.props.onChange as (value: string) => void)("installed:Example Mono");
	assert.deepEqual(store.current.localFontFaces.ui, regular);
	const style = find(driveForm(), (node) => node.props.label === "Font style");
	(style.props.onChange as (value: string) => void)("ExampleMono-Bold");
	assert.deepEqual(store.current.localFontFaces.ui, bold);
	const code = find(driveForm(), (node) => node.props.label === "Code font" && Array.isArray(node.props.options));
	assert.ok((code.props.options as { value: string }[]).some((option) => option.value === "installed:Example Mono"));
	assert.equal(
		(code.props.options as { value: string }[]).some((option) => option.value === "installed:Example Sans"),
		false,
	);
	assert.equal(JSON.parse(saved.get(themeStorageKey) ?? "").localFontFaces.ui.postscriptName, "ExampleMono-Bold");
});

const nativeStatus: AppearanceStatus = {
	version: 1,
	platform: "linux",
	backdrop: "unsupported",
	backdropEnabled: false,
	reducedTransparency: false,
	fontSmoothing: false,
	themeMode: "system",
};
function fontClient(listFonts: AppearanceClient["listFonts"]): AppearanceClient {
	return {
		localFontsSupported: true,
		status: async () => nativeStatus,
		setBackdrop: async () => nativeStatus,
		setThemeMode: async () => nativeStatus,
		subscribe: () => () => {},
		listFonts,
	};
}
function openFont() {
	const font = find(driveForm(), (node) => node.props.label === "Font" && Array.isArray(node.props.options));
	(font.props.onOpenChange as (open: boolean) => void)(true);
	driveForm();
}
async function settleFonts() {
	for (let index = 0; index < 6; index++) await Promise.resolve();
}
test("native picker opens the bounded query, survives StrictMode replay and remounts from its cached catalog", async () => {
	const face = {
		family: "Native Sans",
		fullName: "Native Sans Regular",
		postscriptName: "NativeSans",
		style: "Regular",
	};
	const catalog: InstalledFontCatalog = {
		families: [{ family: face.family, faces: [face], monospace: false }],
		truncated: false,
	};
	let finish: (value: InstalledFontCatalog) => void = () => {};
	let signal: AbortSignal | undefined;
	const list = vi.fn((active?: AbortSignal) => {
		signal = active;
		return new Promise<InstalledFontCatalog>((resolve) => {
			finish = resolve;
		});
	});
	const client = fontClient(list);
	appearance = { client, status: nativeStatus };
	const initial = driveForm();
	assert.equal(list.mock.calls.length, 0);
	assert.equal(
		nodes(initial).some((node) => node.props.children === "Choose installed fonts"),
		false,
	);
	assert.equal(
		nodes(initial).some((node) => node.props.settingId === "installedFonts"),
		false,
	);
	openFont();
	// Replay actual form effects with state retained, matching StrictMode setup→cleanup→setup.
	for (const cell of hooks.cells) {
		if (cell?.deps) {
			cell.cleanup?.();
			cell.cleanup = undefined;
			cell.deps = undefined;
		}
	}
	driveForm();
	await settleFonts();
	assert.equal(list.mock.calls.length, 1);
	assert.equal(signal?.aborted, false);
	const pending = driveForm();
	assert.ok(find(pending, (node) => node.props["data-font-catalog-state"] === "pending"));
	assert.equal(
		find(pending, (node) => node.props.label === "Font" && Array.isArray(node.props.options)).props.loading,
		"Reading fonts…",
	);
	assert.equal(
		nodes(pending).some((node) => node.props.settingId === "installedFonts"),
		false,
	);
	finish(catalog);
	await settleFonts();
	let tree = driveForm();
	assert.equal(
		find(tree, (node) => node.props["data-font-catalog-state"] === "ready").props["data-font-family-count"],
		1,
	);
	const font = find(tree, (node) => node.props.label === "Font" && Array.isArray(node.props.options));
	assert.equal(
		nodes(tree).some((node) => node.props.settingId === "installedFonts"),
		false,
	);
	assert.equal(font.props.notice, false);
	assert.equal(font.props.action, undefined);
	assert.ok(find(tree, (node) => node.props["data-setting"] === "installedFonts"));
	(font.props.onChange as (value: string) => void)("installed:Native Sans");
	assert.deepEqual(store.current.localFontFaces.ui, face);
	cleanup();
	await settleFonts();
	appearance = { client, status: nativeStatus };
	const reopenedStyle = find(driveForm(), (node) => node.props.label === "Font style");
	(reopenedStyle.props.onOpenChange as (open: boolean) => void)(true);
	driveForm();
	await settleFonts();
	tree = driveForm();
	assert.equal(list.mock.calls.length, 1);
	assert.ok(find(tree, (node) => node.props["data-font-catalog-state"] === "ready"));
	assert.equal(find(tree, (node) => node.props.label === "Font style").props.value, "NativeSans");
});
test("native picker keeps failure explicit across remount, retries once and ignores a replaced client's late catalog", async () => {
	let calls = 0;
	let finish: (value: InstalledFontCatalog) => void = () => {};
	let oldSignal: AbortSignal | undefined;
	const client = fontClient((signal) => {
		calls++;
		if (calls === 1) return Promise.reject(new AppearanceError("DENIED"));
		oldSignal = signal;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	appearance = { client, status: nativeStatus };
	openFont();
	await settleFonts();
	assert.equal(
		find(driveForm(), (node) => node.props["data-font-catalog-state"] === "error").props["data-font-error"],
		"DENIED",
	);
	cleanup();
	await settleFonts();
	appearance = { client, status: nativeStatus };
	openFont();
	await settleFonts();
	assert.equal(calls, 1);
	const failed = driveForm();
	assert.equal(
		nodes(failed).some((node) => node.props.settingId === "installedFonts"),
		false,
	);
	const font = find(failed, (node) => node.props.label === "Font" && Array.isArray(node.props.options));
	assert.equal(typeof font.type, "function");
	const picker = (font.type as (props: Record<string, unknown>) => React.ReactNode)(font.props);
	const content = find(picker, (node) => node.type === SelectContent);
	assert.equal(
		find(content, (node) => node.props.role === "alert").props.children,
		"Font access was not allowed. You can enter a family name instead.",
	);
	const retry = find(content, (node) => node.type === SelectItem && node.props.children === "Retry font list");
	const beforeRetry = store.current;
	const updatesBeforeRetry = theme.update.mock.calls.length;
	(find(picker, (node) => node.type === Select).props.onValueChange as (value: string) => void)(
		String(retry.props.value),
	);
	assert.deepEqual(store.current, beforeRetry);
	assert.equal(theme.update.mock.calls.length, updatesBeforeRetry);
	await settleFonts();
	assert.equal(calls, 2);
	const freshList = vi.fn(async () => ({ families: [], truncated: false }));
	const fresh = fontClient(freshList);
	appearance = { client: fresh, status: nativeStatus };
	const switching = driveForm();
	assert.equal(
		nodes(switching).some((node) => node.props["data-font-error"] === "DENIED"),
		false,
	);
	await settleFonts();
	assert.equal(oldSignal?.aborted, true);
	assert.equal(freshList.mock.calls.length, 0);
	finish({ families: [], truncated: true });
	await settleFonts();
	assert.ok(find(driveForm(), (node) => node.props["data-font-catalog-state"] === "idle"));
	openFont();
	await settleFonts();
	const ready = find(driveForm(), (node) => node.props["data-font-catalog-state"] === "ready");
	assert.equal(ready.props["data-font-catalog-truncated"], false);
	assert.equal(freshList.mock.calls.length, 1);
	appearance = { client: fresh, status: { ...nativeStatus, platform: "macos" } };
	driveForm();
	await settleFonts();
	assert.equal(freshList.mock.calls.length, 1);
	assert.ok(find(driveForm(), (node) => node.props["data-font-catalog-state"] === "idle"));
	openFont();
	await settleFonts();
	assert.equal(freshList.mock.calls.length, 2);
});

test.each([
	["en", "Some installed fonts could not be listed. You can enter a family name instead."],
	["zh-CN", "部分已安装字体未能列出，你仍可输入字体名称。"],
] as const)(
	"native partial catalogs stay truthful inside the %s font picker without an extra settings row",
	async (locale, message) => {
		store.update({ ...store.current, locale });
		const face = {
			family: "Available Sans",
			fullName: "Available Sans Regular",
			postscriptName: "AvailableSans",
			style: "Regular",
		};
		const list = vi.fn(async () => ({
			families: [{ family: face.family, faces: [face], monospace: false }],
			truncated: true,
		}));
		appearance = { client: fontClient(list), status: { ...nativeStatus, platform: "macos" } };
		const label = locale === "en" ? "Font" : "字体";
		let tree = driveForm();
		const font = find(tree, (node) => node.props.label === label && Array.isArray(node.props.options));
		(font.props.onOpenChange as (open: boolean) => void)(true);
		driveForm();
		await settleFonts();
		tree = driveForm();
		assert.equal(list.mock.calls.length, 1);
		assert.equal(
			nodes(tree).some((node) => node.props.settingId === "installedFonts" || node.props.children === message),
			false,
		);
		const loaded = find(tree, (node) => node.props.label === label && Array.isArray(node.props.options));
		assert.equal(typeof loaded.type, "function");
		const picker = (loaded.type as (props: Record<string, unknown>) => React.ReactNode)(loaded.props);
		assert.ok(
			find(
				find(picker, (node) => node.type === SelectContent),
				(node) => node.props.children === message,
			),
		);
		assert.equal(loaded.props.action, undefined);
		(loaded.props.onChange as (value: string) => void)("installed:Available Sans");
		assert.deepEqual(store.current.localFontFaces.ui, face);
		assert.equal(
			find(tree, (node) => node.props["data-font-catalog-state"] === "ready").props["data-font-catalog-truncated"],
			true,
		);
	},
);

test("an unresolved native platform does not flash browser permission UI or bypass font loading ownership", async () => {
	const list = vi.fn(async () => ({ families: [], truncated: false }));
	const client = fontClient(list);
	appearance = { client };
	const initial = driveForm();
	assert.equal(
		nodes(initial).some((node) => node.props.settingId === "installedFonts"),
		false,
	);
	openFont();
	await settleFonts();
	assert.equal(list.mock.calls.length, 0);
	appearance = { client, status: { ...nativeStatus, platform: "windows" } };
	driveForm();
	driveForm();
	await settleFonts();
	const tree = driveForm();
	assert.equal(list.mock.calls.length, 1);
	const font = find(tree, (node) => node.props.label === "Font" && Array.isArray(node.props.options));
	assert.ok(
		find(
			font.props.notice as React.ReactNode,
			(node) =>
				node.props.children === "No supported installed fonts were returned. You can enter a family name instead.",
		),
	);
	assert.equal(
		nodes(tree).some((node) => node.props.settingId === "installedFonts"),
		false,
	);
});

test("native-only settings reflect actual host support and honor reduced-transparency status", () => {
	assert.equal(
		nodes(driveForm()).some((node) => node.props.settingId === "translucentSidebar"),
		false,
	);
	appearance.status = {
		version: 1,
		platform: "macos",
		backdrop: "vibrancy",
		backdropEnabled: false,
		reducedTransparency: true,
		fontSmoothing: true,
		themeMode: "system",
	};
	const tree = driveForm();
	const toggle = find(tree, (node) => node.type === "input" && node.props["aria-label"] === "Translucent sidebar");
	assert.equal(toggle.props.disabled, true);
	assert.ok(find(tree, (node) => node.props.settingId === "fontSmoothing"));
	const cursor = find(
		tree,
		(node) => node.type === "input" && node.props["aria-label"] === "Use pointer cursor for controls",
	);
	(cursor.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } });
	assert.equal(store.current.pointerCursor, false);
});
