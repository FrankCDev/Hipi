import assert from "node:assert/strict";
import { test } from "vitest";
import { contextPaths } from "../src/features/agent-permissions/context-paths.ts";

test("whole-root permission is explicit; invalid lines never silently widen or narrow scope", () => {
	assert.deepEqual(contextPaths("", true), [""]);
	for (const text of ["", " ", "src\n", "\nsrc", "src\nsrc", "../src", "/src", "src\n../other"])
		assert.equal(contextPaths(text, false), null, JSON.stringify(text));
	assert.deepEqual(contextPaths("src\ndocs", false), ["src", "docs"]);
	// Leading whitespace is part of a valid filename; it is never trimmed away.
	assert.deepEqual(contextPaths(" src", false), [" src"]);
});
