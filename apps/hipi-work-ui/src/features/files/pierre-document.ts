import { FILE_LIMITS } from "@hipi/work-runtime/files";
import { type ResolvedTextEdit, TextDocument } from "@pierre/diffs/edit";

export function fitsEditorBytes(text: string) {
	if (text.length > FILE_LIMITS.bytes) return false;
	let bytes = 0;
	for (const character of text) {
		const point = character.codePointAt(0) ?? 0;
		bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
		if (bytes > FILE_LIMITS.bytes) return false;
	}
	return true;
}

/**
 * The public TextDocument extension point rejects an entire oversized transaction
 * before it enters Pierre's text, undo history, or the application's writer.
 */
export class BoundedTextDocument extends TextDocument<"file", undefined> {
	private limitListener?: (exceeded: boolean) => void;
	setLimitListener(listener?: (exceeded: boolean) => void) {
		this.limitListener = listener;
	}
	private accepts(edits: readonly ResolvedTextEdit[]) {
		const before = this.getText();
		const ordered = [...edits].sort((a, b) => a.start - b.start);
		const length = ordered.reduce((size, edit) => size + edit.text.length - (edit.end - edit.start), before.length);
		if (length > FILE_LIMITS.bytes) {
			this.limitListener?.(true);
			return false;
		}
		let cursor = 0;
		let next = "";
		for (const edit of ordered) {
			next += before.slice(cursor, edit.start) + edit.text;
			cursor = edit.end;
		}
		next += before.slice(cursor);
		const accepted = fitsEditorBytes(next);
		this.limitListener?.(!accepted);
		return accepted;
	}
	override applyEdits(...args: Parameters<TextDocument<"file", undefined>["applyEdits"]>) {
		if (!this.accepts(this.resolveEdits(args[0]))) return;
		return super.applyEdits(...args);
	}
	override applyResolvedEdits(...args: Parameters<TextDocument<"file", undefined>["applyResolvedEdits"]>) {
		if (!this.accepts(args[0])) return;
		return super.applyResolvedEdits(...args);
	}
}
