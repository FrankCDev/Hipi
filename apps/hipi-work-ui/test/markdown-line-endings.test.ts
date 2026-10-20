import assert from "node:assert/strict";
import { history, redo, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { FILE_LIMITS } from "@hipi/work-runtime/files";
import { test } from "vitest";
import { boundedEditorInput, inputLimitExceeded } from "../src/features/files/editor-limits.ts";
import {
	markdownFileText,
	markdownLineEndings,
	replaceMarkdownText,
} from "../src/features/files/markdown-line-endings.ts";

function fixture(source: string) {
	let state = EditorState.create({
		doc: source,
		extensions: [history(), boundedEditorInput, markdownLineEndings(source)],
	});
	return {
		get state() {
			return state;
		},
		dispatch: (transaction: Transaction) => {
			state = transaction.state;
		},
	};
}

test.each(["\n", "\r\n", "\r"])(
	"installed CM preserves %j separators through edits, inserted lines and undo/redo",
	(eol) => {
		const source = ["# heading", "body", "end", ""].join(eol);
		const editor = fixture(source);
		assert.equal(markdownFileText(editor.state), source);
		const offset = editor.state.doc.line(2).from + 1;
		editor.dispatch(editor.state.update({ changes: { from: offset, insert: "X\nY" }, userEvent: "input.type" }));
		const expected = source.replace("body", `bX${eol}Yody`);
		assert.equal(markdownFileText(editor.state), expected);
		assert.equal(undo(editor), true);
		assert.equal(markdownFileText(editor.state), source);
		assert.equal(redo(editor), true);
		assert.equal(markdownFileText(editor.state), expected);
	},
);

test("mixed separators outside changed ranges remain exact, including grouped undo/redo and multiple replacements", () => {
	const source = "# heading\r\nbody\rthird\nfourth\r\n";
	const editor = fixture(source);
	editor.dispatch(editor.state.update({ changes: { from: 11, insert: "X" }, userEvent: "input.type" }));
	editor.dispatch(editor.state.update({ changes: { from: 12, insert: "\nY" }, userEvent: "input.type" }));
	assert.equal(markdownFileText(editor.state), "# heading\r\nbX\r\nYody\rthird\nfourth\r\n");
	assert.equal(undo(editor), true);
	assert.equal(markdownFileText(editor.state), source);
	assert.equal(redo(editor), true);
	const before = markdownFileText(editor.state);
	const third = editor.state.doc.line(4);
	editor.dispatch(
		editor.state.update({
			changes: [
				{ from: 0, to: 2, insert: "" },
				{ from: third.from, to: third.to + 1, insert: "replacement\n" },
			],
			userEvent: "input.replace",
		}),
	);
	assert.equal(markdownFileText(editor.state), "heading\r\nbX\r\nYody\rreplacement\r\nfourth\r\n");
	assert.equal(undo(editor), true);
	assert.equal(markdownFileText(editor.state), before);
});

test("external raw-text synchronization stays an isolated undoable step with exact separators", () => {
	const source = "one\r\ntwo\rthree\n";
	const editor = fixture(source);
	const reloaded = "new\nsource\r\n";
	editor.dispatch(editor.state.update(replaceMarkdownText(editor.state, reloaded)));
	assert.equal(markdownFileText(editor.state), reloaded);
	assert.equal(undo(editor), true);
	assert.equal(markdownFileText(editor.state), source);
	assert.equal(redo(editor), true);
	assert.equal(markdownFileText(editor.state), reloaded);
});

test.each(["a", "🙂"])(
	"serialized CRLF UTF-8 bounds reject an over-limit newline after %j without truncation",
	(prefix) => {
		const source = `${prefix}\r\n${"x".repeat(FILE_LIMITS.bytes - new TextEncoder().encode(prefix).length - 2)}`;
		const editor = fixture(source);
		assert.equal(new TextEncoder().encode(source).length, FILE_LIMITS.bytes);
		editor.dispatch(editor.state.update({ changes: { from: editor.state.doc.length, insert: "\n" } }));
		assert.equal(markdownFileText(editor.state), source);
		assert.equal(editor.state.field(inputLimitExceeded), true);
		editor.dispatch(
			editor.state.update({
				changes: { from: editor.state.doc.length - 2, to: editor.state.doc.length, insert: "\n" },
			}),
		);
		assert.equal(new TextEncoder().encode(markdownFileText(editor.state)).length, FILE_LIMITS.bytes);
		assert.equal(editor.state.field(inputLimitExceeded), false);
	},
);

test.each([
	{ source: "a\nb\rc", from: 4, to: 4, insert: "\n", expected: "a\nb\r\n\nc" },
	{ source: "a\rb\nc", from: 3, to: 3, insert: "\n", expected: "a\rb\r\n\nc" },
	{ source: "a\rb\nc", from: 2, to: 3, insert: "", expected: "a\r\n\nc" },
	{ source: "a\rb\nc", from: 3, to: 3, insert: "X", expected: "a\rbX\nc" },
])(
	"only an empty edited CR/LF boundary is canonicalized: $source, $from..$to",
	({ source, from, to, insert, expected }) => {
		const editor = fixture(source);
		editor.dispatch(editor.state.update({ changes: { from, to, insert }, userEvent: "input.replace" }));
		assert.equal(markdownFileText(editor.state), expected);
		assert.equal(EditorState.create({ doc: expected }).doc.toString(), editor.state.doc.toString());
		assert.equal(undo(editor), true);
		assert.equal(markdownFileText(editor.state), source);
		assert.equal(redo(editor), true);
		assert.equal(markdownFileText(editor.state), expected);
	},
);

test("every short mixed-EOL insertion/deletion round-trips its semantic document and exact undo without exclusions", () => {
	for (const source of ["a\nb\rc", "a\rb\nc", "\rX\n", "a\r\nb\rc\nd\r\n", "a\r\n\nb", "a\n\rb"]) {
		const length = EditorState.create({ doc: source }).doc.length;
		for (let from = 0; from <= length; from++) {
			for (let to = from; to <= length; to++) {
				for (const insert of ["", "\n", "\n\n", "x", "x\n"]) {
					if (from === to && !insert) continue;
					const editor = fixture(source);
					editor.dispatch(editor.state.update({ changes: { from, to, insert }, userEvent: "input.replace" }));
					const after = markdownFileText(editor.state);
					assert.equal(EditorState.create({ doc: after }).doc.toString(), editor.state.doc.toString());
					assert.equal(undo(editor), true);
					assert.equal(markdownFileText(editor.state), source);
					assert.equal(redo(editor), true);
					assert.equal(markdownFileText(editor.state), after);
				}
			}
		}
	}
});

test("boundary canonicalization counts its additional byte before admitting an edit", () => {
	const source = `a\nb\r${"x".repeat(FILE_LIMITS.bytes - 5)}`;
	const editor = fixture(source);
	assert.equal(new TextEncoder().encode(source).length, FILE_LIMITS.bytes - 1);
	editor.dispatch(editor.state.update({ changes: { from: editor.state.doc.line(3).from, insert: "\n" } }));
	assert.equal(editor.state.field(inputLimitExceeded), true);
	assert.equal(markdownFileText(editor.state), source);
	assert.equal(undo(editor), false, "a rejected boundary edit is not added to history");
});
