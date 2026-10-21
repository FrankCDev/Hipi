# Run observations (protocol 13)

This optional projection consumes durable producer-recorded facts. It does not add a scheduler, history index, second execution state machine, or provider phase inference. Protocol version and persisted recovery compatibility are coordinated separately.

## Public contract

- `Message.runId` is a positive safe numeric identifier string. Only single-model immutable `pi.assistant` and `pi.user` entries with a matching role carry it. Initial submitted users normally have no run ID; synthetic continuation users remain visible user content.
- `ConversationExecution.run` has a stable `id` and optional `admittedAtMs`, projected from the same committed live state as tools and generation. The owner task can change without changing the run. Presence is not active execution: paused snapshots can retain this object.
- `HistoryPage.runResults` and `Snapshot.runResults` contain up to 64 observations and at most 32 KiB serialized JSON. Each observation has run `id`, `terminalEntryId`, admission/settlement wall samples, explicit terminal cause, a safe settlement status/reason, and optionally an exact `responseMessageId`. Request timestamps, reasoning, signatures, diagnostics and tool arguments are absent.

`omitted` means at least one encountered terminal could not be projected or fit the result budget. It is not a whole-history coverage assertion. Missing fields, pages not loaded, legacy writers and fork exclusions remain unknown. Consumers must retain conflicting observations (different terminal IDs for one run, or differing data for one terminal ID), not choose the newest as truth. A conservative mounted transcript disables automatic timing/final classification when omitted facts could hide a conflict.

## Reading and final-response proof

History uses the existing 64-entry/256-slot/32-message fork-aware scan and cursor fence. Only terminals encountered before that page's message/slot stop are harvested. Model-less-only pages still return a continuation. Answer and input verification share at most 32 extra distinct entry targets per page, with all answers first, through the same fork-aware entries API; no whole-history traversal or parent lookup is added. A missing or budget-excluded answer leaves the terminal fact intact but without response classification.

The response must be the terminal's exact earlier answer entry, belong to the same original conversation and recorded run, be a single `pi.assistant` model record without a context head, contain no tool call, and not be an aborted/error response. A tool terminate/handoff never proves final prose. A fork at the response entry excludes a following terminal even when both share one transaction. A fork at/after the terminal can inherit the immutable completed observation.

## Timing

Admission to settlement is inclusive wall elapsed time, including waits, approvals, retries and downtime, not active compute time or reference first-work-to-final-item timing. Only safe nonnegative integer milliseconds cross the wire. Inverted samples remain available as observations, but `runWallElapsedMs` returns undefined rather than clamping them to zero. Invalid terminal timestamps omit the observation; an invalid live admission timestamp omits only the timestamp, preserving valid run identity. No first-token estimate or early final-start signal is supplied.

Completed timing is fixed. Running timing, if used, requires authoritative admission plus active/connected UI state, not component mount time. Public text/tool block ordering is an independent contract, not inferred from run membership.

## Admitted input references

Optional `inputRefs` on live admission and terminal observations contains numeric-string `entryIds`, `total`, and `omitted`, capped at 32 IDs/1 KiB. Core captures exact input entries at placement, preserves them across handover, and copies them at settlement without additional table reads. Initial submitted users need no retroactive runId stamp. Steering stays in its original transcript position; synthetic onYield users are not counted as admitted inputs. Final-boundary next-run inputs can precede the previous terminal marker, so interval or nearest-user grouping is invalid.

Runtime verifies a single user model without a head, in the same original conversation and fork-visible history. Custom input kinds are supported. Missing or invalid evidence degrades only input association, not independently valid timing/final facts. Input omission is separate from the terminal sidecar's omitted flag. Absent legacy refs stay unknown. Live validation uses the same committed view without asynchronous reads; an input lost from that view remains unknown. The full terminal sidecar still caps at 32 KiB, including all input references.

These refs do not prove complete turn membership or loaded history continuity. Conflicting runs, unknown rows and page gaps require fragment rendering rather than inferred ownership.

## Validation

`test/run-metadata.test.ts` exercises bounded reads and parsing, final proof, invalid/legacy facts, model-less pages, conflicting terminals, escaped frame budgets, actual fast completion, same-transaction fork fences and cold PiWorkspace snapshots. `test/run-input-refs.test.ts` proves the shared lookup budget and input validation. `test/public-facts-budget.test.ts` reserves full optional metadata envelopes in Snapshot, History and Search frames. Existing history/search/execution/stream-identity tests cover surrounding contracts. Source projection strips nonpublic fields; the wire parsers reject unknown fields.
