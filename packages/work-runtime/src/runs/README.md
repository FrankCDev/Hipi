# Run observations (protocol 12)

This optional projection consumes durable producer-recorded facts. It does not add a scheduler, history index, second execution state machine, or provider phase inference. Protocol version and persisted recovery compatibility are coordinated separately; these fields must not ship as a protocol 11 extension.

## Public contract

- `Message.runId` is a positive safe numeric identifier string. Only single-model immutable `pi.assistant` and `pi.user` entries with a matching role carry it. Initial submitted users normally have no run ID; synthetic continuation users remain visible user content.
- `ConversationExecution.run` has a stable `id` and optional `admittedAtMs`, projected from the same committed live state as tools and generation. The owner task can change without changing the run. Presence is not active execution: paused snapshots can retain this object.
- `HistoryPage.runResults` and `Snapshot.runResults` contain up to 64 observations and at most 32 KiB serialized JSON. Each observation has run `id`, `terminalEntryId`, admission/settlement wall samples, explicit terminal cause, a safe settlement status/reason, and optionally an exact `responseMessageId`. Request timestamps, reasoning, signatures, diagnostics and tool arguments are absent.

`omitted` means at least one encountered terminal could not be projected or fit the result budget. It is not a whole-history coverage assertion. Missing fields, pages not loaded, legacy writers and fork exclusions remain unknown. Consumers must retain conflicting observations (different terminal IDs for one run, or differing data for one terminal ID), not choose the newest as truth. A conservative mounted transcript disables automatic timing/final classification when omitted facts could hide a conflict.

## Reading and final-response proof

History uses the existing 64-entry/256-slot/32-message fork-aware scan and cursor fence. Only terminals encountered before that page's message/slot stop are harvested. Model-less-only pages still return a continuation. Exact response lookup is limited to 32 distinct targets per page through the same fork-aware entries API; no whole-history traversal or parent lookup is added. A missing or budget-excluded answer leaves the terminal fact intact but without response classification.

The response must be the terminal's exact earlier answer entry, belong to the same original conversation and recorded run, be a single `pi.assistant` model record without a context head, contain no tool call, and not be an aborted/error response. A tool terminate/handoff never proves final prose. A fork at the response entry excludes a following terminal even when both share one transaction. A fork at/after the terminal can inherit the immutable completed observation.

## Timing

Admission to settlement is inclusive wall elapsed time, including waits, approvals, retries and downtime, not active compute time or reference first-work-to-final-item timing. Only safe nonnegative integer milliseconds cross the wire. Inverted samples remain available as observations, but `runWallElapsedMs` returns undefined rather than clamping them to zero. Invalid terminal timestamps omit the observation; an invalid live admission timestamp omits only the timestamp, preserving valid run identity. No first-token estimate or early final-start signal is supplied.

Completed timing is fixed. Running timing, if used, requires authoritative admission plus active/connected UI state, not component mount time. Public text/tool block ordering is a separate later contract, not inferred here.

## Validation

`test/run-metadata.test.ts` exercises bounded reads and parsing, final proof, invalid/legacy facts, model-less pages, conflicting terminals, escaped frame budgets, actual fast completion, same-transaction fork fences and cold PiWorkspace snapshots. Existing history/search/execution/stream-identity tests cover surrounding contracts. Source projection strips nonpublic fields; the wire parsers reject unknown fields.
