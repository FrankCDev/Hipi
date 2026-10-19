import { fonts, regions, type ThemeConfig } from "./config.ts";

export function themeVariables(config: ThemeConfig): Record<string, string> {
	const variables: Record<string, string> = {
		"--font-ui": fonts[config.uiFont],
		"--font-code": fonts[config.codeFont],
		"--font-mono": fonts[config.codeFont],
	};
	for (const region of regions) {
		const override = config.regions[region];
		variables[`--${region}-font`] = fonts[override?.font ?? (region === "editor" ? config.codeFont : config.uiFont)];
		if (override?.foreground && override.background) {
			variables[`--${region}-foreground`] = override.foreground;
			variables[`--${region}-background`] = override.background;
		}
	}
	return variables;
}
type ThemeTarget = {
	lang: string;
	dataset: Record<string, string | undefined>;
	style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
};
type SystemTheme = {
	matches: boolean;
	addEventListener: (type: "change", listener: () => void) => void;
	removeEventListener: (type: "change", listener: () => void) => void;
};
/** Owns only theme variables and its media subscription; cleanup allows cancel and remount. */
export function applyTheme(config: ThemeConfig, root: ThemeTarget, media?: SystemTheme) {
	const previousLang = root.lang;
	const previousMode = root.dataset.theme;
	const apply = () => {
		root.dataset.theme = config.mode === "system" ? (media?.matches ? "dark" : "light") : config.mode;
	};
	apply();
	root.lang = config.locale;
	const variables = themeVariables(config);
	for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
	for (const region of regions)
		root.dataset[`${region}Colors`] = config.regions[region]?.foreground ? "custom" : "default";
	media?.addEventListener("change", apply);
	return () => {
		media?.removeEventListener("change", apply);
		for (const key of Object.keys(variables)) root.style.removeProperty(key);
		for (const region of regions) delete root.dataset[`${region}Colors`];
		root.lang = previousLang;
		if (previousMode === undefined) delete root.dataset.theme;
		else root.dataset.theme = previousMode;
	};
}
