import { EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import { FILE_LIMITS } from "@hipi/work-runtime/files";

const rejected = StateEffect.define<boolean>();
export const inputLimitExceeded = StateField.define<boolean>({
	create: () => false,
	update: (value, transaction) => {
		for (const effect of transaction.effects) if (effect.is(rejected)) return effect.value;
		return transaction.docChanged ? false : value;
	},
});
/** UTF-8 count short-circuits before allocating an encoded copy of an oversized paste. */
function withinLimit(text: Text): boolean {
	if (text.length > FILE_LIMITS.bytes) return false;
	let bytes = 0;
	for (const chunk of text) {
		for (const character of chunk) {
			const point = character.codePointAt(0) ?? 0;
			bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
			if (bytes > FILE_LIMITS.bytes) return false;
		}
	}
	return true;
}
export const boundedEditorInput = [
	inputLimitExceeded,
	EditorState.transactionFilter.of((transaction) => {
		if (!transaction.docChanged || withinLimit(transaction.newDoc)) return transaction;
		return { effects: rejected.of(true) };
	}),
];
