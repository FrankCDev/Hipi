import { AppError, LIMITS } from "../contracts.ts";

export function encodeNavigationCursor(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeNavigationCursor(raw: string, keys: string[]): Record<string, unknown> {
	try {
		if (raw.length > LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
		const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join() !== keys.sort().join()
		)
			throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new AppError("INVALID_REQUEST");
	}
}
