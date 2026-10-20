import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { narrowEditorNodes, narrowEditorRestored, tabToEditorControl } from "./gui-file-editor-escape.mjs";

function fixture() {
	const input = { getAttribute: (name) => ({ role: "textbox", contenteditable: "true" })[name] };
	const nodes = Array.from({ length: 4 }, () => ({ isConnected: true }));
	nodes[3].shadowRoot = { activeElement: input };
	const bySelector = new Map([
		['.file-panel-dialog[role="dialog"]', [nodes[0]]],
		['.file-panel-dialog .file-tabs [role="tab"][aria-selected="true"]', [nodes[1]]],
		[".file-panel-dialog .file-code.pierre-code", [nodes[2]]],
		[".file-panel-dialog .pierre-editor-viewport diffs-container", [nodes[3]]],
	]);
	const document = {
		activeElement: nodes[3],
		child: null,
		querySelectorAll: (selector) => bySelector.get(selector) ?? [],
		querySelector: () => document.child,
	};
	return { document, nodes, bySelector };
}

test("serialized renderer predicate preserves actual DOM identity and shadow focus", () => {
	const { document, nodes } = fixture();
	nodes[0].reactOwner = nodes[0]; // A DOM reference must not be returned through CDP serialization.
	assert.equal(
		runInNewContext(`(${narrowEditorRestored.toString()})(document, before, ${narrowEditorNodes.toString()})`, {
			document,
			before: nodes,
		}),
		true,
	);
});

test("rejects replaced dialog, selected tab, editor or shadow host despite matching geometry", () => {
	for (let index = 0; index < 4; index++) {
		const { document, nodes, bySelector } = fixture();
		const before = [...nodes];
		bySelector.set([...bySelector.keys()][index], [{ ...nodes[index] }]);
		assert.equal(narrowEditorRestored(document, before), false);
	}
});

test("rejects closed outer dialog, duplicate hosts, still-open child and wrong focus", () => {
	for (const mutate of [
		({ bySelector }) => bySelector.set('.file-panel-dialog[role="dialog"]', []),
		({ bySelector, nodes }) =>
			bySelector.set(".file-panel-dialog .pierre-editor-viewport diffs-container", [nodes[3], nodes[3]]),
		({ document }) => {
			document.child = {};
		},
		({ document }) => {
			document.activeElement = {};
		},
		({ nodes }) => {
			nodes[3].shadowRoot.activeElement = null;
		},
		({ nodes }) => {
			nodes[0].isConnected = false;
		},
	]) {
		const value = fixture();
		mutate(value);
		assert.equal(narrowEditorRestored(value.document, value.nodes), false);
	}
});

test("native Tab uses paired input events and stops on exact observed focus", async () => {
	const events = [];
	let samples = 0;
	const cdp = {
		async request(method, args) {
			if (method === "Runtime.evaluate") return { result: { value: ++samples === 3 } };
			events.push({ method, ...args });
		},
	};
	await tabToEditorControl(cdp, 'button[aria-label="Close find"]');
	assert.deepEqual(
		events.map((event) => event.type),
		["keyDown", "keyUp", "keyDown", "keyUp"],
	);
	assert.ok(
		events.every(
			(event) => event.method === "Input.dispatchKeyEvent" && event.key === "Tab" && event.windowsVirtualKeyCode === 9,
		),
	);
});

test("unreachable exact control fails after bounded native traversal, never DOM focus injection", async () => {
	const events = [];
	const cdp = {
		async request(method, args) {
			if (method === "Runtime.evaluate") return { result: { value: false } };
			events.push(args);
		},
	};
	await assert.rejects(tabToEditorControl(cdp, ".missing"), /Native Tab did not reach/);
	assert.equal(events.length, 24);
});
