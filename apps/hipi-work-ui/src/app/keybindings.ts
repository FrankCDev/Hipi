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
	// Desktop reference assigns Mod-K to its broader command menu, not this search-only command.
	searchConversations: "",
	moveSidebarUp: "Alt-ArrowUp",
	moveSidebarDown: "Alt-ArrowDown",
	cancelSidebarMove: "Escape",
	previousSidebarItem: "Mod-Alt-[",
	previousSidebarItemAlternate: "Mod-Alt-ArrowLeft",
	nextSidebarItem: "Mod-Alt-]",
	nextSidebarItemAlternate: "Mod-Alt-ArrowRight",
} as const;
export type AppKeybindings = { [K in keyof typeof DEFAULT_APP_KEYBINDINGS]: string };

/** Display the configured chord only; an unbound action must not imply a shortcut. */
export function formatBinding(
	binding: string,
	isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
) {
	const labels: Record<string, string> = {
		mod: isMac ? "⌘" : "Ctrl",
		meta: isMac ? "⌘" : "Meta",
		cmd: "⌘",
		ctrl: isMac ? "⌃" : "Ctrl",
		alt: isMac ? "⌥" : "Alt",
		shift: isMac ? "⇧" : "Shift",
		arrowleft: "←",
		arrowright: "→",
		arrowup: "↑",
		arrowdown: "↓",
		escape: "Esc",
	};
	return binding
		.trim()
		.split("-")
		.map((part) => labels[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part))
		.join(isMac ? "" : "+");
}
