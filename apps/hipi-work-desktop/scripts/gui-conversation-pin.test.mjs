import assert from "node:assert/strict";
import test from "node:test";
import { assertPinState } from "./gui-conversation-pin.mjs";

test("pin shortcut needs exact persisted scope without another canonical conversation", () => {
	const scope = { workspaceId: "a", conversationId: "one" };
	const row = { ...scope, current: true };
	const valid = { workspaces: 2, canonical: [], pinned: [row] };
	assertPinState(valid, scope, true);
	assertPinState({ ...valid, canonical: [row], pinned: [] }, scope, false);
	for (const state of [
		{ ...valid, workspaces: 3 },
		{ ...valid, canonical: [row] },
		{ ...valid, canonical: [row, row] },
		{ ...valid, pinned: [] },
		{ ...valid, pinned: [row, row] },
		{ ...valid, pinned: [{ ...row, workspaceId: "b" }] },
		{ ...valid, pinned: [{ ...row, conversationId: "different" }] },
		{ ...valid, canonical: [{ ...row, current: false }] },
		{ ...valid, pinned: [{ ...row, current: false }] },
	])
		assert.throws(() => assertPinState(state, scope, true));
	assert.throws(() => assertPinState(valid, scope, false));
});

test("unpinned row must retain exact scope and selection with no residual pin", () => {
	const scope = { workspaceId: "a", conversationId: "one" };
	const valid = { workspaces: 2, canonical: [{ ...scope, current: true }], pinned: [] };
	assertPinState(valid, scope, false);
	for (const delta of [{ workspaceId: "b" }, { conversationId: "other" }, { current: false }])
		assert.throws(() => assertPinState({ ...valid, canonical: [{ ...valid.canonical[0], ...delta }] }, scope, false));
	assert.throws(() => assertPinState({ ...valid, canonical: [] }, scope, false));
	assert.throws(() => assertPinState({ ...valid, pinned: valid.canonical }, scope, false));
});
