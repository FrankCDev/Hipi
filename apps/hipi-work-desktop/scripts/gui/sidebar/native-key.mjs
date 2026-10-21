import assert from "node:assert/strict";

/** CDP does not resolve macOS editing shortcuts through the native menu. */
export function nativeKeyEvents(value, modifiers = 0, platform = process.platform) {
	const keys = {
		Enter: [13, "Enter"],
		" ": [32, "Space"],
		Tab: [9, "Tab"],
		Escape: [27, "Escape"],
		ArrowUp: [38, "ArrowUp"],
		ArrowDown: [40, "ArrowDown"],
		a: [65, "KeyA"],
		Backspace: [8, "Backspace"],
	};
	assert.ok(keys[value], "Unsupported native fixture key");
	const commands =
		platform !== "darwin"
			? []
			: value === "a" && modifiers === 4
				? ["selectAll"]
				: value === "Backspace" && modifiers === 0
					? ["deleteBackward"]
					: [];
	return ["keyDown", "keyUp"].map((type) => ({
		type: type === "keyDown" && commands.length ? "rawKeyDown" : type,
		key: value,
		code: keys[value][1],
		windowsVirtualKeyCode: keys[value][0],
		modifiers,
		...(type === "keyDown" && commands.length ? { commands } : {}),
		...(type === "keyDown" && [" ", "Enter"].includes(value) ? { text: value === "Enter" ? "\r" : " " } : {}),
	}));
}
