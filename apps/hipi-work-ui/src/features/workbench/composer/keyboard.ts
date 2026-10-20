type EditorBinding = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
};

/** Browser editor bindings are independent of the terminal's escape-sequence bindings. */
export const DEFAULT_EDITOR_KEYBINDINGS: { submit: readonly EditorBinding[] } = {
	submit: [
		{ key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
		{ key: "Enter", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
		{ key: "Enter", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
		{ key: "Enter", ctrlKey: true, metaKey: true, shiftKey: false, altKey: false },
	],
};

type EditorKeyEvent = EditorBinding & {
	isComposing: boolean;
	keyCode: number;
	repeat: boolean;
	timeStamp: number;
};

// Safari can end composition before dispatching its confirming Enter keydown.
// Release on keyup, with a short fallback for IMEs that do not emit that keyup.
const COMPOSITION_END_GUARD_MS = 100;

export class ComposerKeyboard {
	private composing = false;
	private compositionEndedAt = Number.NEGATIVE_INFINITY;

	compositionStart() {
		this.composing = true;
	}

	compositionEnd(timeStamp: number) {
		this.composing = false;
		this.compositionEndedAt = timeStamp;
	}

	reset() {
		this.composing = false;
		this.compositionEndedAt = Number.NEGATIVE_INFINITY;
	}

	keyUp() {
		this.compositionEndedAt = Number.NEGATIVE_INFINITY;
	}

	keyDown(event: EditorKeyEvent, bindings = DEFAULT_EDITOR_KEYBINDINGS): "native" | "prevent" | "submit" {
		if (this.composing || event.isComposing || event.keyCode === 229) return "native";
		const submit = bindings.submit.some((binding) =>
			(Object.keys(binding) as (keyof EditorBinding)[]).every((key) => event[key] === binding[key]),
		);
		if (!submit) return "native";
		if (event.repeat || event.timeStamp - this.compositionEndedAt < COMPOSITION_END_GUARD_MS) return "prevent";
		return "submit";
	}
}
