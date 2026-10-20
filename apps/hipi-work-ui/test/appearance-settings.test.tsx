import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import { PreferencesProvider, usePreferences } from "../src/app/preferences.tsx";
import { defaultConfig } from "../src/app/theme/config.ts";
import { themeStorageKey } from "../src/app/theme/store.ts";
import { AppearanceSettings, SettingsForm } from "../src/features/settings/appearance-settings.tsx";

afterEach(() => vi.unstubAllGlobals());
function TranslationProbe() {
	const { locale, t } = usePreferences();
	return <p lang={locale}>{t("common.cancel")}</p>;
}
test("production provider restores locale from versioned storage for existing UI and settings controls", () => {
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => (key === themeStorageKey ? JSON.stringify({ ...defaultConfig(), locale: "en" }) : null),
		},
	});
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<TranslationProbe />
			<AppearanceSettings />
			<SettingsForm />
		</PreferencesProvider>,
	);
	assert.match(html, /lang="en">Cancel/);
	assert.match(html, /Appearance and language/);
	assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
	assert.match(html, /role="combobox"/);
	assert.match(html, /Copy theme/);
	assert.match(html, /Import theme/);
	assert.match(html, /Code font size/);
	assert.match(html, /aria-label="UI font size"[^>]*min="11"[^>]*max="16"[^>]*step="1"/);
	assert.match(html, /aria-label="Code font size"[^>]*min="8"[^>]*max="24"[^>]*step="1"[^>]*value="12"/);
	assert.match(html, /class="settings-control-group settings-mode-group"/);
	assert.match(html, /<details class="settings-advanced" data-setting="advanced">/);
	assert.doesNotMatch(html, /settings-savebar|Settings JSON/);
});
test("bad saved data renders recovery notice and original export, while denied storage renders honest memory notice", () => {
	vi.stubGlobal("window", { localStorage: { getItem: (key: string) => (key === themeStorageKey ? "broken" : null) } });
	const render = () =>
		renderToStaticMarkup(
			<PreferencesProvider>
				<AppearanceSettings />
				<SettingsForm />
			</PreferencesProvider>,
		);
	assert.match(render(), /已保存配置无效/);
	assert.match(render(), /导出被拒绝的原始数据/);
	vi.stubGlobal("window", {
		get localStorage() {
			throw new Error("denied");
		},
	});
	assert.match(render(), /无法访问持久存储/);
});
