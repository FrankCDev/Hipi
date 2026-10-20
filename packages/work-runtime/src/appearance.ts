/** Device appearance only. No renderer transport, filesystem, or OS handles cross this contract. */
export const APPEARANCE_LIMITS = { faces: 2048, families: 512, name: 128, requestBytes: 512 } as const;
export type AppearanceErrorCode = "UNSUPPORTED" | "DENIED" | "BUSY" | "CLOSED" | "INVALID" | "FAILED";
export class AppearanceError extends Error {
	readonly code: AppearanceErrorCode;
	constructor(code: AppearanceErrorCode) {
		super(code);
		this.name = "AppearanceError";
		this.code = code;
	}
}
export type InstalledFontFace = { family: string; fullName: string; postscriptName: string; style: string };
/** null means the host cannot report an authoritative spacing classification. */
export type InstalledFontFamily = { family: string; faces: InstalledFontFace[]; monospace: boolean | null };
export type InstalledFontCatalog = { families: InstalledFontFamily[]; truncated: boolean };
export type AppearanceThemeMode = "system" | "light" | "dark";
export type AppearanceStatus = {
	version: 1;
	platform: "macos" | "windows" | "linux" | "web" | "other";
	backdrop: "vibrancy" | "mica" | "unsupported";
	reducedTransparency: boolean;
	backdropEnabled: boolean;
	fontSmoothing: boolean;
	/** The app-scoped native preference; null means this host owns no native chrome. */
	themeMode: AppearanceThemeMode | null;
};
export type AppearanceRequest =
	| { version: 1; method: "status" }
	| { version: 1; method: "theme"; mode: AppearanceThemeMode }
	| { version: 1; method: "backdrop"; enabled: boolean; background: string };
export interface AppearanceClient {
	readonly localFontsSupported: boolean;
	status(signal?: AbortSignal): Promise<AppearanceStatus>;
	setThemeMode(mode: AppearanceThemeMode, signal?: AbortSignal): Promise<AppearanceStatus>;
	setBackdrop(enabled: boolean, background: string, signal?: AbortSignal): Promise<AppearanceStatus>;
	listFonts(signal?: AbortSignal): Promise<InstalledFontCatalog>;
	subscribe(listener: (status: AppearanceStatus) => void): () => void;
}
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppearanceError("INVALID");
	const prototype = Object.getPrototypeOf(value);
	if (
		(prototype !== null && prototype !== Object.prototype) ||
		Object.getOwnPropertySymbols(value).length ||
		Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !("value" in descriptor))
	)
		throw new AppearanceError("INVALID");
	return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
	const names = Object.getOwnPropertyNames(value);
	if (names.length !== keys.length || names.some((key) => !keys.includes(key))) throw new AppearanceError("INVALID");
}
/** Names are single CSS local names, never declarations, URLs, escapes, or shell arguments. */
export function validFontName(value: unknown): value is string {
	return typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._'+(),-]{0,127}$/u.test(value);
}
export function parseInstalledFontFace(value: unknown): InstalledFontFace {
	const input = record(value);
	exact(input, ["family", "fullName", "postscriptName", "style"]);
	if (
		!validFontName(input.family) ||
		!validFontName(input.fullName) ||
		!validFontName(input.postscriptName) ||
		!validFontName(input.style)
	)
		throw new AppearanceError("INVALID");
	return { family: input.family, fullName: input.fullName, postscriptName: input.postscriptName, style: input.style };
}
export function parseInstalledFontCatalog(value: unknown): InstalledFontCatalog {
	const input = record(value);
	exact(input, ["families", "truncated"]);
	if (
		!Array.isArray(input.families) ||
		input.families.length > APPEARANCE_LIMITS.families ||
		typeof input.truncated !== "boolean"
	)
		throw new AppearanceError("INVALID");
	let count = 0;
	const names = new Set<string>();
	const faces = new Set<string>();
	const families = input.families.map((candidate) => {
		const group = record(candidate);
		exact(group, ["family", "faces", "monospace"]);
		if (
			!validFontName(group.family) ||
			names.has(group.family) ||
			!Array.isArray(group.faces) ||
			!group.faces.length ||
			(typeof group.monospace !== "boolean" && group.monospace !== null)
		)
			throw new AppearanceError("INVALID");
		names.add(group.family);
		count += group.faces.length;
		if (count > APPEARANCE_LIMITS.faces) throw new AppearanceError("INVALID");
		const parsed = group.faces.map((candidate) => {
			const face = parseInstalledFontFace(candidate);
			if (face.family !== group.family || faces.has(face.postscriptName)) throw new AppearanceError("INVALID");
			faces.add(face.postscriptName);
			return face;
		});
		return { family: group.family, faces: parsed, monospace: group.monospace };
	});
	return { families, truncated: input.truncated };
}
/** Accept only real face metadata. A partial result is visibly marked, never filled with guessed faces. */
export function buildInstalledFontCatalog(
	entries: readonly { face: unknown; monospace: boolean | null }[],
	partial = false,
): InstalledFontCatalog {
	const groups = new Map<string, InstalledFontFamily>();
	const seen = new Set<string>();
	let truncated = partial || entries.length > APPEARANCE_LIMITS.faces;
	for (const entry of entries.slice(0, APPEARANCE_LIMITS.faces)) {
		try {
			const face = parseInstalledFontFace(entry.face);
			if (seen.has(face.postscriptName)) continue;
			seen.add(face.postscriptName);
			const group = groups.get(face.family);
			if (group) {
				group.faces.push(face);
				if (group.monospace !== entry.monospace) group.monospace = null;
			} else if (groups.size < APPEARANCE_LIMITS.families)
				groups.set(face.family, { family: face.family, faces: [face], monospace: entry.monospace });
			else truncated = true;
		} catch {
			truncated = true;
		}
	}
	return {
		truncated,
		families: [...groups.values()]
			.sort((a, b) => a.family.localeCompare(b.family))
			.map((group) => ({
				...group,
				faces: group.faces.sort((a, b) => {
					const regular = (style: string) => /^(regular|normal|roman|book)$/i.test(style);
					return regular(a.style) === regular(b.style)
						? a.style.localeCompare(b.style)
						: regular(a.style)
							? -1
							: 1;
				}),
			})),
	};
}
export function parseFontReply(value: unknown): InstalledFontCatalog {
	const input = record(value);
	if (input.ok === false) {
		// Error envelopes have the same bounded schema on both channels.
		parseAppearanceReply(input);
		throw new AppearanceError("INVALID");
	}
	exact(input, ["ok", "result"]);
	if (input.ok !== true) throw new AppearanceError("INVALID");
	return parseInstalledFontCatalog(input.result);
}
export function parseAppearanceRequest(value: unknown): AppearanceRequest {
	const input = record(value);
	if (input.version !== 1) throw new AppearanceError("INVALID");
	if (input.method === "status") {
		exact(input, ["version", "method"]);
		return { version: 1, method: "status" };
	}
	if (input.method === "theme") {
		exact(input, ["version", "method", "mode"]);
		if (input.mode !== "system" && input.mode !== "light" && input.mode !== "dark")
			throw new AppearanceError("INVALID");
		return { version: 1, method: "theme", mode: input.mode };
	}
	exact(input, ["version", "method", "enabled", "background"]);
	if (
		input.method !== "backdrop" ||
		typeof input.enabled !== "boolean" ||
		typeof input.background !== "string" ||
		!/^#[0-9a-fA-F]{6}$/.test(input.background)
	)
		throw new AppearanceError("INVALID");
	return { version: 1, method: "backdrop", enabled: input.enabled, background: input.background };
}
export function parseAppearanceStatus(value: unknown): AppearanceStatus {
	const input = record(value);
	exact(input, [
		"version",
		"platform",
		"backdrop",
		"reducedTransparency",
		"backdropEnabled",
		"fontSmoothing",
		"themeMode",
	]);
	if (
		input.version !== 1 ||
		typeof input.platform !== "string" ||
		!["macos", "windows", "linux", "web", "other"].includes(input.platform) ||
		typeof input.backdrop !== "string" ||
		!["vibrancy", "mica", "unsupported"].includes(input.backdrop) ||
		typeof input.reducedTransparency !== "boolean" ||
		typeof input.backdropEnabled !== "boolean" ||
		typeof input.fontSmoothing !== "boolean" ||
		(input.themeMode !== null &&
			input.themeMode !== "system" &&
			input.themeMode !== "light" &&
			input.themeMode !== "dark") ||
		(input.backdropEnabled && (input.backdrop === "unsupported" || input.reducedTransparency))
	)
		throw new AppearanceError("INVALID");
	return input as AppearanceStatus;
}
export function parseAppearanceReply(value: unknown): AppearanceStatus {
	const input = record(value);
	if (input.ok === false) {
		exact(input, ["ok", "error"]);
		if (
			typeof input.error !== "string" ||
			!["UNSUPPORTED", "DENIED", "BUSY", "CLOSED", "INVALID", "FAILED"].includes(input.error)
		)
			throw new AppearanceError("INVALID");
		throw new AppearanceError(input.error as AppearanceErrorCode);
	}
	exact(input, ["ok", "result"]);
	if (input.ok !== true) throw new AppearanceError("INVALID");
	return parseAppearanceStatus(input.result);
}
