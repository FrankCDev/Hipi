import { validateRelativePath } from "../files/contracts.ts";

export const FILE_PRESENTATION_BYTES = 65536;
export type FilePresentation = {
	version: 1;
	target: { rootId: string; path: string };
	result:
		| { kind: "read"; revision: string; text: string; offset: number; nextOffset: number | null; textLength: number }
		| {
				kind: "directory";
				entries: { name: string; path: string; kind: "file" | "directory" | "blocked" }[];
				hasMore: boolean;
		  }
		| { kind: "save"; operationId: string; revision: string; bytes: number };
};
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error("Invalid file presentation");
	return value as Record<string, unknown>;
}
function string(value: unknown, max: number, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.length) || value.length > max || /[\ud800-\udfff]/u.test(value))
		throw new Error("Invalid presentation string");
	return value;
}
function count(value: unknown, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
		throw new Error("Invalid presentation count");
	return value;
}
function revision(value: unknown): string {
	const result = string(value, 64);
	if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("Invalid presentation revision");
	return result;
}
/** Strict browser-safe schema; never forwards unknown details, raw arguments or diagnostics. */
export function parseFilePresentation(value: unknown): FilePresentation {
	if (bytes(JSON.stringify(value) ?? "") > FILE_PRESENTATION_BYTES) throw new Error("Oversized file presentation");
	const envelope = record(value, ["version", "target", "result"]);
	if (envelope.version !== 1) throw new Error("Unknown file presentation");
	const target = record(envelope.target, ["rootId", "path"]);
	const raw = record(envelope.result, [
		"kind",
		"revision",
		"text",
		"offset",
		"nextOffset",
		"textLength",
		"entries",
		"hasMore",
		"operationId",
		"bytes",
	]);
	let result: FilePresentation["result"];
	if (raw.kind === "read") {
		record(raw, ["kind", "revision", "text", "offset", "nextOffset", "textLength"]);
		const text = string(raw.text, 8192, true),
			offset = count(raw.offset, 131072),
			textLength = count(raw.textLength, 131072);
		if (
			bytes(text) > 8192 ||
			(text.length === 0 && raw.nextOffset !== null) ||
			offset + text.length > textLength ||
			raw.nextOffset !== (offset + text.length < textLength ? offset + text.length : null)
		)
			throw new Error("Invalid read page");
		result = {
			kind: "read",
			revision: revision(raw.revision),
			text,
			offset,
			nextOffset: raw.nextOffset as number | null,
			textLength,
		};
	} else if (raw.kind === "directory") {
		record(raw, ["kind", "entries", "hasMore"]);
		if (
			!Array.isArray(raw.entries) ||
			raw.entries.length > 50 ||
			bytes(JSON.stringify(raw.entries)) > 16384 ||
			typeof raw.hasMore !== "boolean"
		)
			throw new Error("Invalid directory page");
		const entries = raw.entries.map((value) => {
			const item = record(value, ["name", "path", "kind"]);
			if (item.kind !== "file" && item.kind !== "directory" && item.kind !== "blocked")
				throw new Error("Invalid directory kind");
			const name = string(item.name, 255),
				path = string(item.path, 2304);
			if (item.kind !== "blocked") validateRelativePath(path);
			return { name, path, kind: item.kind as "file" | "directory" | "blocked" };
		});
		result = { kind: "directory", entries, hasMore: raw.hasMore };
	} else if (raw.kind === "save") {
		record(raw, ["kind", "operationId", "revision", "bytes"]);
		result = {
			kind: "save",
			operationId: string(raw.operationId, 128),
			revision: revision(raw.revision),
			bytes: count(raw.bytes, 65536),
		};
	} else throw new Error("Unknown file presentation kind");
	return {
		version: 1,
		target: {
			rootId: string(target.rootId, 128),
			path: validateRelativePath(target.path, result.kind === "directory"),
		},
		result,
	};
}

/** Optional display metadata must NEVER turn a successful external effect into a failed tool/retry. */
export function filePresentationDetails(target: FilePresentation["target"], result: FilePresentation["result"]) {
	try {
		return { hipiFiles: parseFilePresentation({ version: 1, target, result }) };
	} catch {
		return undefined;
	}
}
