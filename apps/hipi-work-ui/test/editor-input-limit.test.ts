import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { FILE_LIMITS } from "@hipi/work-runtime/files";
import { boundedEditorInput, inputLimitExceeded } from "../src/features/files/editor-limits.ts";

const state = (doc: string) => EditorState.create({ doc, extensions: boundedEditorInput });
test("oversized paste is rejected as a whole and reports the limit", () => {
	const initial = state("preserved");
	const rejected = initial.update({
		changes: { from: 0, to: initial.doc.length, insert: "a".repeat(FILE_LIMITS.bytes + 1) },
	}).state;
	assert.equal(rejected.doc.toString(), "preserved");
	assert.equal(rejected.field(inputLimitExceeded), true);
	const accepted = rejected.update({ changes: { from: 0, insert: "x" } }).state;
	assert.equal(accepted.doc.toString(), "xpreserved");
	assert.equal(accepted.field(inputLimitExceeded), false);
});
test("UTF-8 budget counts Chinese, emoji and newlines rather than UTF-16 length", () => {
	for (const text of ["中".repeat(43691), "😀".repeat(32769), "\n".repeat(FILE_LIMITS.bytes + 1)]) {
		const next = state("keep").update({ changes: { from: 0, insert: text } }).state;
		assert.equal(next.doc.toString(), "keep");
		assert.equal(next.field(inputLimitExceeded), true);
	}
	const exact = "😀".repeat(32768);
	const full = state("").update({ changes: { from: 0, insert: exact } }).state;
	assert.equal(full.doc.toString(), exact);
	assert.equal(full.field(inputLimitExceeded), false);
});
