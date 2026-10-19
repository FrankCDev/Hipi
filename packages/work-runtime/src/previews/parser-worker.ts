import { parentPort } from "node:worker_threads";
import { DocumentPreviewError, isDocumentFormat } from "./contracts.ts";
import { parseDocumentBytes } from "./parsers.ts";

const port = parentPort;
if (!port) throw new Error("PARSER_WORKER_REQUIRED");
port.once("message", async (request: unknown) => {
	try {
		if (
			typeof request !== "object" ||
			request === null ||
			!("format" in request) ||
			!isDocumentFormat(request.format) ||
			!("bytes" in request) ||
			!(request.bytes instanceof Uint8Array)
		)
			throw new DocumentPreviewError("INVALID_DOCUMENT");
		const preview = await parseDocumentBytes(request.format, request.bytes);
		port.postMessage({ ok: true, preview });
	} catch (error) {
		port.postMessage({ ok: false, code: error instanceof DocumentPreviewError ? error.code : "INVALID_DOCUMENT" });
	} finally {
		port.close();
	}
});
