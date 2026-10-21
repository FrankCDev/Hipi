import { validateRelativePath } from "../files/contracts.ts";
import type { ToolActivity } from "./contracts.ts";

export const FILE_PRESENTATION_BYTES = 65536;
/** Relative paths need at most three UTF-8 bytes per code unit; identifiers are ASCII.
 * The 2048-unit path, two 128-unit IDs and JSON framing fit below this independent cap. */
export const FILE_SUMMARY_BYTES = 8192;
export type FileSummary = { version: 1; target: { rootId: string; path: string } } & (
	| { kind: "read" | "directory"; partial: boolean }
	| { kind: "save"; partial: false; operationId: string }
);
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
function identifier(value: unknown): string {
	const result = string(value, 128);
	if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("Invalid file summary identifier");
	return result;
}
/** Header facts have a separate strict schema and never contain retained result bodies. */
export function parseFileSummary(value: unknown): FileSummary {
	if (bytes(JSON.stringify(value) ?? "") > FILE_SUMMARY_BYTES) throw new Error("Oversized file summary");
	const summary = record(value, ["version", "target", "kind", "partial", "operationId"]);
	if (summary.version !== 1 || typeof summary.partial !== "boolean") throw new Error("Invalid file summary");
	const rawTarget = record(summary.target, ["rootId", "path"]);
	const target = {
		rootId: identifier(rawTarget.rootId),
		path: validateRelativePath(rawTarget.path, summary.kind === "directory"),
	};
	if (summary.kind === "save") {
		if (summary.partial) throw new Error("Invalid save summary");
		return { version: 1, target, kind: "save", partial: false, operationId: identifier(summary.operationId) };
	}
	record(summary, ["version", "target", "kind", "partial"]);
	if (summary.kind !== "read" && summary.kind !== "directory") throw new Error("Unknown file summary kind");
	return { version: 1, target, kind: summary.kind, partial: summary.partial };
}

/** Shared producer/client invariant: an optional header must not contradict execution or effect facts. */
export function fileSummaryMatchesActivity(summary: FileSummary, activity: ToolActivity): boolean {
	const toolName =
		summary.kind === "directory"
			? "hipi_files_list"
			: summary.kind === "read"
				? "hipi_files_read"
				: "hipi_files_save";
	if (
		activity.source !== "task" ||
		activity.inherited ||
		!activity.taskId ||
		!activity.anchor ||
		!activity.resultEntryId ||
		activity.parentTaskId !== undefined ||
		activity.phase !== "terminal" ||
		activity.outcome !== "completed" ||
		activity.toolResult !== "success" ||
		activity.toolName !== toolName ||
		(activity.effect !== undefined && activity.effect.status !== "confirmed") ||
		(activity.artifact !== undefined &&
			(activity.artifact.status !== "confirmed" ||
				activity.artifact.rootId !== summary.target.rootId ||
				activity.artifact.path !== summary.target.path))
	)
		return false;
	return (
		summary.kind !== "save" ||
		(activity.effect?.status === "confirmed" &&
			activity.effect.operationId === summary.operationId &&
			activity.artifact?.status === "confirmed" &&
			activity.artifact.operationId === summary.operationId)
	);
}

export function summarizeFilePresentation(
	presentation: FilePresentation,
	activity: ToolActivity,
): FileSummary | undefined {
	const result = presentation.result;
	try {
		const summary = parseFileSummary({
			version: 1,
			target: presentation.target,
			kind: result.kind,
			partial:
				result.kind === "read"
					? result.offset > 0 || result.nextOffset !== null
					: result.kind === "directory" && result.hasMore,
			...(result.kind === "save" ? { operationId: result.operationId } : {}),
		});
		return fileSummaryMatchesActivity(summary, activity) ? summary : undefined;
	} catch {
		return undefined;
	}
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
