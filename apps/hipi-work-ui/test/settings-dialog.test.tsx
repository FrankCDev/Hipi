import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppClient, ModelCatalog } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as Radix from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import type { CredentialClient } from "../src/app/credential-client.ts";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { defaultConfig } from "../src/app/theme/config.ts";
import { themeStorageKey } from "../src/app/theme/store.ts";
import { SettingsDialog, type SettingsDialogProps } from "../src/features/settings/settings-dialog.tsx";

// Bypass browser-only portal and scroll locking. Keep the real modal composition and controls;
// focus trapping, scroll locking and nested-dialog focus restoration remain browser acceptance gates.
vi.mock("radix-ui", async (original) => {
	const actual = await original<typeof Radix>();
	return {
		...actual,
		Dialog: {
			...actual.Dialog,
			Portal: ({ children }: { children: ReactNode }) => children,
			Overlay: (props: ComponentProps<"div">) => <div {...props} />,
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

test("settings is one accessible centered modal with stable category navigation and an inline appearance form", () => {
	const html = render();
	assert.match(html, /role="dialog"/);
	assert.match(html, /data-placement="center"/);
	assert.match(html, /class="[^"]*unified-settings-dialog/);
	assert.match(html, /<nav class="settings-page-nav" aria-label="Settings categories">/);
	for (const category of ["appearance", "models", "runtime"]) {
		assert.match(html, new RegExp(`<button[^>]*data-category="${category}"`));
		assert.match(html, new RegExp(`<section[^>]*data-category="${category}"`));
	}
	assert.match(html, /data-category="appearance" aria-current="page"/);
	assert.match(html, /<h2 class="settings-page-heading" tabindex="-1"[^>]*>Appearance &amp; language<\/h2>/);
	assert.match(html, /type="search"[^>]*aria-label="Search settings"/);
	assert.match(html, /<section class="settings-page-content" aria-labelledby=/);
	assert.equal((html.match(/class="settings-form"/g) ?? []).length, 1);
	assert.match(html, /data-slot="dialog-close"[\s\S]*>Close settings<\/span>/);
	assert.equal(render({ open: false }), "");
});

test("appearance keeps full advanced settings behind progressive groups and save/cancel remain outside those groups", () => {
	const html = render();
	const firstDetails = html.indexOf('<details class="settings-advanced"');
	assert.ok(firstDetails > html.indexOf("settings-preferences"));
	assert.ok(firstDetails > html.indexOf("Code font"));
	assert.equal((html.match(/<details class="settings-advanced"/g) ?? []).length, 2);
	for (const text of [
		"Regional appearance",
		"Sidebar",
		"Messages",
		"Code editor and diff",
		"Import, export &amp; reset",
		"Export current JSON",
		"Preview JSON",
		"Preview defaults",
	])
		assert.ok(html.includes(text));
	assert.ok(html.indexOf("settings-savebar") > html.lastIndexOf("</details>"));
	assert.match(html, /settings-savebar[\s\S]*>Cancel<\/button>[\s\S]*>Save<\/button>/);
	assert.doesNotMatch(html, /role="switch"|Auto.install|autostart/i);
});

test("model section displays only returned providers/models and does not claim verified service or a global model setting", () => {
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
	assert.match(html, /Credentials configured \(service not verified\)/);
	assert.match(html, /actual-runtime-model/);
	assert.match(html, /validation-only/);
	assert.match(html, /Existing conversations keep their fixed model/);
	assert.match(html, /Credential management unavailable/);
	assert.doesNotMatch(html, /Default model|<option|type="password"|Runtime responded to the last check/);
	assert.match(html, /Not checked yet/);
});

test("credential storage messaging distinguishes memory, system and unavailable without reading or caching secrets", () => {
	for (const storage of ["memory", "system"] as const) {
		credentials = {
			storage,
			request: async () => {
				throw new Error("Rendering must not access credentials");
			},
		};
		const html = render();
		assert.ok(html.includes(storage === "memory" ? "Runtime memory only" : "System-protected storage"));
		assert.match(html, /Saved keys are never displayed or included in appearance exports/);
		assert.equal((html.match(/>Credential action<\/button>/g) ?? []).length, 1);
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
	assert.match(html, /分区外观/);
	const invalid = render({ stored: "broken" });
	assert.match(invalid, /已保存配置无效/);
	assert.match(invalid, /<details class="settings-advanced" data-setting="transfer" open="">/);
	assert.match(invalid, /导出被拒绝的原始数据/);
});

test("settings bounds its own modal and scrolls only the content area with a compact-screen layout", () => {
	const css = readFileSync(new URL("../src/features/settings/settings-page.css", import.meta.url), "utf8");
	assert.match(css, /width: min\(1060px, calc\(100vw - 48px\)\)/);
	assert.match(css, /\.settings-page-content\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
	assert.match(css, /\.settings-section\[hidden\]\s*\{\s*display: none;/);
	assert.match(css, /@media \(max-width: 520px\)/);
	assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|animation:/i);
});
