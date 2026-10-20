/** Commands are configurable data, separate from structural tab/tree arrow-key navigation. */
export const DEFAULT_EDITOR_KEYBINDINGS = {
	save: "Mod-s",
	find: "Mod-f",
	replace: "Mod-Alt-f",
	goToLine: "Mod-Alt-g",
} as const;
export type FileEditorKeybindings = { save: string; find: string; replace?: string; goToLine?: string };

/** Shared configurable command syntax used by both editor engines. */
export function matchesEditorBinding(
	event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
	binding: string,
	isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
) {
	const parts = binding.toLowerCase().split("-");
	const key = parts.pop();
	const modifiers = new Set(parts);
	const control = modifiers.has("ctrl") || (modifiers.has("mod") && !isMac);
	const meta = modifiers.has("meta") || modifiers.has("cmd") || (modifiers.has("mod") && isMac);
	return (
		event.key.toLowerCase() === key &&
		event.ctrlKey === control &&
		event.metaKey === meta &&
		event.altKey === modifiers.has("alt") &&
		event.shiftKey === modifiers.has("shift")
	);
}
