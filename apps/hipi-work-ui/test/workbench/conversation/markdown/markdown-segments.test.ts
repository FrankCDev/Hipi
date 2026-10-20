import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isOpenCodeFence,
	markdownSegments,
} from "../../../../src/features/workbench/conversation/markdown/segments.ts";

test("settled paragraph and closed-fence keys and source remain unchanged as the tail grows", () => {
	const source = "First **paragraph**.\n\n```ts\none();\n```\n\nGrowing";
	const previous = markdownSegments(source);
	const next = markdownSegments(`${source} tail.\n\nNext`);
	assert.deepEqual(next.slice(0, 2), previous.slice(0, 2));
	assert.equal(previous.map((segment) => segment.source).join(""), source);
	assert.deepEqual(
		previous.slice(0, 2).map((segment) => segment.settled),
		[true, true],
	);
});

test("every partial source remains lossless without splitting open fences or container/reference tails", () => {
	for (const source of [
		"Before.\n\n````ts\ninside\n\n```\nstill inside\n````\nAfter",
		"- item\n\n  nested paragraph\n\n- second",
		"> quote\n>\n> paragraph",
		"[label][id]\n\n[id]: https://example.com\n\nend",
		":::directive\n\ncontent\n:::",
	]) {
		for (let index = 0; index <= source.length; index++) {
			const prefix = source.slice(0, index);
			assert.equal(
				markdownSegments(prefix)
					.map((segment) => segment.source)
					.join(""),
				prefix,
			);
		}
	}
	assert.equal(markdownSegments("- item\n\n  nested\n\nnext").length, 1);
	assert.equal(markdownSegments("[id]\n\n[id]: https://example.com").length, 1);
	assert.equal(markdownSegments("```\ninside\n\nstill").length, 1);
});

test("open fence state is local to the parser-positioned card, including nested containers", () => {
	assert.equal(isOpenCodeFence("```ts\nclosed\n```\n\n```ts\nopen", 1, 3), false);
	assert.equal(isOpenCodeFence("```ts\nclosed\n```\n\n```ts\nopen", 5, 7), true);
	assert.equal(isOpenCodeFence("> - ```ts\n>   open", 1, 3), true);
	assert.equal(isOpenCodeFence("> - ```ts\n>   closed\n>   ```", 1, 3), false);
	assert.equal(isOpenCodeFence("    indented", 1, 1), false);
});
