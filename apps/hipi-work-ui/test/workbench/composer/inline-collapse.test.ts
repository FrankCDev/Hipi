import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type InlineControlPresentations,
	resolveInlineControls,
} from "../../../src/features/workbench/composer/inline-collapse.ts";

const expanded = { model: { hideLabel: false, hideControl: false } };
const compact = { model: { hideLabel: true, hideControl: false } };
const hidden = { model: { hideLabel: true, hideControl: true } };
function resolve(width: number | null, previous: InlineControlPresentations, compactWidth?: number, canHide = true) {
	return resolveInlineControls({
		availableWidth: width,
		gap: 4,
		items: [{ id: "model", canHideLabel: true, canHideControl: canHide }],
		sizes: new Map([["model", { expanded: 180, compact: compactWidth }]]),
		previous,
	});
}

test("collapse labels first and wait for a real compact measurement before hiding", () => {
	assert.deepEqual(resolve(20, expanded), compact);
	assert.deepEqual(resolve(20, compact), compact);
	assert.deepEqual(resolve(20, compact, 28), hidden);
});
test("the exact measured width fits without hiding; zero available space hides only after measurement", () => {
	assert.deepEqual(resolve(28, compact, 28), compact);
	assert.deepEqual(resolve(0, expanded, 28), compact);
	assert.deepEqual(resolve(0, compact, 28), hidden);
});
test("growth restores a hidden control and its label using cached expanded width", () => {
	assert.deepEqual(resolve(100, hidden, 28), compact);
	assert.deepEqual(resolve(180, hidden, 28), expanded);
	assert.deepEqual(resolve(null, hidden, 28), expanded);
});
test("focused, open, or sole-access controls can collapse their labels but cannot disappear", () => {
	assert.deepEqual(resolve(10, compact, 28, false), compact);
});
test("unknown measurements do not interpret a control as free space", () => {
	assert.deepEqual(
		resolveInlineControls({
			availableWidth: 10,
			gap: 4,
			items: [{ id: "model", canHideLabel: true, canHideControl: true }],
			sizes: new Map(),
			previous: expanded,
		}),
		expanded,
	);
});
test("label collapse and whole-control removal use the supplied priority and real gaps", () => {
	const items = [
		{ id: "usage", canHideLabel: false, canHideControl: true },
		{ id: "model", canHideLabel: true, canHideControl: true },
		{ id: "context", canHideLabel: true, canHideControl: true },
	];
	const sizes = new Map([
		["usage", { expanded: 40 }],
		["model", { expanded: 180, compact: 28 }],
		["context", { expanded: 90, compact: 28 }],
	]);
	const first = resolveInlineControls({ availableWidth: 110, gap: 4, items, sizes, previous: {} });
	assert.deepEqual(first, {
		usage: { hideLabel: false, hideControl: false },
		model: compact.model,
		context: compact.model,
	});
	const second = resolveInlineControls({ availableWidth: 60, gap: 4, items, sizes, previous: first });
	assert.deepEqual(second, {
		usage: { hideLabel: false, hideControl: true },
		model: compact.model,
		context: compact.model,
	});
});
