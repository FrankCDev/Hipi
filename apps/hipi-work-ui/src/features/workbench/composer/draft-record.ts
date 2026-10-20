import { LIMITS } from "@hipi/work-runtime/contracts";

export const ACTIVE_DRAFT_KEY = "new-chat.active";
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const sourceKey = /^(?:task-draft\.[a-zA-Z0-9_-]{1,128}|chat-draft\.global|new-chat-draft\.[a-zA-Z0-9_-]{1,128})$/;

/** The editable home identity is independent of the currently selected destination. */
export type ActiveDraft = { version: 1; generation: string; sourceKey: string };

export function validHomeDraft(key: string, value: string): boolean {
	return sourceKey.test(key) && value.length <= LIMITS.text;
}

export function parseActiveDraft(raw: string): ActiveDraft {
	if (raw.length > 1024) throw new Error("INVALID_ACTIVE_DRAFT");
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !["version", "generation", "sourceKey"].includes(key)) ||
		!("version" in value) ||
		value.version !== 1 ||
		!("generation" in value) ||
		typeof value.generation !== "string" ||
		!identifier.test(value.generation) ||
		!("sourceKey" in value) ||
		typeof value.sourceKey !== "string" ||
		!sourceKey.test(value.sourceKey)
	)
		throw new Error("INVALID_ACTIVE_DRAFT");
	return { version: 1, generation: value.generation, sourceKey: value.sourceKey };
}

export function sameActiveDraft(left: ActiveDraft | null, right: ActiveDraft | null): boolean {
	return left?.generation === right?.generation && left?.sourceKey === right?.sourceKey;
}

/** A null origin is known projectless; undefined means an opaque draft has no saved project provenance. */
export function draftOrigin(key: string): string | null | undefined {
	if (key === "chat-draft.global") return null;
	return key.startsWith("task-draft.") && sourceKey.test(key) ? key.slice("task-draft.".length) : undefined;
}
