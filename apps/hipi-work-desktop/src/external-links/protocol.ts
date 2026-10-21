import { EXTERNAL_LINK_MAX_BYTES, parseExternalLinkRequest } from "@hipi/work-runtime/external-links";

export const EXTERNAL_LINK_CHANNEL = "hipi-work:external-link:v1";
export function decodeExternalLinkRequest(raw: unknown) {
	if (
		typeof raw !== "string" ||
		raw.length > EXTERNAL_LINK_MAX_BYTES * 2 ||
		new TextEncoder().encode(raw).byteLength > EXTERNAL_LINK_MAX_BYTES * 2
	)
		throw new TypeError("Invalid external link envelope");
	return parseExternalLinkRequest(JSON.parse(raw));
}
