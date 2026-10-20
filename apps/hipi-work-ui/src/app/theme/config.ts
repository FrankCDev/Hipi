import { type InstalledFontFace, parseInstalledFontFace } from "@hipi/work-runtime/appearance";
import { type CodeThemeChoice, codeThemeChoices } from "./code-theme-catalog.ts";

export const regions = ["sidebar", "messages", "editor"] as const;
export type Region = (typeof regions)[number];
// Platform UI faces and Latin code faces take precedence over the licensed CJK fallback.
export const fonts = {
	system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hipi Noto Sans SC", sans-serif',
	serif: 'Georgia, "Noto Serif SC", "Songti SC", SimSun, "Hipi Noto Sans SC", serif',
	mono: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", "Hipi Noto Sans SC", monospace',
} as const;
export type Font = keyof typeof fonts;
export type AppearanceMode = "light" | "dark";
export type AppearanceColors = { accent: string; background: string; foreground: string };
export type RegionConfig = { font?: Font; foreground?: string; background?: string };
export type ThemeConfig = {
	version: 2;
	locale: "zh-CN" | "en";
	mode: AppearanceMode | "system";
	uiFont: Font;
	contentFont: "inherit" | Font;
	codeFont: Font;
	customUiFont?: string;
	customContentFont?: string;
	customCodeFont?: string;
	localFontFaces: Partial<Record<"ui" | "content" | "code", InstalledFontFace>>;
	translucentSidebar: boolean;
	fontSmoothing: "system" | "antialiased";
	pointerCursor: boolean;
	codeTheme: CodeThemeChoice;
	uiFontSize: number;
	codeFontSize: number;
	reducedMotion: "system" | "on" | "off";
	appearance: Partial<Record<AppearanceMode, AppearanceColors>>;
	regions: Partial<Record<Region, RegionConfig>>;
};
// Share the supported ranges with controls; spinner steps do not prohibit fractional values.
export const fontSizeBounds = {
	ui: { min: 11, max: 16, step: 1 },
	code: { min: 8, max: 24, step: 1 },
} as const;
export function defaultAppearance(mode: AppearanceMode): AppearanceColors {
	return mode === "dark"
		? { accent: "#a8b7ff", background: "#181818", foreground: "#dfdfdf" }
		: { accent: "#3b57cc", background: "#ffffff", foreground: "#1a1c1f" };
}
export function defaultConfig(): ThemeConfig {
	return {
		version: 2,
		locale: "zh-CN",
		mode: "system",
		uiFont: "system",
		contentFont: "inherit",
		codeFont: "mono",
		localFontFaces: {},
		translucentSidebar: false,
		fontSmoothing: "antialiased",
		pointerCursor: true,
		codeTheme: "adaptive",
		uiFontSize: 14,
		codeFontSize: 12,
		reducedMotion: "system",
		appearance: {},
		regions: {},
	};
}
export type ConfigError = "format" | "version" | "contrast";
export type ConfigResult = { ok: true; value: ThemeConfig } | { ok: false; error: ConfigError };
function record(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Object.getOwnPropertySymbols(value).length === 0 &&
		Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)
	);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
	return Object.getOwnPropertyNames(value).every((key) => allowed.includes(key));
}
function font(value: unknown): value is Font {
	return value === "system" || value === "serif" || value === "mono";
}
function fontFamily(value: unknown): value is string {
	// A single installed family, not a CSS font stack, URL, escape, or declaration.
	return typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._'+-]{0,79}$/u.test(value);
}
function fontSize(value: unknown, kind: keyof typeof fontSizeBounds): value is number {
	const bounds = fontSizeBounds[kind];
	return typeof value === "number" && Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}
function color(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
export function contrastRatio(a: string, b: string): number {
	if (!color(a) || !color(b)) return 0;
	const luminance = (hex: string) => {
		const rgb = [1, 3, 5].map((offset) => {
			const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		});
		return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
	};
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Migrates v1 data without discarding region overrides. Values never become arbitrary CSS. */
export function validateConfig(input: unknown): ConfigResult {
	if (!record(input)) return { ok: false, error: "format" };
	if (input.version !== 1 && input.version !== 2) return { ok: false, error: "version" };
	const baseKeys = ["version", "locale", "mode", "uiFont", "codeFont", "regions"];
	if (
		!keys(
			input,
			input.version === 1
				? baseKeys
				: [
						...baseKeys,
						"customUiFont",
						"contentFont",
						"customContentFont",
						"customCodeFont",
						"uiFontSize",
						"codeFontSize",
						"reducedMotion",
						"appearance",
						"localFontFaces",
						"translucentSidebar",
						"fontSmoothing",
						"pointerCursor",
						"codeTheme",
					],
		) ||
		(input.locale !== "en" && input.locale !== "zh-CN") ||
		(input.mode !== "light" && input.mode !== "dark" && input.mode !== "system") ||
		!font(input.uiFont) ||
		!font(input.codeFont) ||
		!record(input.regions) ||
		!keys(input.regions, regions)
	)
		return { ok: false, error: "format" };
	const overrides: ThemeConfig["regions"] = {};
	for (const region of regions) {
		const item = input.regions[region];
		if (item === undefined) continue;
		if (
			!record(item) ||
			!keys(item, ["font", "foreground", "background"]) ||
			(item.font !== undefined && !font(item.font))
		)
			return { ok: false, error: "format" };
		const result: RegionConfig = {};
		if (font(item.font)) result.font = item.font;
		if (item.foreground !== undefined || item.background !== undefined) {
			if (!color(item.foreground) || !color(item.background)) return { ok: false, error: "format" };
			if (contrastRatio(item.foreground, item.background) < 4.5) return { ok: false, error: "contrast" };
			result.foreground = item.foreground;
			result.background = item.background;
		}
		overrides[region] = result;
	}
	const config: ThemeConfig = {
		...defaultConfig(),
		locale: input.locale,
		mode: input.mode,
		uiFont: input.uiFont,
		codeFont: input.codeFont,
		regions: overrides,
	};
	if (input.version === 1) return { ok: true, value: config };
	if (
		(input.translucentSidebar !== undefined && typeof input.translucentSidebar !== "boolean") ||
		(input.pointerCursor !== undefined && typeof input.pointerCursor !== "boolean") ||
		(input.fontSmoothing !== undefined && input.fontSmoothing !== "system" && input.fontSmoothing !== "antialiased") ||
		(input.codeTheme !== undefined && !codeThemeChoices.some((choice) => choice === input.codeTheme))
	)
		return { ok: false, error: "format" };
	if (input.localFontFaces !== undefined) {
		if (!record(input.localFontFaces) || !keys(input.localFontFaces, ["ui", "content", "code"]))
			return { ok: false, error: "format" };
		try {
			for (const area of ["ui", "content", "code"] as const) {
				const face = input.localFontFaces[area];
				if (face !== undefined) config.localFontFaces[area] = parseInstalledFontFace(face);
			}
		} catch {
			return { ok: false, error: "format" };
		}
	}
	if (typeof input.translucentSidebar === "boolean") config.translucentSidebar = input.translucentSidebar;
	if (typeof input.pointerCursor === "boolean") config.pointerCursor = input.pointerCursor;
	if (input.fontSmoothing === "system" || input.fontSmoothing === "antialiased")
		config.fontSmoothing = input.fontSmoothing;
	if (codeThemeChoices.some((choice) => choice === input.codeTheme))
		config.codeTheme = input.codeTheme as CodeThemeChoice;
	if (
		!fontSize(input.uiFontSize, "ui") ||
		!fontSize(input.codeFontSize, "code") ||
		(input.contentFont !== "inherit" && !font(input.contentFont)) ||
		(input.reducedMotion !== "system" && input.reducedMotion !== "on" && input.reducedMotion !== "off") ||
		(input.customUiFont !== undefined && !fontFamily(input.customUiFont)) ||
		(input.customContentFont !== undefined && !fontFamily(input.customContentFont)) ||
		(input.customCodeFont !== undefined && !fontFamily(input.customCodeFont)) ||
		!record(input.appearance) ||
		!keys(input.appearance, ["light", "dark"])
	)
		return { ok: false, error: "format" };
	for (const mode of ["light", "dark"] as const) {
		const appearance = input.appearance[mode];
		if (appearance === undefined) continue;
		if (
			!record(appearance) ||
			!keys(appearance, ["accent", "background", "foreground"]) ||
			!color(appearance.accent) ||
			!color(appearance.background) ||
			!color(appearance.foreground)
		)
			return { ok: false, error: "format" };
		if (contrastRatio(appearance.foreground, appearance.background) < 4.5) return { ok: false, error: "contrast" };
		config.appearance[mode] = {
			accent: appearance.accent,
			background: appearance.background,
			foreground: appearance.foreground,
		};
	}
	config.uiFontSize = input.uiFontSize;
	config.codeFontSize = input.codeFontSize;
	config.reducedMotion = input.reducedMotion;
	config.contentFont = input.contentFont;
	if (input.customUiFont !== undefined) config.customUiFont = input.customUiFont;
	if (input.customContentFont !== undefined) config.customContentFont = input.customContentFont;
	if (input.customCodeFont !== undefined) config.customCodeFont = input.customCodeFont;
	return { ok: true, value: config };
}
export function parseConfig(raw: string): ConfigResult {
	if (raw.length > 16384 || new TextEncoder().encode(raw).byteLength > 16384) return { ok: false, error: "format" };
	try {
		return validateConfig(JSON.parse(raw));
	} catch {
		return { ok: false, error: "format" };
	}
}
const sharePrefix = "hipi-theme:";
export function exportAppearanceShare(config: ThemeConfig): string {
	const result = validateConfig(config);
	if (!result.ok) throw new TypeError(`Invalid theme: ${result.error}`);
	const bytes = new TextEncoder().encode(JSON.stringify(result.value));
	return (
		sharePrefix +
		btoa(String.fromCharCode(...bytes))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "")
	);
}
export function parseAppearanceShare(raw: string): ConfigResult {
	if (raw.length > 22000) return { ok: false, error: "format" };
	const value = raw.trim();
	if (!value.startsWith(sharePrefix)) return { ok: false, error: "format" };
	const payload = value.slice(sharePrefix.length);
	if (!/^[A-Za-z0-9_-]+$/.test(payload)) return { ok: false, error: "format" };
	try {
		const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return parseConfig(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return { ok: false, error: "format" };
	}
}
