import type { RunResults } from "@hipi/work-runtime/contracts";

// Local retained history has a larger capacity than one transport page. These
// are serialized metadata bounds, not claims about JavaScript heap usage.
export const RETAINED_RUN_LIMITS = { items: 2048, bytes: 1024 * 1024 } as const;

/** Preserve conflict evidence and empty-page observations; never select a winner. */
export function mergeRunResults(...pages: (RunResults | undefined)[]): RunResults | undefined {
	if (!pages.some(Boolean)) return undefined;
	const items: RunResults["items"] = [];
	const seen = new Map<string, string>();
	let omitted = pages.some((page) => page?.omitted);
	let bytes = 32;
	for (const page of pages) {
		for (const item of page?.items ?? []) {
			const serialized = JSON.stringify(item);
			const previous = seen.get(item.terminalEntryId);
			if (previous !== undefined) {
				if (previous !== serialized) omitted = true;
				continue;
			}
			const size = new TextEncoder().encode(serialized).byteLength + 1;
			if (items.length >= RETAINED_RUN_LIMITS.items || bytes + size > RETAINED_RUN_LIMITS.bytes) {
				omitted = true;
				continue;
			}
			seen.set(item.terminalEntryId, serialized);
			bytes += size;
			items.push(item);
		}
	}
	return { items, omitted };
}
