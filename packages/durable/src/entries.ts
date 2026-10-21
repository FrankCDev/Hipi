import type { JsonValue } from "@earendil-works/chord";
import type { CompactionReason, ToolDiagnostic } from "./harness/types.ts";
import type { Entry, EntryId, EntryRecord, TaskId, TypedEntry } from "./types.ts";

/** Define a typed entry kind whose `is()` guard narrows by `EntryRecord.kind`. */
export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
	if (typeof kind !== "string" || kind.length === 0) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is: (entry: EntryRecord | undefined): entry is TypedEntry<D> => entry !== undefined && entry.kind === kind,
	};
}

/** User input: `model` is `[UserMessage]`. Written by submissions. */
export const UserEntry = defineEntry("pi.user");
/** Provider result with any stop reason: `model` is `[AssistantMessage]`. Written by generation. */
export const AssistantEntry = defineEntry("pi.assistant");
/** Positional prompt and tool change: `model` is `[SystemMessage]` with empty `content`. */
export const SystemEntry = defineEntry("pi.system");
/**
 * Tool result: `model` is `[ToolResultMessage]`, whose content ends with the rendered diagnostics block; `data` holds
 * the structured diagnostics, possibly none. Written by tool tasks, and by generation for calls it did not offer.
 */
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("pi.tool-result");
/**
 * Start of a new context: always `head: "self"`, with `model` absent for a plain reset or `[UserMessage]` carrying the
 * handoff text. Written by `Conversation.reset()` and the `handoff` tool control.
 */
export const ResetEntry = defineEntry("pi.reset");
/**
 * Compaction summary: `model` is `[UserMessage]` with the wrapped summary, `head` the first kept entry. Written by
 * compaction tasks, directly or through a write submission.
 */
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("pi.compaction");

/** Generic termination origin, not a claim about a response's display or semantic phase. */
export type RunTerminalCause = "response" | "tool-terminate" | "tool-handoff" | "unanswered";

/** Known built-in codes safe to duplicate into observational transcript metadata. */
export type RunUnansweredReason = "aborted" | "reset" | "faulted" | "model_error" | "no_model";

/** Bounded observational run facts. Times are wall-clock samples, not active execution durations. */
export type RunResult = {
	runId: TaskId;
	admittedAt: number;
	settledAt: number;
	terminalCause: RunTerminalCause;
	settlement: { status: "done"; answer: EntryId } | { status: "unanswered"; reason?: RunUnansweredReason };
	/** Exact settled response's model request timestamp, never first token or UI item-start time. */
	answerRequestStartedAt?: number;
};

/** Model-less terminal bookkeeping, committed atomically with input settlement. */
export const RunResultEntry = defineEntry<RunResult>("pi.run-result");
