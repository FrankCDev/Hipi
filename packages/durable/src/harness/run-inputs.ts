import type { RunInputRefs } from "../entries.ts";
import type { EntryId } from "../types.ts";

const MAX_INPUT_REFS = 32;
const MAX_INPUT_REF_BYTES = 1024;

/** Append only a prefix; a missing reference must never be filled with a later placement. */
export function addRunInputRef(refs: RunInputRefs, entryId: EntryId): void {
	refs.total++;
	if (refs.omitted || refs.entryIds.length === MAX_INPUT_REFS) {
		refs.omitted = true;
		return;
	}
	refs.entryIds.push(entryId);
	// Only ASCII keys, booleans and safe integer IDs: string length is serialized UTF-8 bytes.
	if (JSON.stringify(refs).length > MAX_INPUT_REF_BYTES) {
		refs.entryIds.pop();
		refs.omitted = true;
	}
}

/** Normalize optional old-writer observations without guessing missing input identities. */
export function boundedRunInputRefs(refs: RunInputRefs | undefined, total: number): RunInputRefs | undefined {
	if (
		!refs ||
		!Array.isArray(refs.entryIds) ||
		!Number.isSafeInteger(refs.total) ||
		refs.total < 0 ||
		typeof refs.omitted !== "boolean" ||
		!Number.isSafeInteger(total) ||
		total < refs.entryIds.length ||
		refs.total < refs.entryIds.length ||
		refs.entryIds.length > MAX_INPUT_REFS
	)
		return undefined;
	let previous = 0;
	for (const id of refs.entryIds) {
		if (!Number.isSafeInteger(id) || id <= previous) return undefined;
		previous = id;
	}
	const result = {
		entryIds: [...refs.entryIds],
		total,
		omitted: refs.omitted || refs.total !== total || refs.entryIds.length !== total,
	};
	return JSON.stringify(result).length <= MAX_INPUT_REF_BYTES ? result : undefined;
}

/** Steering extends the same group; legacy absence remains unknown instead of a complete recent suffix. */
export function mergeRunInputRefs(
	refs: RunInputRefs | undefined,
	currentTotal: number,
	added: RunInputRefs,
): RunInputRefs | undefined {
	const result = boundedRunInputRefs(refs, currentTotal);
	if (!result) return undefined;
	for (const id of added.entryIds) addRunInputRef(result, id);
	result.total = currentTotal + added.total;
	result.omitted ||= added.omitted || result.entryIds.length !== result.total;
	return boundedRunInputRefs(result, result.total);
}
