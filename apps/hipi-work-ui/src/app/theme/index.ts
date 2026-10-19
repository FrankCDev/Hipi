export { applyTheme, themeVariables } from "./application.ts";
export {
	type ConfigError,
	type ConfigResult,
	defaultConfig,
	fonts,
	parseConfig,
	type Region,
	regions,
	type ThemeConfig,
	validateConfig,
} from "./config.ts";
export { ThemeProvider, useThemeSettings } from "./provider.tsx";
