import type { Snapshot } from "@hipi/work-runtime/contracts";

export type ResponsePhase = "working" | "generating" | "tools" | "retry" | "deferred" | "compacting";

/** Read-only presentation of the current snapshot; no timers, history inference or execution authority. */
export function responsePhase(snapshot: Snapshot, responseActive = true): ResponsePhase | undefined {
	if (!responseActive || !snapshot.running) return undefined;
	const execution = snapshot.execution;
	if (execution?.blockingCompactionCount) return "compacting";
	if (execution?.tools.active) return "tools";
	if (execution?.generation?.retryAt !== undefined) return "retry";
	if (execution?.generation?.deferredPollAt !== undefined) return "deferred";
	// Visible current text owns progress. A known generation can use the reference
	// Thinking waiting copy; a run between model attempts only proves work, not thought.
	if (snapshot.partial) return undefined;
	return execution?.generation ? "generating" : "working";
}
