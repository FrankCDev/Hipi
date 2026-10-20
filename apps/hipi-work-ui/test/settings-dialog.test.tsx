import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppClient, ModelCatalog } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as Radix from "radix-ui";
import { type ComponentProps, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import type { CredentialClient } from "../src/app/credential-client.ts";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { defaultConfig } from "../src/app/theme/config.ts";
import { themeStorageKey } from "../src/app/theme/store.ts";
import type { DialogContent } from "../src/components/ui/dialog.tsx";
import { SettingsDialog, type SettingsDialogProps } from "../src/features/settings/settings-dialog.tsx";
import { SettingsSurface } from "../src/features/settings/settings-surface.tsx";

// Render portal contents for SSR inspection, omitting the browser-only dimmer/scroll-lock.
// Keep the real modal content and controls. Overlay paint, focus trapping, scroll locking and
// nested-dialog focus restoration remain native browser acceptance gates.
vi.mock("radix-ui", async (original) => {
	const actual = await original<typeof Radix>();
	return {
		...actual,
		Dialog: {
			...actual.Dialog,
			Portal: ({ children }: { children: ReactNode }) => children,
			Overlay: () => null,
		},
	};
});
const client: AppClient = {
	async call() {
		throw new Error("Presentation rendering must not call the runtime");
	},
	async observe() {
		throw new Error("Settings must not start conversation observation");
	},
};
let credentials: CredentialClient | undefined;
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => client,
	useCredentialClient: () => credentials,
	useFiles: () => ({}),
}));
afterEach(() => {
	credentials = undefined;
	vi.unstubAllGlobals();
});

function render({
	locale = "en",
	catalog,
	stored,
	...props
}: Partial<SettingsDialogProps> & { locale?: "en" | "zh-CN"; catalog?: ModelCatalog; stored?: string } = {}) {
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) =>
				key === themeStorageKey ? (stored ?? JSON.stringify({ ...defaultConfig(), locale })) : null,
		},
	});
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	cache.setQueryData(["custom-providers"], { providers: [] });
	if (catalog) cache.setQueryData(["models"], catalog);
	try {
		return renderToStaticMarkup(
			<PreferencesProvider>
				<QueryClientProvider client={cache}>
					<SettingsDialog
						open
						onOpenChange={() => {}}
						credentialSettings={<button type="button">Credential action</button>}
						runtimeActions={<button type="button">Runtime action</button>}
						{...props}
					/>
				</QueryClientProvider>
			</PreferencesProvider>,
		);
	} finally {
		cache.clear();
	}
}

test("settings is one bounded named modal with fixed categories, close and inline preferences", () => {
	const html = render();
	assert.equal((html.match(/role="dialog"/g) ?? []).length, 1);
	assert.match(html, /data-settings-surface="true"/);
	assert.match(html, /data-slot="dialog-title"[^>]*>Settings<\/h2>/);
	assert.match(html, /data-slot="dialog-close"/);
	assert.match(html, /Close settings/);
	assert.doesNotMatch(html, /settings-route|Back to app/);
	assert.match(html, /<nav class="settings-page-nav" aria-label="Settings categories">/);
	for (const category of ["general", "appearance", "models", "runtime"]) {
		assert.match(html, new RegExp(`<button[^>]*data-category="${category}"`));
		assert.match(html, new RegExp(`<section[^>]*data-category="${category}"`));
	}
	assert.match(html, /data-category="general" aria-current="page"/);
	assert.match(html, /<h2 class="settings-page-heading" tabindex="-1"[^>]*>General<\/h2>/);
	assert.match(html, /type="search"[^>]*aria-label="Search settings"/);
	assert.equal((html.match(/class="settings-form"/g) ?? []).length, 2);
	assert.equal(render({ open: false }), "");
	assert.match(render({ initialCategory: "models" }), /data-category="models" aria-current="page"/);
});

test("appearance exposes supported immediate controls without staged editing or invented capabilities", () => {
	const html = render();
	for (const text of [
		"Visual style",
		"Advanced",
		"UI font size",
		"Code font size",
		"Reduced motion",
		"Copy theme",
		"Import theme",
	])
		assert.ok(html.includes(text), text);
	assert.match(html, /role="radiogroup" aria-label="Theme"/);
	assert.match(html, /<details class="settings-advanced" data-setting="advanced">/);
	assert.ok(html.indexOf("settings-advanced-body") < html.indexOf("UI font size"));
	assert.doesNotMatch(html, /Reset to default/);
	assert.match(html, /type="number"[^>]*min="[^"]+"[^>]*max="[^"]+"[^>]*step="1"/);
	assert.doesNotMatch(
		html,
		/settings-savebar|Unsaved|Preview JSON|Settings JSON|Regional appearance|Save<\/button>|Cancel<\/button>/,
	);
	assert.doesNotMatch(html, /Auto.install|autostart|Subscription|Translucent sidebar|Font smoothing/);
});

test("model section has one service list with real status and no separate credential/catalog dump", () => {
	const html = render({
		catalog: {
			providers: [
				{ provider: "openai", name: "OpenAI", credentialState: "missing" },
				{ provider: "faux", name: "Deterministic validation", credentialState: "configured" },
			],
			models: [
				{ provider: "openai", modelId: "actual-runtime-model", name: "Runtime model" },
				{ provider: "faux", modelId: "validation-only", name: "Fixture model" },
			],
		},
	});
	assert.match(html, /data-state="missing"/);
	assert.match(html, /Key saved · unverified/);
	assert.match(html, /data-setting="provider:openai"/);
	assert.match(html, /Model services/);
	assert.match(html, /Add service/);
	assert.doesNotMatch(
		html,
		/actual-runtime-model|validation-only|Credential storage|Available models|Credential action/,
	);
	assert.doesNotMatch(html, /Default model|<option|type="password"|Runtime responded to the last check/);
	assert.match(html, /Not checked yet/);
});

test("the settings shell never reads credentials or exposes a redundant credential-management entry", () => {
	for (const storage of ["memory", "system"] as const) {
		credentials = {
			storage,
			request: async () => {
				throw new Error("Rendering must not access credentials");
			},
		};
		const html = render();
		assert.doesNotMatch(html, /Credential action|type="password"|Only official OpenAI|仅支持官方 OpenAI/);
	}
});

test("workspace package action has an explicit workspace scope and is absent without a selected workspace", () => {
	const workspaceActions = <button type="button">Workspace package action</button>;
	assert.doesNotMatch(render({ workspaceActions }), /Workspace package action/);
	const html = render({ workspace: { workspaceId: "workspace", name: "Design project" }, workspaceActions });
	assert.match(html, /Design project/);
	assert.match(html, /individual conversations, not to global settings/);
	assert.match(html, /This connection does not provide file browsing/);
	assert.match(html, /Select a conversation to review its Agent permissions and tool packs/);
	assert.equal((html.match(/>Workspace package action<\/button>/g) ?? []).length, 1);
	assert.doesNotMatch(html, /Return to conversation|Manage workspace files<\/button>/);
});

test("Chinese labels and rejected appearance recovery remain available", () => {
	const html = render({ locale: "zh-CN" });
	assert.match(html, /设置分类/);
	assert.match(html, /模型与凭据/);
	assert.match(html, /运行时与数据/);
	assert.match(html, /视觉样式/);
	assert.match(html, /常规/);
	const invalid = render({ stored: "broken" });
	assert.match(invalid, /已保存配置无效/);
	assert.match(invalid, /data-setting="advanced"/);
	assert.match(invalid, /导出被拒绝的原始数据/);
});

test("settings modal bounds both axes and preserves independent scrolling and responsive controls", () => {
	const css = readFileSync(new URL("../src/features/settings/settings-page.css", import.meta.url), "utf8");
	assert.match(
		css,
		/\.settings-modal\[data-slot="dialog-content"\]\s*\{[^}]*width: min\(1000px, calc\(100vw - 48px\)\)/,
	);
	assert.match(css, /height: min\(720px, calc\(100dvh - 48px\)\)/);
	assert.match(css, /\.settings-page-sidebar\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
	assert.match(css, /\.settings-page-content\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
	assert.match(css, /\.settings-section\[hidden\]\s*\{\s*display: none;/);
	assert.match(css, /\.settings-modal \.settings-form\s*\{[^}]*gap: 0;/);
	assert.match(css, /\.settings-theme-options\s*\{[^}]*width: 272px;[^}]*gap: 16px;/);
	assert.match(css, /\.settings-size-input\s*\{[^}]*width: 64px;/);
	assert.match(css, /@media \(max-width: 600px\)/);
	assert.doesNotMatch(css, /settings-route|settings-page-toolbar|settings-savebar|settings-unsaved-dialog/);
});

test("shared settings surface preserves exact opener focus and blocks dismissal during protected mutations or IME", () => {
	const changed = vi.fn();
	const restored = vi.fn();
	const focused = vi.fn();
	const escaped = vi.fn();
	const renderSurface = (busy = false) =>
		SettingsSurface({
			open: true,
			onOpenChange: changed,
			onRestoreFocus: restored,
			initialFocus: { current: { focus: focused } as unknown as HTMLElement },
			title: "Settings",
			closeLabel: "Close settings",
			onEscapeKeyDown: escaped,
			busy,
			children: "Content",
		});
	const root = renderSurface();
	const panel = root.props.children;
	assert.ok(isValidElement<ComponentProps<typeof DialogContent>>(panel));
	const preventDefault = vi.fn();
	panel.props.onOpenAutoFocus?.({ preventDefault } as unknown as Event);
	assert.equal(focused.mock.calls.length, 1);
	panel.props.onCloseAutoFocus?.({ preventDefault } as unknown as Event);
	assert.equal(restored.mock.calls.length, 1);
	assert.equal(preventDefault.mock.calls.length, 2);
	panel.props.onEscapeKeyDown?.({ isComposing: true, preventDefault } as unknown as KeyboardEvent);
	panel.props.onEscapeKeyDown?.({ keyCode: 229, preventDefault } as unknown as KeyboardEvent);
	assert.equal(escaped.mock.calls.length, 0);
	panel.props.onEscapeKeyDown?.({ preventDefault } as unknown as KeyboardEvent);
	assert.equal(escaped.mock.calls.length, 1);
	const busy = renderSurface(true);
	busy.props.onOpenChange?.(false);
	assert.equal(changed.mock.calls.length, 0);
	const busyPanel = busy.props.children;
	assert.ok(isValidElement<ComponentProps<typeof DialogContent>>(busyPanel));
	assert.equal(busyPanel.props.closeDisabled, true);
	busyPanel.props.onEscapeKeyDown?.({ preventDefault } as unknown as KeyboardEvent);
	assert.equal(escaped.mock.calls.length, 1);
	root.props.onOpenChange?.(false);
	assert.deepEqual(changed.mock.calls, [[false]]);
});
