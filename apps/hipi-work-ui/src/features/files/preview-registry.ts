import type { PreviewKind } from "@hipi/work-runtime/previews/protocol";

type Handler = {
	readonly source: "pages" | "bytes";
	readonly view: "document" | "pdf" | "image";
	readonly maxBytes: number;
};
/** Built-ins only. Keys are service-validated kinds, never filename guesses or executable plugin data. */
export const PREVIEW_HANDLERS = Object.freeze({
	docx: { source: "pages", view: "document", maxBytes: 8 * 1024 * 1024 },
	xlsx: { source: "pages", view: "document", maxBytes: 8 * 1024 * 1024 },
	csv: { source: "pages", view: "document", maxBytes: 8 * 1024 * 1024 },
	pdf: { source: "bytes", view: "pdf", maxBytes: 20 * 1024 * 1024 },
	png: { source: "bytes", view: "image", maxBytes: 10 * 1024 * 1024 },
	jpeg: { source: "bytes", view: "image", maxBytes: 10 * 1024 * 1024 },
} satisfies Record<PreviewKind, Handler>);
