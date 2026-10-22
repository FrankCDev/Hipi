import {
	type AppearanceColors,
	type AppearanceMode,
	contrastRatio,
	fonts,
	regions,
	type ThemeConfig,
} from "./config.ts";
import { localFaceFamily } from "./local-font-faces.ts";

function mix(base: string, tint: string, amount: number): string {
	return `#${[1, 3, 5]
		.map((offset) => {
			const a = Number.parseInt(base.slice(offset, offset + 2), 16);
			const b = Number.parseInt(tint.slice(offset, offset + 2), 16);
			return Math.round(a + (b - a) * amount)
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;
}
function onColor(background: string): string {
	return contrastRatio("#000000", background) >= contrastRatio("#ffffff", background) ? "#000000" : "#ffffff";
}
function appearanceVariables(colors: AppearanceColors, mode: AppearanceMode): Record<string, string> {
	const { background, foreground, accent } = colors;
	// Near-threshold custom pairs must remain readable when deriving elevated surfaces.
	const surface = (candidate: string) => (contrastRatio(foreground, candidate) >= 4.5 ? candidate : background);
	const surfaces = {
		"--surface": background,
		"--canvas": surface(mix(background, foreground, 0.02)),
		"--sidebar": surface(mix(background, foreground, 0.04)),
		"--raised": background,
		"--brand-soft": surface(mix(background, accent, 0.08)),
		"--disabled-surface": surface(mix(background, foreground, 0.06)),
		"--warning-soft": surface(mix(background, "#b7791f", 0.08)),
	};
	const readable = (candidate: string, minimum = 4.5) =>
		Object.values(surfaces).every((value) => contrastRatio(candidate, value) >= minimum) ? candidate : foreground;
	const brandForeground = onColor(accent);
	const danger = readable(mode === "dark" ? "#f0a0a3" : "#b2383c");
	const dangerForeground = onColor(danger);
	return {
		...surfaces,
		"--text": foreground,
		"--ui-hover-foreground": foreground,
		"--muted": readable(mix(foreground, background, 0.25)),
		"--line": mix(background, foreground, 0.2),
		"--brand": accent,
		"--accent-text": readable(accent),
		"--brand-hover": mix(accent, brandForeground === "#000000" ? "#ffffff" : "#000000", 0.1),
		"--on-brand": brandForeground,
		"--focus": readable(accent, 3),
		"--disabled-text": readable(mix(foreground, background, 0.25)),
		"--disabled-line": mix(background, foreground, 0.24),
		"--warning": readable(mode === "dark" ? "#ebc987" : "#805418"),
		"--danger": danger,
		"--on-danger": dangerForeground,
		"--danger-hover": mix(danger, dangerForeground === "#000000" ? "#ffffff" : "#000000", 0.1),
	};
}
export function themeVariables(
	config: ThemeConfig,
	mode: AppearanceMode = config.mode === "dark" ? "dark" : "light",
): Record<string, string> {
	const uiBase = config.customUiFont ? `"${config.customUiFont}", ${fonts[config.uiFont]}` : fonts[config.uiFont];
	const uiFont = config.localFontFaces.ui ? `${localFaceFamily(config.localFontFaces.ui)}, ${uiBase}` : uiBase;
	const codeBase = config.customCodeFont
		? `"${config.customCodeFont}", ${fonts[config.codeFont]}`
		: fonts[config.codeFont];
	const codeFont = config.localFontFaces.code
		? `${localFaceFamily(config.localFontFaces.code)}, ${codeBase}`
		: codeBase;
	const contentFallback = config.contentFont === "inherit" ? uiFont : fonts[config.contentFont];
	const contentBase = config.customContentFont ? `"${config.customContentFont}", ${contentFallback}` : contentFallback;
	const contentFont = config.localFontFaces.content
		? `${localFaceFamily(config.localFontFaces.content)}, ${contentBase}`
		: contentBase;
	const variables: Record<string, string> = {
		"--font-ui": uiFont,
		"--font-content": contentFont,
		"--font-code": codeFont,
		"--font-mono": codeFont,
		"--font-ui-size": `${config.uiFontSize}px`,
		// Small UI text scales from 13px at the 14px default, rounded to whole pixels.
		"--font-ui-small-size": `${Math.round(13 * (config.uiFontSize / 14))}px`,
		"--font-code-size": `${config.codeFontSize}px`,
		"--font-smoothing": config.fontSmoothing === "antialiased" ? "antialiased" : "auto",
		"--action-cursor": config.pointerCursor ? "pointer" : "default",
	};
	const appearance = config.appearance[mode];
	if (appearance) Object.assign(variables, appearanceVariables(appearance, mode));
	for (const region of regions) {
		const override = config.regions[region];
		variables[`--${region}-font`] = override?.font
			? fonts[override.font]
			: region === "editor"
				? codeFont
				: region === "messages"
					? contentFont
					: uiFont;
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
	style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> &
		Partial<Pick<CSSStyleDeclaration, "getPropertyValue" | "getPropertyPriority">>;
};
type SystemPreference = {
	matches: boolean;
	addEventListener: (type: "change", listener: () => void) => void;
	removeEventListener: (type: "change", listener: () => void) => void;
};
/** Owns theme variables and only the system subscriptions requested by the configuration. */
export function applyTheme(
	config: ThemeConfig,
	root: ThemeTarget,
	media?: SystemPreference,
	motionMedia?: SystemPreference,
) {
	const previousLang = root.lang;
	const previousData = new Map<string, string | undefined>();
	for (const key of ["theme", "reducedMotion", ...regions.map((region) => `${region}Colors`)])
		previousData.set(key, root.dataset[key]);
	const previousVariables = new Map<string, { value: string; priority: string }>();
	let activeVariables = new Set<string>();
	const restoreVariable = (key: string) => {
		const previous = previousVariables.get(key);
		if (previous?.value) root.style.setProperty(key, previous.value, previous.priority);
		else root.style.removeProperty(key);
	};
	const apply = () => {
		const mode = config.mode === "system" ? (media?.matches ? "dark" : "light") : config.mode;
		root.dataset.theme = mode;
		const variables = themeVariables(config, mode);
		for (const key of activeVariables) if (!(key in variables)) restoreVariable(key);
		for (const [key, value] of Object.entries(variables)) {
			if (!previousVariables.has(key))
				previousVariables.set(key, {
					value: root.style.getPropertyValue?.(key) ?? "",
					priority: root.style.getPropertyPriority?.(key) ?? "",
				});
			root.style.setProperty(key, value);
		}
		activeVariables = new Set(Object.keys(variables));
	};
	const applyMotion = () => {
		root.dataset.reducedMotion =
			config.reducedMotion === "system" ? (motionMedia?.matches ? "on" : "off") : config.reducedMotion;
	};
	apply();
	applyMotion();
	root.lang = config.locale;
	for (const region of regions)
		root.dataset[`${region}Colors`] = config.regions[region]?.foreground ? "custom" : "default";
	if (config.mode === "system") media?.addEventListener("change", apply);
	if (config.reducedMotion === "system") motionMedia?.addEventListener("change", applyMotion);
	return () => {
		if (config.mode === "system") media?.removeEventListener("change", apply);
		if (config.reducedMotion === "system") motionMedia?.removeEventListener("change", applyMotion);
		for (const key of previousVariables.keys()) restoreVariable(key);
		root.lang = previousLang;
		for (const [key, previous] of previousData) {
			if (previous === undefined) delete root.dataset[key];
			else root.dataset[key] = previous;
		}
	};
}
