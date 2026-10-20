import assert from "node:assert/strict";
import test from "node:test";
import { assertDisclosureContinuity, projectSelector } from "./gui-project-disclosure.mjs";

test("project selector identifies exact names independently of selected or first project", () => {
	let names = ["B", "A"];
	const document = { querySelectorAll: () => names.map((textContent) => ({ querySelector: () => ({ textContent }) })) };
	assert.equal(projectSelector(document, "A"), ".workspace-tree > .workspace-branch:nth-child(2)");
	assert.equal(projectSelector(document, "missing"), null);
	names = ["A", "A"];
	assert.equal(projectSelector(document, "A"), null);
});

test("disclosure rejects selection, draft, message identity, mounted-node and drawer changes", () => {
	const expected = {
		selected: "A",
		draft: "keep",
		keys: ["message:user", "message:assistant"],
		navigationOpen: "true",
	};
	const valid = { ...expected, sameComposer: true, sameConversation: true };
	assert.doesNotThrow(() => assertDisclosureContinuity(valid, expected));
	for (const [key, value] of Object.entries({
		selected: "B",
		draft: "",
		keys: ["message:replayed"],
		navigationOpen: "false",
		sameComposer: false,
		sameConversation: false,
	})) {
		assert.throws(() => assertDisclosureContinuity({ ...valid, [key]: value }, expected));
	}
});
