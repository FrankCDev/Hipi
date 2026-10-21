# Optional execution metadata

A run can span several generation tasks. A model calls tools, their results are appended, and another generation owns the same pending inputs. Task identity alone therefore does not identify the complete execution.

Newly admitted runs record an optional `LiveDoc.run.group` containing the initial generation task ID and `admittedAt`. Built-in assistant entries and model-issued tool results may carry that ID as `EntryRecord.runId`. Handover preserves it. Nested tool calls retain their existing parent-task relationship rather than adding independent transcript entries.

When the owning run settles, a model-less `RunResultEntry` is appended in the same transaction as input settlement and live-run removal. Its `terminalCause` distinguishes response settlement, tool termination, tool handoff, and unanswered settlement. A tool-terminated run may reference its earlier tool-calling assistant; that reference does not identify a final narrative response.

## Time provenance

- `admittedAt` is the host wall clock sampled when admitting the run.
- `settledAt` is the host wall clock sampled in its settlement transaction.
- Optional `answerRequestStartedAt` copies the exact settled response's model-request timestamp. It is absent for tool termination or handoff and does not represent first-token or UI item-start time.

These are observations, not scheduling inputs. Wall-clock intervals include approval waits, retries, provider polling, compaction, hooks, and process downtime. Host timestamps and the provider message timestamp can use different, skewed clocks; subtracting across these origins does not establish an elapsed duration. Clock reversal does not establish a valid elapsed duration. No early final-response phase or pause-excluded active duration is asserted.

Summary reasons use a closed set of built-in codes. Unknown reasons and arbitrary error details remain only in the existing submission records; they are not copied into the summary.

## Incomplete and older history

The optional fields retain `LiveDoc` version 1 and require no SQL or task-checkpoint migration. An existing active run without a group remains ungrouped. Older writers may preserve a group while emitting unstamped entries or omitting a terminal marker. Group presence never establishes complete historical coverage.

The terminal marker is a real transcript entry, though it contributes no model message. Consumers must not assume that the last raw entry is an assistant. A fork at the answer entry excludes a following terminal marker, even when both were written in one commit. Compaction or a partial history window can similarly exclude evidence. Consumers must preserve unknown completion and timing rather than reading beyond history boundaries or guessing from a nearby assistant entry.

The metadata does not change provider classification, continuation hooks, tool control, cancellation, or submission settlement. It is not a UI grouping/classification contract; applications must retain their own bounded, evidence-based presentation projection.
