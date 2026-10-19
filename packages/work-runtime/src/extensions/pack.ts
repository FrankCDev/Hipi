import { createHash } from "node:crypto";
import { PACK_ID_PATTERN, PACK_VERSION_PATTERN, TOOL_ID_PATTERN, TOOL_PACK_LIMITS } from "./pack-schema.ts";

export type ToolPackStep = Readonly<
	| { op: "normalizeNewlines" | "trimLineEnds" | "removeEmptyLines" | "deduplicateLines" }
	| { op: "literalReplace"; search: string; replacement: string }
>;
export interface ToolPackTool {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly pipeline: readonly ToolPackStep[];
}
export interface ToolPackManifest {
	readonly formatVersion: 1;
	readonly id: string;
	readonly version: string;
	readonly name: string;
	readonly description: string;
	readonly tools: readonly ToolPackTool[];
}
export interface ParsedToolPack {
	readonly manifest: ToolPackManifest;
	readonly canonicalId: string;
	/** SHA-256 of the supplied bytes, not reserialized JSON or a signature. */
	readonly digest: string;
}
export type ToolPackErrorCode =
	| "INVALID_PACK"
	| "PACK_TOO_LARGE"
	| "INVALID_INPUT"
	| "OUTPUT_TOO_LARGE"
	| "UNKNOWN_TOOL"
	| "CANCELLED";
export class ToolPackError extends Error {
	readonly code: ToolPackErrorCode;
	constructor(code: ToolPackErrorCode) {
		super(code);
		this.name = "ToolPackError";
		this.code = code;
	}
}
const validatedPacks = new WeakSet<ParsedToolPack>();
function invalid(): never {
	throw new ToolPackError("INVALID_PACK");
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return invalid();
	return value as Record<string, unknown>;
}
function string(value: unknown, maximum: number, minimum = 1, pattern?: string): string {
	if (typeof value !== "string" || /[\ud800-\udfff]/u.test(value) || value.length > maximum * 2) return invalid();
	const length = [...value].length;
	if (length < minimum || length > maximum || (pattern && !new RegExp(pattern, "u").test(value))) return invalid();
	return value;
}
function array(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > maximum) return invalid();
	return value;
}
function parseStep(value: unknown): ToolPackStep {
	if (typeof value !== "object" || value === null || !("op" in value)) return invalid();
	if (value.op === "literalReplace") {
		const item = record(value, ["op", "search", "replacement"]);
		return Object.freeze({
			op: "literalReplace",
			search: string(item.search, 1024),
			replacement: string(item.replacement, 1024, 0),
		});
	}
	const item = record(value, ["op"]);
	switch (item.op) {
		case "normalizeNewlines":
		case "trimLineEnds":
		case "removeEmptyLines":
		case "deduplicateLines":
			return Object.freeze({ op: item.op });
		default:
			return invalid();
	}
}

/** No filesystem access: callers supply a bounded UTF-8 byte snapshot. Never executes package code. */
export function parseToolPack(bytes: Uint8Array): ParsedToolPack {
	if (!(bytes instanceof Uint8Array)) return invalid();
	if (bytes.byteLength > TOOL_PACK_LIMITS.packageBytes) throw new ToolPackError("PACK_TOO_LARGE");
	// Own the snapshot before decoding and hashing, so subsequent caller mutations cannot change identity.
	const snapshot = Uint8Array.from(bytes);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot));
	} catch {
		return invalid();
	}
	const item = record(value, ["formatVersion", "id", "version", "name", "description", "tools"]);
	if (item.formatVersion !== 1) return invalid();
	const ids = new Set<string>();
	const manifest: ToolPackManifest = Object.freeze({
		formatVersion: 1,
		id: string(item.id, 64, 1, PACK_ID_PATTERN),
		version: string(item.version, 32, 1, PACK_VERSION_PATTERN),
		name: string(item.name, 80),
		description: string(item.description, 512),
		tools: Object.freeze(
			array(item.tools, TOOL_PACK_LIMITS.tools).map((value) => {
				const tool = record(value, ["id", "name", "description", "pipeline"]);
				const id = string(tool.id, 24, 1, TOOL_ID_PATTERN);
				if (ids.has(id)) return invalid();
				ids.add(id);
				return Object.freeze({
					id,
					name: string(tool.name, 80),
					description: string(tool.description, 512),
					pipeline: Object.freeze(array(tool.pipeline, TOOL_PACK_LIMITS.steps).map(parseStep)),
				});
			}),
		),
	});
	const pack = Object.freeze({
		manifest,
		canonicalId: `${manifest.id}@${manifest.version}`,
		digest: createHash("sha256").update(snapshot).digest("hex"),
	});
	validatedPacks.add(pack);
	return pack;
}

/** Provider-safe name. The registry must reject collisions; the full digest remains authoritative. */
export function toolPackToolId(pack: ParsedToolPack, localId: string): string {
	if (!validatedPacks.has(pack)) return invalid();
	if (!pack.manifest.tools.some((tool) => tool.id === localId)) throw new ToolPackError("UNKNOWN_TOOL");
	return `pack_${pack.digest.slice(0, 32)}_${localId}`;
}

/** Fixed-budget synchronous interpreter: cancellation is checked before, between, and after steps.
 * It cannot observe a newly queued event-loop abort while on stack; the whole invocation is <=16 x 8KiB.
 */
export function executeToolPack(
	pack: ParsedToolPack,
	localId: string,
	input: unknown,
	options: { signal?: AbortSignal } = {},
): string {
	const checkCancellation = () => {
		if (options.signal?.aborted) throw new ToolPackError("CANCELLED");
	};
	checkCancellation();
	if (!validatedPacks.has(pack)) return invalid();
	if (
		typeof input !== "string" ||
		input.length > TOOL_PACK_LIMITS.textBytes ||
		/[\ud800-\udfff]/u.test(input) ||
		Buffer.byteLength(input, "utf8") > TOOL_PACK_LIMITS.textBytes
	)
		throw new ToolPackError("INVALID_INPUT");
	const tool = pack.manifest.tools.find((candidate) => candidate.id === localId);
	if (!tool) throw new ToolPackError("UNKNOWN_TOOL");
	let result = input;
	for (const step of tool.pipeline) {
		checkCancellation();
		switch (step.op) {
			case "normalizeNewlines":
				result = result.replace(/\r\n?/g, "\n");
				break;
			case "trimLineEnds":
				result = result
					.split("\n")
					.map((line) => line.replace(/[\t ]+$/g, ""))
					.join("\n");
				break;
			case "removeEmptyLines":
				result = result
					.split("\n")
					.filter((line) => line.length > 0)
					.join("\n");
				break;
			case "deduplicateLines":
				result = [...new Set(result.split("\n"))].join("\n");
				break;
			case "literalReplace": {
				const delta = Buffer.byteLength(step.replacement, "utf8") - Buffer.byteLength(step.search, "utf8");
				let size = Buffer.byteLength(result, "utf8");
				let offset = 0;
				// Count non-overlapping literal matches before allocating the replacement output.
				while (true) {
					const match = result.indexOf(step.search, offset);
					if (match < 0) break;
					size += delta;
					if (size > TOOL_PACK_LIMITS.textBytes) throw new ToolPackError("OUTPUT_TOO_LARGE");
					offset = match + step.search.length;
				}
				result = result.split(step.search).join(step.replacement);
				break;
			}
		}
	}
	checkCancellation();
	return result;
}
