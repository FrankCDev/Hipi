import mammoth from "mammoth";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
	DOCUMENT_LIMITS,
	type DocumentFormat,
	type DocumentPreview,
	DocumentPreviewError,
	type PreviewCell,
	type PreviewSheet,
	validateDocumentPreview,
} from "./contracts.ts";
import { inspectOfficeZip } from "./zip-budget.ts";

/** Internal worker entry only. Hosts must use DocumentParserPool, never call on their event loop. */
export async function parseDocumentBytes(format: DocumentFormat, bytes: Uint8Array): Promise<DocumentPreview> {
	if (bytes.byteLength > DOCUMENT_LIMITS.inputBytes) throw new DocumentPreviewError("DOCUMENT_LIMIT");
	if (bytes.byteLength === 0) throw new DocumentPreviewError("INVALID_DOCUMENT");
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (format !== "csv") await inspectOfficeZip(buffer, format);
	if (format === "docx") {
		// extractRawText does not invoke HTML/image conversion or external resource loading.
		const result = await mammoth.extractRawText({ buffer });
		return validateDocumentPreview({
			kind: "document",
			format,
			text: result.value.slice(0, DOCUMENT_LIMITS.textCharacters),
			truncated: result.value.length > DOCUMENT_LIMITS.textCharacters,
			limitations: ["plain-text-only", "layout-images-and-embedded-content-omitted"],
		});
	}
	const sheets: PreviewSheet[] = [];
	let truncated = false;
	// Account for JSON escaping (up to six bytes per UTF-16 code unit), keys and structure
	// before collecting output. This is deliberately conservative and below the wire cap.
	let remaining = DOCUMENT_LIMITS.outputBytes - 8192;
	const bounded = (value: string): string => {
		if (value.length > DOCUMENT_LIMITS.cellCharacters) truncated = true;
		return value.slice(0, DOCUMENT_LIMITS.cellCharacters);
	};
	const append = (row: PreviewCell[], cell: PreviewCell): boolean => {
		const cost = 100 + 6 * (cell.display.length + (typeof cell.value === "string" ? cell.value.length : 32));
		if (remaining < cost) {
			truncated = true;
			remaining = 0;
			return false;
		}
		remaining -= cost;
		row.push(cell);
		return true;
	};
	if (format === "csv") {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		if (text.includes("\0")) throw new DocumentPreviewError("INVALID_DOCUMENT");
		const rows: PreviewCell[][] = [];
		let invalid = false;
		Papa.parse<string[]>(text, {
			download: false,
			worker: false,
			dynamicTyping: false,
			skipEmptyLines: false,
			step(result, parser) {
				if (result.errors.some((error) => error.code !== "UndetectableDelimiter")) {
					invalid = true;
					parser.abort();
					return;
				}
				if (rows.length >= DOCUMENT_LIMITS.rows) {
					truncated = true;
					parser.abort();
					return;
				}
				const row: PreviewCell[] = [];
				if (result.data.length > DOCUMENT_LIMITS.columns) truncated = true;
				for (const raw of result.data.slice(0, DOCUMENT_LIMITS.columns)) {
					const value = bounded(raw);
					if (!append(row, { type: "string", value, display: value })) {
						parser.abort();
						break;
					}
				}
				rows.push(row);
			},
		});
		if (invalid) throw new DocumentPreviewError("INVALID_DOCUMENT");
		sheets.push({ name: "CSV", rows });
	} else {
		// Library allocation is bounded by the ZIP preflight, worker heap and timeout.
		// Restrict parsed rows/sheets as well as the projected grid; no recalculation occurs.
		const workbook = XLSX.read(buffer, {
			type: "buffer",
			sheetRows: DOCUMENT_LIMITS.rows + 1,
			sheets: Array.from({ length: DOCUMENT_LIMITS.sheets }, (_, i) => i),
			cellFormula: false,
			cellHTML: false,
			cellDates: true,
			cellText: true,
			bookVBA: false,
			bookDeps: false,
			bookFiles: false,
		});
		if (workbook.SheetNames.length > DOCUMENT_LIMITS.sheets) truncated = true;
		for (const name of workbook.SheetNames.slice(0, DOCUMENT_LIMITS.sheets)) {
			const sheet = workbook.Sheets[name];
			if (!sheet) continue;
			const rows: PreviewCell[][] = [];
			const range = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
			if (range.e.r >= DOCUMENT_LIMITS.rows || range.e.c >= DOCUMENT_LIMITS.columns) truncated = true;
			for (let r = 0; r <= Math.min(range.e.r, DOCUMENT_LIMITS.rows - 1); r++) {
				const row: PreviewCell[] = [];
				for (let c = 0; c <= Math.min(range.e.c, DOCUMENT_LIMITS.columns - 1); c++) {
					const cell: XLSX.CellObject | undefined = sheet[XLSX.utils.encode_cell({ r, c })];
					let type: PreviewCell["type"] = "empty";
					let value: PreviewCell["value"] = null;
					if (cell?.t === "d" && cell.v instanceof Date && Number.isFinite(cell.v.getTime())) {
						type = "date";
						value = cell.v.toISOString();
					} else if (cell?.t === "n" && typeof cell.v === "number" && Number.isFinite(cell.v)) {
						type = "number";
						value = cell.v;
					} else if (cell?.t === "b" && typeof cell.v === "boolean") {
						type = "boolean";
						value = cell.v;
					} else if (cell?.t === "e") {
						type = "error";
						value = bounded(cell.w ?? "#ERROR");
					} else if (typeof cell?.v === "string") {
						type = "string";
						value = bounded(cell.v);
					}
					const display = bounded(cell?.w ?? (value === null ? "" : String(value)));
					if (!append(row, { type, value, display })) break;
				}
				rows.push(row);
				if (remaining < 300) break;
			}
			sheets.push({ name: name.slice(0, 128), rows });
			if (remaining < 300) break;
		}
	}
	return validateDocumentPreview({
		kind: "spreadsheet",
		format,
		sheets,
		truncated,
		limitations:
			format === "csv"
				? ["utf8-only", "string-cells-only"]
				: ["cached-values-not-recalculated", "grid-only-no-layout-charts-or-macros"],
	});
}
