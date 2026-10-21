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
		ArrowLeft: [37, "ArrowLeft"],
		ArrowRight: [39, "ArrowRight"],
		"[": [219, "BracketLeft"],
		"]": [221, "BracketRight"],
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

/** CDP renderer input, not proof of physical OS accelerator routing. */
export function sidebarTraversalKeyEvents(value, repeats = 0, platform = process.platform) {
	assert.ok(["[", "]", "ArrowLeft", "ArrowRight"].includes(value));
	assert.ok(Number.isSafeInteger(repeats) && repeats >= 0 && repeats <= 4);
	const primary = platform === "darwin" ? 4 : 2;
	const modifier =
		platform === "darwin"
			? { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 }
			: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 };
	const alt = { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 };
	const [down, up] = nativeKeyEvents(value, primary | 1, platform);
	return [
		{ type: "rawKeyDown", ...modifier, modifiers: primary },
		{ type: "rawKeyDown", ...alt, modifiers: primary | 1 },
		{ ...down, autoRepeat: false },
		...Array.from({ length: repeats }, () => ({ ...down, autoRepeat: true })),
		up,
		{ type: "keyUp", ...alt, modifiers: primary },
		{ type: "keyUp", ...modifier, modifiers: 0 },
	];
}
