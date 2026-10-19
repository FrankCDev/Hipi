import { PDF_LOCAL_ASSETS } from "./pdf-assets.generated.ts";

const MAX_RESOURCE_BYTES = 512 * 1024;
/** Only package-reviewed inline assets. No fetch, document URL, filesystem path, or network fallback. */
export class LocalPdfData {
	async fetch(input: { kind?: unknown; filename?: unknown }): Promise<Uint8Array<ArrayBuffer>> {
		if ((input.kind !== "cMapUrl" && input.kind !== "standardFontDataUrl") || typeof input.filename !== "string")
			throw new Error("Unsupported PDF resource");
		const assets: Readonly<Record<string, string>> = PDF_LOCAL_ASSETS[input.kind];
		if (!Object.hasOwn(assets, input.filename)) throw new Error("Unknown PDF resource");
		const value = assets[input.filename];
		if (!value || !/^data:[^;,]+;base64,/.test(value)) throw new Error("PDF resource was not bundled inline");
		const base64 = value.slice(value.indexOf(",") + 1);
		if (base64.length > Math.ceil(MAX_RESOURCE_BYTES / 3) * 4) throw new Error("PDF resource limit");
		const decoded = atob(base64);
		if (decoded.length > MAX_RESOURCE_BYTES) throw new Error("PDF resource limit");
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	}
}
