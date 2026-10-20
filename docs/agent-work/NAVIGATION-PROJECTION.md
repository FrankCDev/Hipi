# Sidebar navigation projection

Protocol 9 adds `refreshSidebarProjection` and `listSidebarConversations`. Catalog schema 10 adds derived navigation state, source rows and an atomic publication pointer. Recovery archives remain format 4 and are not executable rollback stores.

## Identity and placement

Canonical execution identity remains `{workspaceId, conversationId}`. The new view selector is either `recent` or an explicit physical `workspace`; it does not invent logical project IDs. Recent covers all registered ready workspaces, not the renderer's loaded branches or the live workspace cache. Future logical-project membership must come from its own authoritative catalog.

Active individually pinned conversations are excluded by authoritative presentation membership on every page, including pins the renderer has not loaded. Archived conversations remain browsable even if post-archive pin cleanup was interrupted. Active, archived and all filters remain available. Pure pin reorder changes order generation only and does not invalidate navigation pagination; membership changes do.

## Activity

The first accepted submission records internal `acceptedAt` and the bounded per-conversation `hipi.conversation-activity` aggregate in the existing PI receipt transaction. Replay returns the original receipt before reading a clock. Rejected admission writes no activity. Acceptance is not proof that a provider received input.

Read-only public PI task records provide original generation `startedAt` and terminal `endedAt`. They are execution activity, not a universal final-turn completion timestamp: generation handoffs can precede a later turn outcome. Legacy sources without these clocks fall back to persisted user/assistant message timestamps, then recorded creation time, then unknown. Assistant message timestamps describe request start. Tool results and response duration are not silently converted into generic turn completion.

Recency is monotonic within the same verified directory generation and durable conversation identity. Replacement identity resets this projection. Rename, pin, viewing, refresh time, filesystem modification time and PI sequence numbers do not manufacture activity. The existing Created hover label still describes creation.

Truly unversioned workspace directories remain browsable with unknown activity and no activity scans or retained recency merge. Their bounded canonical directory entries are fingerprinted to fence metadata and membership changes during traversal, not to claim physical database identity. Metadata-identical replacement is harmless for this metadata-only fallback. Normal explicit workspace opening performs the existing directory migration; navigation never activates that migration.

Reference evidence supports a separate activity clock, explicit submission bumps and some start/completion updates. Exact treatment of intermediate PI generations is this adapter's stated policy, not a claim of identical reference-backend semantics.

## Reads, publication and freshness

`refreshSidebarProjection({cursor?})` advances one bounded step. When already ready, a cursorless call explicitly starts another traversal. It is not a ready-state polling endpoint.

`listSidebarConversations({view, filter?, cursor?})` returns items, coverage and a row continuation:

- `coverage.nextCursor` advances source verification, not rows.
- The top-level `nextCursor` advances rows, including empty filtered pages.
- `building` has no verified publication and no rows.
- `refreshing` can serve the previous coherent published rows, explicitly stale.
- `ready` means a source traversal completed. It is not an atomic snapshot of all workspace databases at one wall-clock instant.
- `coverage.generation` identifies the published rows actually returned. A staging traversal never exposes mixed generations.
- `coverage.membershipGeneration` identifies authoritative pin membership independently of row publication. A shared bounded list probe can compare both revisions; pure pin reorder changes neither.

Ordinary activity dirtiness is coalesced while a traversal progresses. The next traversal follows publication, so continuous activity cannot repeatedly reset initial progress. Inventory changes and source mismatches invalidate unsafe work. Startup clears the previous process's unverified publication and rechecks cold sources without opening a Harness. Missing/corrupt registered sources cannot become an empty successful account.

Committed canonical conversation metadata is queued without Session I/O and applied atomically to retained rows before another page is read. Archive, restore and rename invalidate the published generation but preserve activity and source ordinal, and leave coverage refreshing. Unknown or oversized metadata invalidation clears the publication instead of serving obsolete archive state. This is distinct from ordinary activity coalescing.

The catalog owns a supervised worker and its timer, admission queue, storage readers and close/drain lifecycle. PI commit callbacks only mark dirty; they do not query the Session or timestamp notification arrival. The worker does not activate models, tools or grants. Published and staging cycles are retained; obsolete-cycle reclamation is bounded per step.

## Pagination and UI integration

Row cursors bind protocol token kind, store, exact normalized view/filter/order, published generation, presentation membership generation and a complete keyset position. Stable source-order ties retain conversation directory ordinal within each workspace, then canonical identity. There is no fabricated global cross-workspace creation sequence.

The SQL order uses a generated ascending `recency_key` (`-coalesce(recency_at,-1)`) with separate global and workspace indexes. Both continuation shapes seek the complete indexed tuple instead of sorting the published corpus or rescanning its prefix. Wire cursors still contain semantic recency, not the SQL key. Unknown activity sorts last. Runtime and maintenance preflight validate the generated expression and exact index definitions; earlier unpublished schema-10 layouts are rejected rather than silently used.

Malformed/wrong-query tokens fail with `INVALID_REQUEST`; replaced publications or changed membership fail with `CURSOR_STALE`. Continuation during refreshing remains valid until atomic publication replaces its generation.

The UI should own one shared navigation refresh/status controller, not a full refresh loop per branch. Preserve focus, disclosure, scrolling and the previous coherent page window while replacement loads. Do not append different generations, drop rows merely because an intermediate building response is empty, or announce an empty account before coverage is complete. On stale row cursors, reacquire the first page without discarding the last coherent presentation prematurely.

## Bounds and limitations

Each source step limits directory replay, task records, entries and message slots. Pages materialize at most 128 candidates and return at most 50 rows. Filtered pages may be empty with a continuation. Refresh admission and live callback bookkeeping are bounded.

Public PI APIs materialize whole entry/task/document records. Fixed record counts do not establish strict byte-memory bounds for arbitrarily large upstream records, nor a whole-corpus latency guarantee. No filesystem timestamp substitutes for missing durable evidence.

Tests under `packages/work-runtime/test/navigation/` use `node --conditions=source --test`. They cover source clocks/replay, cold read-only navigation, candidate bounds, membership fences, coherent publication, source restart, schema migration failure/rollback and backup/archive verification. Native rendering and three-platform acceptance remain separate gates.
