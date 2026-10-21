import type { RunResults } from "@hipi/work-runtime/contracts";

// Local retained history has a larger capacity than one transport page. These
// are serialized metadata bounds, not claims about JavaScript heap usage.
export const RETAINED_RUN_LIMITS = { items: 2048, bytes: 1024 * 1024, conflicts: 2048 } as const;

/** UI-owned evidence, not a transport schema. Ordinary object copies retain it.
 * Lives only in the retained history view; resetting that view starts fresh. */
export type RetainedRunResults = RunResults & {
	retainedEvidence?: { invalidRunIds: string[]; overflow: boolean };
};

export function hasRunResultConflict(results: RetainedRunResults | undefined, id: string): boolean {
	return results?.retainedEvidence?.overflow === true || results?.retainedEvidence?.invalidRunIds.includes(id) === true;
}

/** Preserve conflict evidence and empty-page observations; never select a winner. */
export function mergeRunResults(...pages: (RetainedRunResults | undefined)[]): RetainedRunResults | undefined {
	if (!pages.some(Boolean)) return undefined;
	const items: RunResults["items"] = [];
	const seen = new Map<string, { serialized: string; runId: string }>();
	const runs = new Map<string, string>();
	const invalidRunIds = new Set<string>();
	let overflow = pages.some((page) => page?.retainedEvidence?.overflow);
	let omitted = pages.some((page) => page?.omitted);
	// Reserve bounded conflict evidence before filling observations: a 16-digit
	// identifier needs at most 19 serialized bytes including quotes and comma.
	let bytes = 128 + RETAINED_RUN_LIMITS.conflicts * 19;
	const invalidate = (id: string) => {
		if (invalidRunIds.has(id)) return;
		if (invalidRunIds.size === RETAINED_RUN_LIMITS.conflicts) overflow = true;
		else invalidRunIds.add(id);
	};
	for (const page of pages) for (const id of page?.retainedEvidence?.invalidRunIds ?? []) invalidate(id);
	for (const page of pages) {
		for (const item of page?.items ?? []) {
			const serialized = JSON.stringify(item);
			const previous = seen.get(item.terminalEntryId);
			const terminal = runs.get(item.id);
			if (terminal !== undefined && terminal !== item.terminalEntryId) invalidate(item.id);
			if (previous !== undefined) {
				if (previous.serialized !== serialized) {
					invalidate(previous.runId);
					invalidate(item.id);
					omitted = true;
				}
				continue;
			}
			const size = new TextEncoder().encode(serialized).byteLength + 1;
			if (items.length >= RETAINED_RUN_LIMITS.items || bytes + size > RETAINED_RUN_LIMITS.bytes) {
				omitted = true;
				// Unlike wire coverage omission, this loses observed evidence that
				// could conflict with a later page. Do not silently forget it.
				overflow = true;
				continue;
			}
			seen.set(item.terminalEntryId, { serialized, runId: item.id });
			runs.set(item.id, item.terminalEntryId);
			bytes += size;
			items.push(item);
		}
	}
	return { items, omitted, retainedEvidence: { invalidRunIds: [...invalidRunIds], overflow } };
}
