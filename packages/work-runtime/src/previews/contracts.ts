/** Browser-safe, deliberately lossy preview data. Never render strings as HTML. */
export type DocumentFormat = "docx" | "xlsx" | "csv";

export const DOCUMENT_LIMITS = Object.freeze({
	inputBytes: 8 * 1024 * 1024,
	outputBytes: 1024 * 1024,
	zipBytes: 32 * 1024 * 1024,
	zipEntryBytes: 8 * 1024 * 1024,
	zipEntries: 2048,
	compressionRatio: 100,
	rows: 200,
	columns: 50,
	sheets: 8,
	cellCharacters: 4096,
	textCharacters: 120_000,
	concurrency: 2,
	queue: 8,
	timeoutMs: 5000,
});

export interface PreviewCell {
	type: "string" | "number" | "boolean" | "date" | "error" | "empty";
	value: string | number | boolean | null;
	display: string;
}

export interface PreviewSheet {
	name: string;
	rows: PreviewCell[][];
}

export type DocumentPreview =
	| { kind: "document"; format: "docx"; text: string; truncated: boolean; limitations: string[] }
	| { kind: "spreadsheet"; format: "xlsx" | "csv"; sheets: PreviewSheet[]; truncated: boolean; limitations: string[] };

export type DocumentPreviewErrorCode =
	| "INVALID_DOCUMENT"
	| "UNSAFE_DOCUMENT"
	| "DOCUMENT_LIMIT"
	| "PARSER_BUSY"
	| "PARSER_TIMEOUT"
	| "PARSER_CLOSED"
	| "ABORTED";

export class DocumentPreviewError extends Error {
	readonly code: DocumentPreviewErrorCode;
	constructor(code: DocumentPreviewErrorCode) {
		super(code);
		this.name = "DocumentPreviewError";
		this.code = code;
	}
}

export function isDocumentFormat(value: unknown): value is DocumentFormat {
	return value === "docx" || value === "xlsx" || value === "csv";
}

export function isDocumentPreviewErrorCode(value: unknown): value is DocumentPreviewErrorCode {
	return (
		typeof value === "string" &&
		[
			"INVALID_DOCUMENT",
			"UNSAFE_DOCUMENT",
			"DOCUMENT_LIMIT",
			"PARSER_BUSY",
			"PARSER_TIMEOUT",
			"PARSER_CLOSED",
			"ABORTED",
		].includes(value)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

/** Rebuild DTOs at transport boundaries; do not forward unchecked extra properties. */
export function validateDocumentPreview(value: unknown): DocumentPreview {
	if (
		!isRecord(value) ||
		typeof value.truncated !== "boolean" ||
		!Array.isArray(value.limitations) ||
		value.limitations.length > 8 ||
		!value.limitations.every((item: unknown) => typeof item === "string" && item.length <= 128)
	)
		throw new DocumentPreviewError("INVALID_DOCUMENT");
	const limitations: string[] = value.limitations;
	let collectedBytes = 0;
	const encoder = new TextEncoder();
	let result: DocumentPreview;
	if (
		value.kind === "document" &&
		value.format === "docx" &&
		typeof value.text === "string" &&
		value.text.length <= DOCUMENT_LIMITS.textCharacters &&
		onlyKeys(value, ["kind", "format", "text", "truncated", "limitations"])
	) {
		result = { kind: "document", format: "docx", text: value.text, truncated: value.truncated, limitations };
	} else if (
		value.kind === "spreadsheet" &&
		(value.format === "csv" || value.format === "xlsx") &&
		Array.isArray(value.sheets) &&
		value.sheets.length <= DOCUMENT_LIMITS.sheets &&
		onlyKeys(value, ["kind", "format", "sheets", "truncated", "limitations"])
	) {
		const sheets: PreviewSheet[] = [];
		for (const sheet of value.sheets) {
			if (
				!isRecord(sheet) ||
				typeof sheet.name !== "string" ||
				sheet.name.length > 128 ||
				!Array.isArray(sheet.rows) ||
				sheet.rows.length > DOCUMENT_LIMITS.rows ||
				!onlyKeys(sheet, ["name", "rows"])
			)
				throw new DocumentPreviewError("INVALID_DOCUMENT");
			const rows: PreviewCell[][] = [];
			for (const row of sheet.rows) {
				if (!Array.isArray(row) || row.length > DOCUMENT_LIMITS.columns)
					throw new DocumentPreviewError("INVALID_DOCUMENT");
				const cells: PreviewCell[] = [];
				for (const cell of row) {
					if (
						!isRecord(cell) ||
						typeof cell.display !== "string" ||
						cell.display.length > DOCUMENT_LIMITS.cellCharacters ||
						!onlyKeys(cell, ["type", "value", "display"])
					)
						throw new DocumentPreviewError("INVALID_DOCUMENT");
					const type = cell.type;
					const valid =
						(type === "empty" && cell.value === null) ||
						(type === "number" && typeof cell.value === "number" && Number.isFinite(cell.value)) ||
						(type === "boolean" && typeof cell.value === "boolean") ||
						((type === "string" || type === "date" || type === "error") &&
							typeof cell.value === "string" &&
							cell.value.length <= DOCUMENT_LIMITS.cellCharacters);
					if (!valid) throw new DocumentPreviewError("INVALID_DOCUMENT");
					const safeCell = { type, value: cell.value, display: cell.display } as PreviewCell;
					collectedBytes += encoder.encode(JSON.stringify(safeCell)).byteLength + 1;
					// Reject before rebuilding an attacker-controlled large grid or serializing it.
					if (collectedBytes > DOCUMENT_LIMITS.outputBytes) throw new DocumentPreviewError("DOCUMENT_LIMIT");
					// The discriminated scalar checks above establish this bounded data shape.
					cells.push(safeCell);
				}
				rows.push(cells);
			}
			sheets.push({ name: sheet.name, rows });
		}
		result = { kind: "spreadsheet", format: value.format, sheets, truncated: value.truncated, limitations };
	} else throw new DocumentPreviewError("INVALID_DOCUMENT");
	if (new TextEncoder().encode(JSON.stringify(result)).byteLength > DOCUMENT_LIMITS.outputBytes)
		throw new DocumentPreviewError("DOCUMENT_LIMIT");
	return result;
}
