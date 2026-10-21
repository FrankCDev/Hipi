import { parsePreviewRequest } from "@hipi/work-runtime/previews/protocol";
import { exact, identifier, record } from "../ipc/protocol.ts";

export const PREVIEW_CHANNEL = "hipi-work:previews:v1";
export const PREVIEW_CANCEL_CHANNEL = "hipi-work:preview-cancel:v1";

/** Only correlation IDs and public, root-relative preview requests cross preload. */
export function previewInvocation(raw: unknown) {
	const value = record(raw);
	exact(value, ["id", "request"]);
	return { id: identifier(value.id), request: parsePreviewRequest(value.request) };
}
