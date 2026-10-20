/** Commands are configurable data, separate from structural tab/tree arrow-key navigation. */
export { matchesBinding as matchesEditorBinding } from "../../app/keybindings.ts";

export const DEFAULT_EDITOR_KEYBINDINGS = {
	save: "Mod-s",
	find: "Mod-f",
	replace: "Mod-Alt-f",
	goToLine: "Mod-Alt-g",
} as const;
export type FileEditorKeybindings = { save: string; find: string; replace?: string; goToLine?: string };
