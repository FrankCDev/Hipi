import type { AppearanceMode, ThemeConfig } from "./config.ts";

/**
 * Default palettes are tested at 95% tint over the full black-to-white backdrop range.
 * Custom colors retain their exact validated opaque pair; no wallpaper-dependent contrast claim.
 */
export function nativeSidebarTints(config: ThemeConfig, mode: AppearanceMode) {
	const settings = config.appearance[mode] ? 100 : 95;
	return { settings, sidebar: config.regions.sidebar?.background ? 100 : settings };
}
