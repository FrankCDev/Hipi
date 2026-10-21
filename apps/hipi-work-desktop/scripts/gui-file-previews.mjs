import assert from "node:assert/strict";
import { previewFixture } from "./gui-file-preview-fixtures.mjs";
import { assertNoAlerts, capture, click, evaluate, pressKey, until } from "./gui-flow.mjs";

export function documentPreviewState(document) {
	const previews = document.querySelectorAll('.file-workbench .file-buffer[aria-label="Preview"]');
	if (previews.length !== 1) return null;
	const root = previews[0];
	const button = (label) => {
		const nodes = [...root.querySelectorAll("button")].filter((e) => e.textContent.trim() === label);
		return nodes.length === 1 ? nodes[0].disabled : null;
	};
	return {
		path: root.querySelector(".file-path")?.textContent,
		alerts: [...root.querySelectorAll('[role="alert"]')].map((e) => e.textContent.trim()),
		loading: [...root.querySelectorAll("output")].some((e) => e.textContent === "Reading preview…"),
		page: root.querySelector(".file-actions output")?.textContent.replace(/\s+/g, " ").trim(),
		text: root.querySelector("pre.file-preview-text")?.textContent,
		note: root.querySelector("p.small-copy")?.textContent,
		sheets: [...root.querySelectorAll(".file-preview-grid")].map((e) => e.getAttribute("aria-label")),
		cells: [...root.querySelectorAll(".file-preview-grid td")].map((e) => e.textContent),
		previousDisabled: button("Previous page"),
		nextDisabled: button("Next page"),
		retryAvailable: button("Reopen preview") === false,
		editableElements: root.querySelectorAll('input,textarea,[contenteditable="true"]').length,
	};
}

export function pdfPreviewPaint(document) {
	const previews = document.querySelectorAll('.file-workbench .file-buffer[aria-label="Preview"]');
	if (previews.length !== 1) return null;
	const root = previews[0];
	const surfaces = root.querySelectorAll(".file-preview-surface");
	const canvases = root.querySelectorAll("canvas");
	const selects = root.querySelectorAll(".file-actions select");
	if (surfaces.length !== 1 || canvases.length !== 1 || selects.length !== 1 || selects[0].disabled) return null;
	const canvas = canvases[0];
	if (
		surfaces[0].getAttribute("aria-busy") !== "false" ||
		canvas.getAttribute("role") !== "img" ||
		canvas.getAttribute("aria-label") !== "PDF page 1"
	)
		return null;
	const zoom = Number(selects[0].value);
	if (![1, 1.5].includes(zoom) || canvas.width !== 400 * zoom || canvas.height !== 300 * zoom) return null;
	const context = canvas.getContext("2d");
	const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
	const pixel = (x, y) => {
		const offset = (Math.floor(y * zoom) * canvas.width + Math.floor(x * zoom)) * 4;
		return [...data.slice(offset, offset + 4)];
	};
	let darkTextPixels = 0;
	for (let y = Math.floor(45 * zoom); y < 90 * zoom; y++) {
		for (let x = Math.floor(35 * zoom); x < 300 * zoom; x++) {
			const i = (y * canvas.width + x) * 4;
			if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] === 255) darkTextPixels++;
		}
	}
	return {
		zoom,
		width: canvas.width,
		height: canvas.height,
		blue: pixel(80, 175),
		white: pixel(10, 10),
		darkTextPixels,
	};
}

export function assertPdfPaint(paint, zoom) {
	assert.equal(paint?.zoom, zoom);
	assert.equal(paint.width, 400 * zoom);
	assert.equal(paint.height, 300 * zoom);
	assert.ok(
		paint.blue[0] < 10 && paint.blue[1] < 10 && paint.blue[2] > 245 && paint.blue[3] === 255,
		"PDF rectangle must render blue",
	);
	assert.ok(
		paint.white.slice(0, 3).every((channel) => channel > 245) && paint.white[3] === 255,
		"PDF background must render white",
	);
	assert.ok(paint.darkTextPixels > 100, "PDF bundled font must paint text, not only the rectangle");
}

async function inspectPdf(cdp, zoom) {
	const paint = await until(async () => {
		const value = await evaluate(cdp, `(${pdfPreviewPaint.toString()})(document)`);
		return value?.zoom === zoom ? value : null;
	}, "PDF render completed at expected zoom");
	assertPdfPaint(paint, zoom);
	const page = await evaluate(cdp, `(${documentPreviewState.toString()})(document)`);
	assert.equal(page.path, previewFixture.pdfName);
	assert.equal(page.page, "Page 1 / 1");
	assert.equal(page.loading, false);
	assert.deepEqual(page.alerts, []);
	assert.equal(page.previousDisabled, true);
	assert.equal(page.nextDisabled, true);
	return paint;
}

export function assertContinuousSpreadsheet(state) {
	assert.equal(state?.path, previewFixture.xlsxName);
	assert.equal(state.loading, false);
	assert.deepEqual(state.alerts, []);
	assert.equal(state.page, undefined);
	assert.equal(state.previousDisabled, null);
	assert.equal(state.nextDisabled, null);
	assert.deepEqual(state.sheets, [previewFixture.sheetName, previewFixture.secondSheetName]);
	assert.deepEqual(state.cells, [
		"label",
		"value",
		"中文",
		"42",
		"cached formula",
		"999",
		"second",
		"page",
		"fixture",
		"unchanged",
	]);
	assert.equal(state.editableElements, 0);
	assert.ok(state.note.includes("Formulas are not recalculated"));
}

export function focusedSheetVisible(document, name) {
	const roots = document.querySelectorAll('.file-workbench .file-buffer[aria-label="Preview"]');
	if (roots.length !== 1) return false;
	const grids = [...roots[0].querySelectorAll(".file-preview-grid")].filter(
		(node) => node.getAttribute("aria-label") === name,
	);
	if (grids.length !== 1 || document.activeElement !== grids[0]) return false;
	const bounds = roots[0].getBoundingClientRect();
	const rect = grids[0].getBoundingClientRect();
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.top >= bounds.top &&
		rect.bottom <= bounds.bottom &&
		rect.left >= bounds.left &&
		rect.right <= bounds.right
	);
}

/** Only visible controls and trusted CDP input; no application state or capability injection. */
export async function exerciseDocumentPreviews({ cdp, directory, selectFile, record }) {
	await selectFile(cdp, previewFixture.docxName, true);
	await until(async () => {
		const page = await evaluate(cdp, `(${documentPreviewState.toString()})(document)`);
		return (
			page?.path === previewFixture.docxName &&
			page.text === previewFixture.docxText &&
			!page.loading &&
			page.alerts.length === 0 &&
			page.note.startsWith("Plain-text Word preview.") &&
			page.editableElements === 0
		);
	}, "DOCX exact plain text including literal markup and Chinese");
	await capture(cdp, directory, "file-docx-preview");
	await click(cdp, ".file-buffer button", "Close preview");
	record({ docxPreview: true });
	await selectFile(cdp, previewFixture.xlsxName, true);
	await until(async () => {
		const state = await evaluate(cdp, `(${documentPreviewState.toString()})(document)`);
		try {
			assertContinuousSpreadsheet(state);
			return true;
		} catch {
			return false;
		}
	}, "all XLSX sheets and exact saved values in one continuous preview");
	// Visit both real sheet surfaces and return, without transport-page controls.
	for (const name of [previewFixture.sheetName, previewFixture.secondSheetName, previewFixture.sheetName]) {
		await click(cdp, `.file-preview-grid[aria-label="${name}"]`);
		await until(
			() => evaluate(cdp, `(${focusedSheetVisible.toString()})(document, ${JSON.stringify(name)})`),
			"exact sheet focused and visible inside the preview scroll surface",
		);
		assertContinuousSpreadsheet(await evaluate(cdp, `(${documentPreviewState.toString()})(document)`));
	}
	await capture(cdp, directory, "file-xlsx-saved-values");
	await click(cdp, ".file-buffer button", "Close preview");
	record({ xlsxPreview: true, xlsxSavedValues: true, xlsxContinuousSheets: true });
	await selectFile(cdp, previewFixture.pdfName, true);
	const initial = await inspectPdf(cdp, 1);
	await capture(cdp, directory, "file-pdf-preview");
	await click(cdp, '.file-buffer[aria-label="Preview"] select');
	assert.ok(
		await evaluate(
			cdp,
			`document.activeElement === document.querySelector('.file-buffer[aria-label="Preview"] select')`,
		),
	);
	await pressKey(cdp, "Home");
	for (let index = 0; index < 4; index++)
		for (const type of ["keyDown", "keyUp"])
			await cdp.request("Input.dispatchKeyEvent", {
				type,
				key: "ArrowDown",
				code: "ArrowDown",
				windowsVirtualKeyCode: 40,
			});
	await pressKey(cdp, "Enter");
	const zoomed = await inspectPdf(cdp, 1.5);
	await capture(cdp, directory, "file-pdf-zoom");
	await click(cdp, ".file-buffer button", "Close preview");
	await until(
		() => evaluate(cdp, `!document.querySelector('.file-buffer[aria-label="Preview"], .file-workbench canvas')`),
		"PDF presentation removed",
	);
	await selectFile(cdp, previewFixture.pdfName, true);
	await inspectPdf(cdp, 1);
	await click(cdp, ".file-buffer button", "Close preview");
	await assertNoAlerts(cdp);
	record({ pdfPreview: true, pdfZoom: true, pdfReopenResetsZoom: true, pdfPaint: { initial, zoomed } });
	return {
		docxPreview: true,
		xlsxPreview: true,
		xlsxSavedValues: true,
		xlsxContinuousSheets: true,
		pdfPreview: true,
		pdfZoom: true,
		pdfReopenResetsZoom: true,
	};
}
