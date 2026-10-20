import darkPlus from "shiki/themes/dark-plus.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";
import solarizedDark from "shiki/themes/solarized-dark.mjs";
import solarizedLight from "shiki/themes/solarized-light.mjs";

export const codeThemeChoices = ["adaptive", "github", "vscode", "solarized"] as const;
export type CodeThemeChoice = (typeof codeThemeChoices)[number];
/** All resources are bundled statically. A setting never becomes a module path or remote theme URL. */
export const codeThemePairs = {
	adaptive: { light: "github-light", dark: "github-dark" },
	github: { light: "github-light", dark: "github-dark" },
	vscode: { light: "light-plus", dark: "dark-plus" },
	solarized: { light: "solarized-light", dark: "solarized-dark" },
} as const;
export const bundledCodeThemes = [githubLight, githubDark, lightPlus, darkPlus, solarizedLight, solarizedDark];
