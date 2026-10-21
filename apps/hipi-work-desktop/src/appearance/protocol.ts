import { APPEARANCE_LIMITS, AppearanceError, parseAppearanceRequest } from "@hipi/work-runtime/appearance";

export const APPEARANCE_CHANNEL = "hipi-work:appearance:v1";
export const APPEARANCE_UPDATED = "hipi-work:appearance-updated:v1";
export const FONT_CHANNEL = "hipi-work:fonts:v1";
export const FONT_CANCEL_CHANNEL = "hipi-work:font-cancel:v1";
export function decodeFontRequest(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 128) throw new AppearanceError("INVALID");
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppearanceError("INVALID");
		const input = value as Record<string, unknown>;
		if (
			Object.keys(input).length !== 2 ||
			input.version !== 1 ||
			typeof input.id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id)
		)
			throw new AppearanceError("INVALID");
		return input.id;
	} catch {
		throw new AppearanceError("INVALID");
	}
}
export function decodeAppearanceRequest(raw: unknown) {
	if (
		typeof raw !== "string" ||
		raw.length > APPEARANCE_LIMITS.requestBytes ||
		new TextEncoder().encode(raw).byteLength > APPEARANCE_LIMITS.requestBytes
	)
		throw new AppearanceError("INVALID");
	try {
		return parseAppearanceRequest(JSON.parse(raw));
	} catch {
		throw new AppearanceError("INVALID");
	}
}
