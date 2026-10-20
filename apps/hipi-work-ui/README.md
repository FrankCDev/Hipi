# Hipi Work UI — local workbench

The second workbench increment uses the real AppClient and PI Durable runtime. It is separate from the design-only preview outside this repository and is not a production-ready desktop release.

## Run from a clean checkout

Validated toolchain: Node 24.19.0 / npm 11.9.0. The repository engine range starts at Node 22.19, but that lower bound has not been validated for this runtime/UI path. From the repository root:

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run check:model-data
npm run dev --workspace=@hipi/work-runtime -- --provider deterministic --origin http://127.0.0.1:5173 --data /absolute/private/hipi-work-data
```

Model JSON is omitted from Git/source-only archives and is required even for deterministic startup. Hydration fetches public metadata without API keys or inference. For missing JSON, stale data, network failures or offline preparation, see [source prerequisites and diagnostics](../../README.md#development).

In a second terminal:

```sh
npm run dev --workspace=@hipi/work-ui -- --port 5173 --strictPort
```

Open `http://127.0.0.1:5173` and enter the API URL and ephemeral token printed by the runtime. The API uses a different, dynamically selected port. Vite is configured with `strictPort: true`: an occupied port must fail rather than silently change the browser origin. Do not substitute `localhost` or another port for the exact permitted origin. The connection screen displays its actual page origin and the corresponding `--origin` instruction.

The UI enters the workbench only after an authenticated, schema-validated handshake. Authentication, browser/network, incompatible-protocol and runtime failures remain on the connection screen. The token stays in memory and must be re-entered after reload. This loopback capability/origin restriction is not public-service authentication.

For the no-cost acceptance path above, the provider must explicitly be `deterministic`. When creating each conversation, select `faux-1 · faux` before clicking Create. Protocol 3 requires a model reference; the conversation saves it, and changing models requires a new conversation. Execution, receipts, streaming snapshots, SQLite persistence and reopened history use real PI Durable. Model output is deterministic verification text; no paid model or project-file operation is performed.

The separate opt-in `--provider openai` host exposes OpenAI model selection and a Model settings dialog. Enter keys only through that dialog; HTTP mode keeps them in host memory and clears them on restart. Use a separate private data directory. Sending a task may incur provider charges. Desktop credentials use the [desktop host's encrypted storage](../hipi-work-desktop/README.md#credentials-and-production-mode). Credential availability is not proof of successful authentication. No paid-provider acceptance is claimed here.

## Workbench design

- A collapsible project → conversation navigation list shows multiple projects together. Expanded projects load their own authoritative conversation lists, with independent loading, empty, failure and retry states. The shared search dialog searches active conversation titles and message content across the store, including collapsed projects and unloaded history. Project-row creation controls and selected-conversation navigation preserve existing drafts; the brand button returns to the overview. Projects are runtime workspaces, not filesystem directories.
- A light path toolbar and a single reading column (760 px maximum) give messages and the composer priority. User/assistant messages have clear hierarchy; a jump-to-latest action appears when reading older output. User text stays plain; assistant messages support bounded GFM Markdown.
- Conversation rows provide a hover preview plus an explicit keyboard/touch Popover trigger. The preview uses recorded titles, workspace names and IDs without opening execution subscriptions. Execution IDs, scope and receipts live behind an accessible conversation-details toggle in the toolbar or preview; the content pane does not repeat the visible conversation header. Unconfirmed submission recovery stays above the composer even when details are collapsed. There are no simulated editor, file or attachment buttons.
- Shared semantic theme tokens, small owned stroke icons, official shadcn/ui components imported with the CLI and adapted through semantic tokens and Chinese/English copy. Narrow screens use a toggleable navigation region, Escape closure and focus restoration. Theme and locale switches preserve input; Enter submits and Shift+Enter inserts a newline, with composition, key-repeat and submission guards. The composer grows from three to eight lines, then scrolls internally.
- Creation dialogs explain the actual object being created and require explicit model selection for conversations. An uncertain creation response refreshes the authoritative list and disables another submission in that dialog; close and inspect the list before trying again. Conversation creation is not claimed to be idempotent.

## Recovery and identity

The verified handshake returns a persistent `storeId`. Browser drafts, selected IDs, project expansion records, pending original payloads and receipt-reconciliation markers are scoped to that identity. Reusing a URL or port for another data directory does not restore the old store's input. Subsequent transport operations are bound to the handshake identity; a store mismatch blocks submission/retry and preserves recovery data.

Only one editing tab per verified store is admitted through a browser Web Lock. A second tab must disconnect the first before connecting. Environments without this locking support fail closed. This increment does not support simultaneous multi-window editing; the core can still serve multiple observers.

Pending submissions are durably recorded before transmission. A retry uses the original request ID and entire original payload, never the edited composer. Confirmed receipts clear only an unchanged matching submitted draft. Receipt request/workspace/conversation identity is checked before recording confirmation. Invalid storage is rejected; a storage failure is surfaced rather than claiming a saved draft. Browser storage is local to this browser profile and page origin, is not encrypted or a backup, and can be removed by browser privacy controls. Only use a trusted local origin.

Disconnect does not cancel execution. Reconnecting to the same verified store restores its browser state and reads authoritative runtime lists/history. Reload loses the token, not a successfully persisted draft. “Stop waiting” only stops observation or request waiting; it never claims execution cancellation or rollback. Aborted generations and snapshot epoch/version checks keep old callbacks from overwriting the current projection.

## Code boundaries

`src/main.tsx` selects the desktop composition when the restricted `hipiWorkDesktop` preload capability is present; otherwise `src/app/browser-app.tsx` remains the HTTP composition root. `desktop-app.tsx` connects automatically without requesting a URL or token. `desktop-client.ts` validates serializable request/result/snapshot envelopes and pins the verified store identity. Requests never automatically retry; cancellation only stops waiting. A validated initial snapshot is required before observation startup resolves, with bounded startup and observation lifetimes. Disposal rejects pending startup and ignores late frames. `connection.ts` verifies the handshake; `AppClientProvider` supplies the browser-safe contract, per-store local state and connection-owned QueryClient. Features never import HTTP or Electron. The desktop composition supplies an IPC-backed AppClient through this boundary without importing Electron or Node into the UI. The desktop host is a separate app; its packaging and platform verification are tracked separately.

`workbench.tsx` owns navigation projections, selection and detail visibility. `workspace-tree.tsx` owns project disclosures and scoped list reads; expansion records use the existing store-scoped local-state port, accept only explicit true/false values, and recover independently from corrupt records. `conversation-preview.tsx` owns preview interactions without subscribing to execution. Only the selected conversation pane observes execution. `connection-actions.tsx` owns explicit reopen/disconnect dialogs. Conversation behavior lives in `use-conversation.ts` and `use-observation.ts`; messages, composer and receipt diagnostics are separate presentational components. TanStack Query holds replaceable server projections, not a second execution state machine. Local state owns browser drafts and immutable recovery records, not authoritative execution facts.

Model settings, saved conversation model status, explicit workspace continuation and execution cancellation are available through application contracts. Paused-work cancellation records a durable intent without starting the scheduler; `cancellation_pending` is distinct from a final `cancelled` receipt. Neither state implies rollback of provider work or other effects already accepted.

The workbench now connects a separate FileClient and preview client through HTTP/desktop composition. It includes authorized root browsing, CodeMirror editing of existing bounded UTF-8 files, dirty-buffer guards, version-conflict handling and an `editor-read` Diff baseline. That baseline is the original editor read, not Git HEAD or an Agent task's complete changes. DOCX plain text, bounded XLSX/CSV grids and PDF/image preview source paths are present; their format, resource and isolation limits are described in [the file service](../../docs/agent-work/FILE-SERVICE.md) and [preview parsing](../../packages/work-runtime/src/previews/README.md). These source integrations and targeted tests do not establish real GUI, native IME or visual fidelity acceptance.

The separate `src/app/theme/` configuration, store and provider modules are not yet wired into the application entry at this checkpoint. Their presence does not establish complete persistent theme customization. Agent tools, plugin lifecycle and an OS permission sandbox remain unimplemented. No Router is needed for this single-screen increment. Dependencies remain pinned; known dependency audit findings are recorded in [the dependency review](../../docs/agent-work/DEPENDENCY-REVIEW.md), not treated as a zero-vulnerability result.

## Bounded streaming Markdown

`message-markdown.tsx` uses react-markdown 10.1.0 with remark-gfm 4.0.1 for whole-message parsing: fenced code, tables, lists, task markers and strikethrough. There is no hand-written block splitter, syntax-highlighting worker, math renderer or global parser cache. remend 1.4.0 repairs incomplete syntax only in the transient streaming display, with both math options disabled. Completed and interrupted messages use their exact canonical text; originals remain available in a disclosure. No repair is persisted or sent back to the runtime.

Only explicitly listed Markdown elements are accepted. Raw HTML is skipped; there is no HTML injection API. Links render as inert selectable text, with credential-free HTTP(S) destinations displayed and all other destinations suppressed in the rich view. Original source remains available. Images render only an alt-text placeholder, never an image/resource element. There is no automatic external request or opener, and the desktop navigation guards remain unchanged. Tables and fenced code scroll horizontally within the reading column; theme tokens and code-font fallbacks apply.

The provisional rich-render ceiling is 32,768 UTF-16 units for completed messages and 2,048 units for streaming text. The streaming ceiling was lowered after local SSR measurements showed costly synchronous parsing at larger sizes; SSR timings do not establish browser responsiveness. Larger messages, or localized parser/render failures, use an explicit original-text fallback, paged in 16,384-unit segments with surrogate-pair-safe boundaries. Every unit remains reachable; pages are not silent truncation. These are conservative implementation limits, not measured performance budgets. The snapshot is now a bounded latest-history window, with explicit text previews and an older-history continuation. It does not carry the full conversation. Static rich messages are memoized by source and streaming state.

`message-projection.ts` coalesces snapshots with one pending latest value and one cancellable timer (provisional 80 ms cadence). A DOM selection intersecting the message region freezes the entire displayed snapshot, including replacement of a partial by a completed/interrupted message. Final snapshots flush immediately when no selection blocks them. Clearing the selection publishes only the latest snapshot; listeners and timers are removed on unmount. Auto-scroll checks selection and follows the displayed snapshot, not incoming tokens. This is display state only, not another execution state machine.

A localized pending-output hint appears outside the selected message region when newer output is held. Its state changes only when entering/leaving the pause, not for each token; it never clears selection or moves focus.

Targeted tests cover SSR safety markup, GFM structures, every prefix of a mixed Markdown sample, canonical text preservation, URL policy, ceiling fallback, surrogate-safe paging, coalescing, disposal and selection/finalization policy. DOM range doubles verify the policy predicate, not actual browser selection. Real browser/Electron selection, scrolling, long-session performance, native IME and accessibility acceptance remain pending.

## Bounded history and original text

Protocol 3 retains the separation of the live latest snapshot from history reads introduced in protocol 2. Scrolling near the top automatically reads older previews; there is no normal “Older messages” button. TanStack Virtual 3.14.21 renders the visible window with five overscan rows, stable message keys and dynamic measurement. Its end anchor preserves reading position on prepends and follows appended output only from the bottom. In normal reading mode, “Jump to latest” scrolls within the retained timeline without clearing read history. In search-anchor mode it releases the separate search window and returns to the latest observed snapshot.

`ConversationHistoryController` keeps the original older-history cursor fence independent from live observations. Stable IDs deduplicate overlapping pages without replacing held originals. If a reconnected latest window no longer overlaps the retained tail, a separate backward read bridges the gap before publishing the joined timeline; newer observations coalesce while that fence is read. A single history request is active at a time. Empty continuation pages advance automatically, with an explicit continuation action after a batch of 16 scan pages. Errors stop automatic reads and expose retry without discarding displayed content.

This is bounded browsing, not an unlimited history cache: retained previews, bridge staging and pending snapshots share a conservative 2,048-message / 4 Mi UTF-16-unit budget, reserving one contract-sized latest snapshot for recovery. A maximum of 2,048 successful pages also bounds cursor bookkeeping. Reaching capacity stops growth without silently evicting history. An explicit “Release loaded history and view latest” action resets UI cache only; persistent messages remain intact. Arbitrary bidirectional seeking and an LRU body cache are not implemented. See [history boundaries](../../docs/agent-work/HISTORY-BOUNDS.md).

Selection freezes the data projection, while the initial selection window, current selection endpoints and focused row remain mounted alongside the current viewport. Scrolling therefore still displays the frozen timeline rather than blanking the region; clearing selection releases pinned rows. Native selection spanning never-mounted content is not an export of the full history. Bottom-follow is suspended during selection, including dynamic size compensation. These policies still require real browser Selection / ResizeObserver acceptance.

The runtime limits each page to 32 message previews. Committed previews are at most 2,048 UTF-16 units and explicitly report original length and truncation; live partial previews have separate metadata. Truncated previews are labeled plain text rather than silently parsed as complete Markdown. Receipt-answer previews have the same explicit disclosure and direct readers to message history for full originals.

“Read full original in pages” loads one server text chunk at a time, at most 32,768 UTF-16 units. First, Previous and Next navigation replace the chunk; copying copies exactly the currently displayed original chunk, never a reconstructed unbounded aggregate. Ranges show the actual UTF-16 offsets. Previous may overlap one unit when the requested boundary bisects a surrogate pair; forward traversal follows the returned next offset. Scope, message identity, original length and normalized offset are checked before publishing a chunk. This viewer uses plain original text, not independently parsed Markdown fragments.

`BoundedRead` owns one abort controller, one latest result and an explicit retry input for original text. Cancellation and generation checks suppress late successes and failures, including clients that ignore AbortSignal. Conversation and verified-store provider remounts dispose pending reads. A failed read preserves the current page and retries only on request. Virtual row unmounts release raw chunks and pending reads; the opened state and requested offset remain as small reading-position metadata, so remount rereads the original page. History pages and raw chunks do not enter TanStack's retained query cache. Targeted tests cover cancellation, late/out-of-order reads, disposal across scopes, explicit retry, empty continuation pages, foreign identities and surrogate-offset normalization. Core virtual-layout and SSR tests are not browser selection, scrolling or clipboard acceptance.

## Conversation content search

The sidebar search button opens one shared modal. Index refresh has a separate cancellable owner from debounced queries; opening starts a bounded traversal, and sustained typing or explicit Refresh can update it without a source scan per keystroke. Results show actual title/message snippets and original UTF-16 highlights. Archived conversations are excluded. Coverage remains explicitly incomplete while refreshing or after indexing failure; a final empty result requires completed refresh coverage and an exhausted query. Empty continuation pages, stale cursors, retry and bounded scan continuation remain distinct states.

Opening, typing, clearing and cancelling search preserve the current conversation, draft and file owners. Result activation first validates authoritative conversation identity and, for message hits, a locator-bound history window with the actual matching text chunk. Only successful, still-current activation changes navigation and exits a full-width IDE presentation. A search window never invokes the ordinary live-gap bridge: live observations are retained separately, older/newer buttons read one bounded directional page, and Jump to latest exits search reading. Search/index/hydration reads do not start a Harness or invoke a model; normal selected-conversation observation remains a separate owner.

The configurable `searchConversations` application command is unbound by default on desktop. The reference's desktop Mod-K shortcut belongs to its broader command menu, not an independently evidenced search-only shortcut; that broader command surface remains a separate gap. Focus, IME cancellation, rapid replacement, stale navigation and StrictMode effect replay have focused callback/effect regressions. A real persisted-runtime → UI-controller integration validates an old match beyond the preview and bounded navigation. These tests and SSR highlights do not establish native IME, portal focus trapping or actual scrolling geometry; the packaged search journey must run separately.

## Verification

From the repository root, run scoped checks and explicit test files under the repository's command policy:

```sh
npm run check --workspace=@hipi/work-ui
node --conditions=source --test apps/hipi-work-ui/test/connection.test.ts
node --conditions=source --test apps/hipi-work-ui/test/desktop-client.test.ts
node --conditions=source --test apps/hipi-work-ui/test/local-persistence.test.ts
node --conditions=source --test apps/hipi-work-ui/test/local-state.test.ts
node --conditions=source --test apps/hipi-work-ui/test/receipt-reconciliation.test.ts
node --conditions=source --test apps/hipi-work-ui/test/reopen-request.test.ts
node --test apps/hipi-work-ui/test/composer-input.test.ts
node --test apps/hipi-work-ui/test/conversation-preview-interaction.test.ts
node --test apps/hipi-work-ui/test/message-projection.test.ts
node --test apps/hipi-work-ui/test/bounded-read.test.ts
node --test apps/hipi-work-ui/test/conversation-history-controller.test.ts
node --test apps/hipi-work-ui/test/conversation-virtualizer.test.ts
node --conditions=source --test apps/hipi-work-ui/test/history-reads.test.ts
(cd apps/hipi-work-ui && node ../../node_modules/vitest/dist/cli.js --run test/message-markdown.test.tsx test/conversation-preview.test.tsx)
node apps/hipi-work-ui/scripts/check-dev.mjs
```

For the 2026-10-19 project-tree/preview increment, coordinated targeted verification passed 76 Node tests and 14 SSR tests. These cover state/keyboard policies, persistence isolation and static markup, not real browser pointer, focus, layout or native IME acceptance. Additional handshake/persistence test files live in `test/`. The original five local-state regressions remain, including original-payload retry and protection of later identical drafts. New tests cover verified-store persistence and scoped receipt confirmation. See the coordinated delivery evidence for exact commands and results rather than treating this list as a passing report.

For an already provisioned Playwright package and sandbox-capable Chromium:

```sh
HIPI_PLAYWRIGHT_PATH=/absolute/path/to/playwright \
HIPI_CHROMIUM_PATH=/absolute/path/to/chromium \
HIPI_EVIDENCE_DIR=/absolute/path/to/evidence \
node --conditions=source apps/hipi-work-ui/scripts/verify-browser.mjs
```

This script runs a real isolated runtime/Vite server, checks rejection before workbench entry, creates/selects conversations through the project list with explicit deterministic model selection, checks project disclosure and Enter/Shift+Enter behavior, verifies same-request recovery before admission and after a lost accepted response, reloads persisted drafts, checks token non-persistence, themes/language, narrow navigation and actual transport closure. It captures empty/light/dark/narrow screenshots only if browser execution succeeds. Network fault interception simulates missing transport replies, not a fake successful backend.

Chromium sandbox remains enabled. On 2026-10-19 the second-stage attempt was again blocked at browser startup by `socket() failed: Operation not permitted`, before any browser assertion or screenshot. The acceptance script was then adapted to the current project tree, hidden healthy-connection chrome and Enter/Shift+Enter interaction and passed `node --check`; it was not rerun in a browser. This is not a visual acceptance report. Historical scoped UI checks, Vite transforms and a later desktop production build passed; these do not validate subsequent file/preview changes. The current combined tree still awaits coordinated full check/build/test results. Clean-install replay, Windows/macOS/Linux Electron matrix, native IME/screen-reader, paid-provider and long-session performance acceptance remain unverified. Code checks and builds do not prove visual or browser behavior.
