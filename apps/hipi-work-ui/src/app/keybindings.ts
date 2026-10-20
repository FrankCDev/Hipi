export type BindingEvent = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
};

/** Configurable command syntax shared by app routing and both file editor engines. */
export function matchesBinding(
	event: BindingEvent,
	binding: string,
	isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
) {
	if (!binding.trim()) return false;
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

export const DEFAULT_APP_KEYBINDINGS = {
	reopenClosedFile: "Mod-Shift-t",
	pinConversation: "",
} as const;
export type AppKeybindings = { [K in keyof typeof DEFAULT_APP_KEYBINDINGS]: string };
