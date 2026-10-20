import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
	Annotation,
	EditorState,
	StateEffect,
	StateField,
	type Transaction,
	type TransactionSpec,
} from "@codemirror/state";
import { rejectedEditorInput, withinEditorInputLimit } from "./editor-limits.ts";

type LineEndings = { breaks: string; preferred: string };
const restore = StateEffect.define<LineEndings>();
export const externalMarkdownText = Annotation.define<boolean>();

function lineEndings(text: string): LineEndings {
	const breaks = Array.from(text.matchAll(/\r\n|\r|\n/g), ([value]) =>
		value === "\r\n" ? "c" : value === "\r" ? "r" : "n",
	).join("");
	return { breaks, preferred: breaks[0] ?? "n" };
}

function updateEndings(value: LineEndings, transaction: Transaction): LineEndings {
	// Grouped undo effects are ordered newest to oldest. The last snapshot is
	// the exact separator metadata for the resulting document.
	let restored: LineEndings | undefined;
	for (const effect of transaction.effects) if (effect.is(restore)) restored = effect.value;
	if (restored) return restored;
	if (!transaction.docChanged) return value;
	let breaks = "";
	let cursor = 0;
	transaction.changes.iterChanges((from, to, _from, _to, inserted) => {
		const start = transaction.startState.doc.lineAt(from).number - 1;
		const end = transaction.startState.doc.lineAt(to).number - 1;
		breaks += value.breaks.slice(cursor, start) + value.preferred.repeat(inserted.lines - 1);
		cursor = end;
	});
	breaks += value.breaks.slice(cursor);
	// An edit can expose CR followed immediately by LF. Raw CR+LF encodes
	// one break, not two: promote only that CR to CRLF to retain the empty
	// intervening line. Nonempty lines between these markers stay untouched.
	breaks = breaks.replace(/rn/g, (pair, offset: number) =>
		transaction.newDoc.line(offset + 2).length === 0 ? "cn" : pair,
	);
	return breaks === value.breaks ? value : { ...value, breaks };
}

const endings = StateField.define<LineEndings>({
	create: () => ({ breaks: "", preferred: "n" }),
	update: updateEndings,
});

/** CM owns normalized positions; this field retains only the original separators.
 * Untouched breaks stay byte-exact. New breaks follow the first established
 * separator (LF for a file with none), including newly pasted multiline text.
 * The sole boundary exception is a newly adjacent CR and LF: CR becomes CRLF
 * so serialization preserves both semantic breaks. Undo restores exact bytes.
 */
export function markdownLineEndings(source: string) {
	return [
		endings.init(() => lineEndings(source)),
		invertedEffects.of((transaction) =>
			transaction.docChanged ? [restore.of(transaction.startState.field(endings))] : [],
		),
		EditorState.transactionFilter.of((transaction) => {
			if (!transaction.docChanged) return transaction;
			const metadata = updateEndings(transaction.startState.field(endings), transaction);
			let extraBytes = 0;
			for (const marker of metadata.breaks) if (marker === "c") extraBytes++;
			return withinEditorInputLimit(transaction.newDoc, extraBytes)
				? transaction
				: { effects: rejectedEditorInput.of(true) };
		}),
	];
}

export function markdownFileText(state: EditorState) {
	const metadata = state.field(endings);
	let index = 0;
	let text = "";
	for (const chunk of state.doc) {
		if (chunk !== "\n") text += chunk;
		else {
			const marker = metadata.breaks[index++];
			text += marker === "c" ? "\r\n" : marker === "r" ? "\r" : "\n";
		}
	}
	return text;
}

/** Prop/reload synchronization is not an editor change notification. It remains
 * an isolated history step, so a deliberate Undo can recover previous content.
 */
export function replaceMarkdownText(state: EditorState, text: string): TransactionSpec {
	return {
		changes: { from: 0, to: state.doc.length, insert: text },
		effects: restore.of(lineEndings(text)),
		annotations: [externalMarkdownText.of(true), isolateHistory.of("full")],
	};
}
