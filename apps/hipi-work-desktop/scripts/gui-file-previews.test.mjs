import assert from "node:assert/strict";
import test from "node:test";
import { previewFixture } from "./gui-file-preview-fixtures.mjs";
import { assertContinuousSpreadsheet, focusedSheetVisible } from "./gui-file-previews.mjs";

const spreadsheet = () => ({
	path: previewFixture.xlsxName,
	loading: false,
	alerts: [],
	page: undefined,
	previousDisabled: null,
	nextDisabled: null,
	sheets: [previewFixture.sheetName, previewFixture.secondSheetName],
	cells: ["label", "value", "中文", "42", "cached formula", "999", "second", "page", "fixture", "unchanged"],
	editableElements: 0,
	note: "Formulas are not recalculated",
});

test("continuous spreadsheet evidence requires both exact sheets and saved values without transport controls", () => {
	assertContinuousSpreadsheet(spreadsheet());
	for (const change of [
		{ sheets: [previewFixture.sheetName] },
		{ sheets: [previewFixture.secondSheetName, previewFixture.sheetName] },
		{ cells: spreadsheet().cells.slice(0, 6) },
		{ cells: spreadsheet().cells.map((value) => (value === "999" ? "2" : value)) },
		{ page: "Page 1 / 2" },
		{ nextDisabled: false },
		{ previousDisabled: true },
		{ loading: true },
		{ alerts: ["Read failed"] },
		{ editableElements: 1 },
		{ note: "" },
	])
		assert.throws(() => assertContinuousSpreadsheet({ ...spreadsheet(), ...change }));
});

test("sheet visit requires unique focused real grid inside the preview viewport, not merely a DOM match", () => {
	const bounds = { top: 10, bottom: 400, left: 20, right: 500 };
	let rect = { top: 100, bottom: 200, left: 30, right: 490, width: 460, height: 100 };
	const grid = { getAttribute: () => previewFixture.sheetName, getBoundingClientRect: () => rect };
	const grids = [grid];
	const roots = [{ querySelectorAll: () => grids, getBoundingClientRect: () => bounds }];
	const document = { activeElement: grid, querySelectorAll: () => roots };
	assert.equal(focusedSheetVisible(document, previewFixture.sheetName), true);
	assert.equal(focusedSheetVisible(document, previewFixture.secondSheetName), false);
	document.activeElement = null;
	assert.equal(focusedSheetVisible(document, previewFixture.sheetName), false);
	document.activeElement = grid;
	for (const change of [{ top: 0 }, { bottom: 401 }, { left: 0 }, { right: 501 }, { height: 0 }, { width: 0 }]) {
		const before = rect;
		rect = { ...rect, ...change };
		assert.equal(focusedSheetVisible(document, previewFixture.sheetName), false);
		rect = before;
	}
	grids.push(grid);
	assert.equal(focusedSheetVisible(document, previewFixture.sheetName), false);
	grids.pop();
	roots.push(roots[0]);
	assert.equal(focusedSheetVisible(document, previewFixture.sheetName), false);
});
