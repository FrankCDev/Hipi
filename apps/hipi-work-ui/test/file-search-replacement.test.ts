import assert from "node:assert/strict";
import { test } from "node:test";
import { TextDocument } from "@pierre/diffs/edit";
import { fileSearchReplacements } from "../src/features/files/file-search-replacement.ts";
import { BoundedTextDocument } from "../src/features/files/pierre-document.ts";

test("public search offsets and native capture substitution preserve lookbehind, named captures and literal replacement", () => {
	const source = "prefix a1 prefix b2";
	const document = new TextDocument("search", source);
	const params = { query: "(?<=prefix )(?<letter>[a-z])(\\d)", regex: true, caseSensitive: true };
	const ranges = document.search({ text: params.query, replaceText: "", wholeWord: false, ...params });
	const edits = fileSearchReplacements(document, ranges, params, "$<letter>-$2-$$-$&");
	assert.deepEqual(edits, [
		{ from: 7, to: 9, text: "a-1-$-a1" },
		{ from: 17, to: 19, text: "b-2-$-b2" },
	]);
	assert.deepEqual(
		fileSearchReplacements(
			new TextDocument("one", "one"),
			[[0, 3]],
			{ query: "one", regex: false, caseSensitive: false },
			"$1",
		),
		[{ from: 0, to: 3, text: "$1" }],
	);
	assert.throws(() => fileSearchReplacements(new TextDocument("changed", "changed"), [[0, 3]], params, "x"));
});

test("replace all remains one bounded undoable document transaction and oversized replacement is rejected atomically", () => {
	const document = new BoundedTextDocument("file", "one one", "text");
	const query = { query: "one", regex: false, caseSensitive: true };
	const ranges = document.search({ text: query.query, replaceText: "", wholeWord: false, ...query });
	const changes = fileSearchReplacements(document, ranges, query, "two");
	document.applyEdits(
		changes.map(({ from, to, text }) => ({
			range: { start: document.positionAt(from), end: document.positionAt(to) },
			newText: text,
		})),
	);
	assert.equal(document.getText(), "two two");
	document.undo();
	assert.equal(document.getText(), "one one");
	const oversized = fileSearchReplacements(document, ranges, query, "中".repeat(30000));
	document.applyEdits(
		oversized.map(({ from, to, text }) => ({
			range: { start: document.positionAt(from), end: document.positionAt(to) },
			newText: text,
		})),
	);
	assert.equal(document.getText(), "one one");
	assert.throws(
		() =>
			fileSearchReplacements(
				new TextDocument("file", "a".repeat(1000)),
				Array.from({ length: 1000 }, (_, index) => [index, index + 1]),
				{ query: "a", regex: false, caseSensitive: true },
				"b".repeat(1024),
			),
		RangeError,
	);
});

test("single and all replacement captures use the same line-scoped anchors and CRLF context as public search", () => {
	for (const separator of ["\n", "\r\n", "\r"]) {
		const document = new TextDocument("file", `one${separator}two`);
		for (const query of ["[\\s\\S]+", "^(\\w+)$", "(?<=t)(\\w+)"]) {
			const params = { query, regex: true, caseSensitive: true };
			const ranges = document.search({ text: query, replaceText: "", wholeWord: false, ...params });
			const all = fileSearchReplacements(document, ranges, params, "[$&]-$1");
			for (const range of ranges) {
				assert.deepEqual(
					fileSearchReplacements(document, [range], params, "[$&]-$1"),
					all.filter((edit) => edit.from === range[0]),
				);
			}
			assert.equal(all.length, query.startsWith("(?<=") ? 1 : 2);
			assert.equal(all.at(-1)?.from, "one".length + separator.length + (query.startsWith("(?<=") ? 1 : 0));
			assert.equal(
				all.at(-1)?.text,
				query.startsWith("(?<=") ? "[wo]-wo" : query.startsWith("^") ? "[two]-two" : "[two]-$1",
			);
		}
	}
});
