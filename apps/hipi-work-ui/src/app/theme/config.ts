export const regions = ["sidebar", "messages", "editor"] as const;
export type Region = (typeof regions)[number];
export const fonts = {
	system:
		'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", "Hipi Noto Sans SC", sans-serif',
	serif: 'Georgia, "Noto Serif SC", "Songti SC", SimSun, "Hipi Noto Sans SC", serif',
	mono: '"SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Hipi Noto Sans SC", monospace',
} as const;
export type Font = keyof typeof fonts;
export type RegionConfig = { font?: Font; foreground?: string; background?: string };
export type ThemeConfig = {
	version: 1;
	locale: "zh-CN" | "en";
	mode: "light" | "dark" | "system";
	uiFont: Font;
	codeFont: Font;
	regions: Partial<Record<Region, RegionConfig>>;
};
export function defaultConfig(): ThemeConfig {
	return { version: 1, locale: "zh-CN", mode: "system", uiFont: "system", codeFont: "mono", regions: {} };
}
export type ConfigError = "format" | "version" | "contrast";
export type ConfigResult = { ok: true; value: ThemeConfig } | { ok: false; error: ConfigError };
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function font(value: unknown): value is Font {
	return value === "system" || value === "serif" || value === "mono";
}
function color(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
export function contrastRatio(a: string, b: string): number {
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
/** Colors are paired, never interpreted as CSS, resources or executable code. */
export function validateConfig(input: unknown): ConfigResult {
	if (!record(input)) return { ok: false, error: "format" };
	if (input.version !== 1) return { ok: false, error: "version" };
	if (
		!keys(input, ["version", "locale", "mode", "uiFont", "codeFont", "regions"]) ||
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
	return {
		ok: true,
		value: {
			version: 1,
			locale: input.locale,
			mode: input.mode,
			uiFont: input.uiFont,
			codeFont: input.codeFont,
			regions: overrides,
		},
	};
}
export function parseConfig(raw: string): ConfigResult {
	if (raw.length > 16384 || new TextEncoder().encode(raw).byteLength > 16384) return { ok: false, error: "format" };
	try {
		return validateConfig(JSON.parse(raw));
	} catch {
		return { ok: false, error: "format" };
	}
}
