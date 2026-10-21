import { FileServiceError } from "@hipi/work-runtime/files";
import {
	DOCUMENT_LIMITS,
	type DocumentPreview,
	DocumentPreviewError,
	validateDocumentPreview,
} from "@hipi/work-runtime/previews/contracts";

// Every tabular transport fragment contains rows or one empty sheet. The DOCX
// transport uses larger text fragments; this bound covers both existing formats.
export const MAX_DOCUMENT_PREVIEW_CHUNKS = DOCUMENT_LIMITS.sheets * (DOCUMENT_LIMITS.rows + 1);

/** Restore the service's already-bounded document; transport chunks are not document pages. */
export function appendPreviewDocument(
	current: DocumentPreview | undefined,
	fragment: DocumentPreview,
): DocumentPreview {
	try {
		const next = validateDocumentPreview(fragment);
		if (!current) return next;
		if (current.kind !== next.kind || current.format !== next.format) throw new FileServiceError("BLOCKED_RESOURCE");
		const common = {
			truncated: current.truncated || next.truncated,
			limitations: [...new Set([...current.limitations, ...next.limitations])],
		};
		if (current.kind === "document" && next.kind === "document") {
			if (current.text.length + next.text.length > DOCUMENT_LIMITS.textCharacters)
				throw new FileServiceError("LIMIT_EXCEEDED");
			return validateDocumentPreview({ ...current, ...common, text: current.text + next.text });
		}
		if (current.kind !== "spreadsheet" || next.kind !== "spreadsheet") throw new FileServiceError("BLOCKED_RESOURCE");
		const sheets = current.sheets.map((sheet) => ({ ...sheet, rows: [...sheet.rows] }));
		for (const sheet of next.sheets) {
			const previous = sheets.at(-1);
			if (previous?.name === sheet.name) {
				if (previous.rows.length + sheet.rows.length > DOCUMENT_LIMITS.rows)
					throw new FileServiceError("LIMIT_EXCEEDED");
				previous.rows.push(...sheet.rows);
			} else {
				if (sheets.some((value) => value.name === sheet.name)) throw new FileServiceError("BLOCKED_RESOURCE");
				if (sheets.length === DOCUMENT_LIMITS.sheets) throw new FileServiceError("LIMIT_EXCEEDED");
				sheets.push({ ...sheet, rows: [...sheet.rows] });
			}
		}
		// This applies the original whole-document 1 MiB bound, not a per-fragment allowance.
		return validateDocumentPreview({ ...current, ...common, sheets });
	} catch (error) {
		if (error instanceof FileServiceError) throw error;
		throw new FileServiceError(
			error instanceof DocumentPreviewError && error.code === "DOCUMENT_LIMIT" ? "LIMIT_EXCEEDED" : "BLOCKED_RESOURCE",
		);
	}
}
