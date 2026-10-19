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
			<SettingsForm onSave={() => {}} onCancel={() => {}} />
		</PreferencesProvider>,
	);
	assert.match(html, /lang="en">Cancel/);
	assert.match(html, /Appearance and language/);
	assert.match(html, /aria-haspopup="dialog"/);
	assert.match(html, /role="combobox"/);
	assert.match(html, /Export current JSON/);
	assert.match(html, /Preview JSON/);
	assert.match(html, /Code editor and diff/);
});
test("bad saved data renders recovery notice and original export, while denied storage renders honest memory notice", () => {
	vi.stubGlobal("window", { localStorage: { getItem: (key: string) => (key === themeStorageKey ? "broken" : null) } });
	const render = () =>
		renderToStaticMarkup(
			<PreferencesProvider>
				<AppearanceSettings />
				<SettingsForm onSave={() => {}} onCancel={() => {}} />
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
