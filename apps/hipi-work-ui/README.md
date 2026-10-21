# Hipi Work UI — local workbench

The local workbench uses the real AppClient and PI Durable runtime. It is separate from the design-only preview outside this repository and is not a production-ready desktop release.

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

The UI enters the workbench only after an authenticated, schema-validated handshake. Requests and handshake results must match the [shared application protocol version](../../packages/work-runtime/src/contracts.ts) exactly; incompatible clients must update with the runtime before issuing business calls or observations. Authentication, browser/network, incompatible-protocol and runtime failures remain on the connection screen. The token stays in memory and must be re-entered after reload. This loopback capability/origin restriction is not public-service authentication.

For the no-cost acceptance path above, the provider must explicitly be `deterministic`. Use the configured `faux-1 · faux` model for deterministic test conversations. Conversation creation requires a model reference; the conversation saves it, and changing models requires a new conversation. Execution, receipts, streaming snapshots, SQLite persistence and reopened history use real PI Durable. Model output is deterministic verification text; no paid model or project-file operation is performed.

The separate opt-in `--provider openai` host exposes OpenAI model selection and a Model settings dialog. Enter keys only through that dialog; HTTP mode keeps them in host memory and clears them on restart. Use a separate private data directory. Sending a task may incur provider charges. Desktop credentials use the [desktop host's encrypted storage](../hipi-work-desktop/README.md#credentials-and-production-mode). Credential availability is not proof of successful authentication. No paid-provider acceptance is claimed here.

## Workbench design

- A collapsible project → conversation navigation list shows multiple projects together. Expanded projects load their own authoritative conversation lists, with independent loading, empty, failure and retry states. The shared search dialog searches active conversation titles and message content across the store, including collapsed projects and unloaded history. Project-row creation controls and selected-conversation navigation preserve existing drafts; the brand button returns to the overview. Logical project membership is separate from execution workspace identity and explicitly authorized filesystem bindings.
- A theme-driven shared reading/composer column gives conversation content priority. User/assistant messages have clear hierarchy; a jump-to-latest action appears when reading older output. Both user and assistant content use the Markdown renderer, with distinct presentation and long-user collapse behavior.
- Conversation rows provide a hover preview plus an explicit keyboard/touch Popover trigger. The preview uses recorded titles, workspace names and IDs without opening execution subscriptions. Execution IDs, scope and receipts live behind an accessible conversation-details toggle in the toolbar or preview; the content pane does not repeat the visible conversation header. Unconfirmed submission recovery stays above the composer even when details are collapsed. There are no simulated editor, file or attachment buttons.
- Shared semantic theme tokens, small owned stroke icons, official shadcn/ui components imported with the CLI and adapted through semantic tokens and Chinese/English copy. Narrow screens use a toggleable navigation region, Escape closure and focus restoration. Theme and locale switches preserve input; Enter submits and Shift+Enter inserts a newline, with composition, key-repeat and submission guards. The composer grows within its configured viewport-height limit, then scrolls internally.
- Creation and initial-send workflows retain their original request identity. An uncertain result is reconciled before a replacement operation; the UI does not create another project or conversation merely because a reply was lost.

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

Theme configuration and presentation preferences are composed through the application providers. File-context grants, tool approvals and tool-pack management use application contracts; these controls do not establish an OS permission sandbox. No Router is needed for this single-screen increment. Dependencies remain pinned; known dependency audit findings are recorded in [the dependency review](../../docs/agent-work/DEPENDENCY-REVIEW.md), not treated as a zero-vulnerability result.

## Streaming Markdown and retained documents

The conversation renderer uses pinned Marked 18.0.11 with GFM, soft line breaks and double-tilde strikethrough, followed by an owned React token renderer. It does not inject parser-produced HTML. Raw HTML remains text except for the supported line-break token. remend repairs only transient streaming display syntax; repaired text is never persisted or sent back to the model. Code highlighting, wrapping, copy, theme roles and text/structure reveal remain separate components.

Completed documents do not fall back to raw text merely because they exceed 32,768 UTF-16 units. Transport chunks are joined into the same canonical source before full-document interpretation; a chunk is not a separate Markdown document. The retained document owner validates scope, message identity, original length, exact offsets and surrogate overlap. A preview is never advertised as a complete copy source.

The document pool accounts for active and inactive sources, held selection projections and in-flight reservations within a 16 MiB source-payload budget. At most two reads run concurrently. Capacity pressure stops further reads while retaining already admitted text and an explicit incomplete state; released capacity resumes eligible owners. This is not a process-RSS or token/DOM budget. Extremely large messages still need a virtual-source/export exception path; arbitrary-length full rendering is not claimed.

HTTP(S) links use the injected, click-only host capability with credential-free URL validation. Render and hover do not open external resources. Unsupported hosts remain inert and there is no window.open fallback. Mutable stream destinations remain non-actionable. Project-relative file links use the current authorized project binding and FileWorkspaceSession; absolute paths, file:// and line-range navigation are not implemented by that adapter. Images remain alt-text placeholders. Frame, new-window and webview navigation guards remain unchanged.

Snapshot projection coalesces updates and freezes replacement while a DOM selection intersects the message. Adaptive text buffering uses arrival rate and fractional drain with a 50 ms scheduling interval and animation-frame publication. Final canonical text flushes when selection permits. These are display owners, not an additional execution scheduler. A truthful pending-output hint does not clear selection or steal focus.

## History and continuous loading

The latest observation and bounded history remain distinct. TanStack Virtual measures verified turn groups and retains visible, selected and focused content. The existing scroll-intent owner governs prepends, bottom-follow, search positioning and disclosure anchors. Jump to latest remains a real navigation action, not a transport-page control.

Runtime history still returns bounded previews and opaque cursors. Those transport boundaries do not define message UI pages. Retained text and tool results load internally; ordinary First/Next/Refresh-page/Read-full controls are not part of the conversation. Real read failures retain a retry affordance, and unknown execution outcomes retain their separate reconciliation path.

History windows, staging reads and protected content remain subject to explicit capacity and identity fences. Do not equate a bounded cache with all history being loaded, or silently treat an empty scan window as the end. See [history boundaries](../../docs/agent-work/HISTORY-BOUNDS.md) for the current window and replay policy. Native selection across never-mounted content is not a whole-history export.

Tool metadata and output reuse their existing message/session owners. Generic output uses bounded continuous scrolling and leased output buffers; validated built-in file metadata can use compact rows. Retained results are not the current disk contents, and a saved-file confirmation without historical before/after data is not a complete diff.

DOCX and spreadsheet transport fragments are reassembled under the existing whole-preview limits into continuous text or sheets. This preserves the deliberately lossy parser's limitations, rather than claiming Office fidelity. PDF retains genuine document page navigation.

## Conversation content search

The shared search modal uses a cancellable index owner and debounced query owner. Normal results have no manual refresh or page controls: scroll and keyboard demand load a bounded result window. Deep reverse reads may replay older cursors. Coverage remains incomplete while indexing or after failure; an empty result is final only with completed index coverage and exhausted search data.

Activation validates the exact conversation and locator-bound match before changing navigation. The message's ordinary rich renderer stays in place while canonical content loads. Source ranges currently support semantic-block positioning, not precise word-level highlighting inside every long paragraph or escaped entity. User scroll, selection and scope changes cancel delayed positioning; a late read must not reclaim the viewport.

Search, indexing and retained-content reads do not start a Harness or invoke a model. The configurable searchConversations command remains unbound by default on desktop; the reference's broader command-menu shortcut is not represented as a search-only shortcut. Portal focus, native IME, visual geometry and browser scrolling still require separate acceptance.

## Verification

From the repository root, run scoped checks and explicit test files under the repository's command policy:

```sh
npm run check --workspace=@hipi/work-ui
node --conditions=source --test apps/hipi-work-ui/test/connection.test.ts
node --conditions=source --test apps/hipi-work-ui/test/desktop-client.test.ts
node --conditions=source --test apps/hipi-work-ui/test/workbench/local-persistence.test.ts
node --conditions=source --test apps/hipi-work-ui/test/workbench/local-state.test.ts
node --conditions=source --test apps/hipi-work-ui/test/workbench/receipt-reconciliation.test.ts
node --conditions=source --test apps/hipi-work-ui/test/workbench/reopen-request.test.ts
node --test apps/hipi-work-ui/test/workbench/composer/composer-input.test.ts
node --test apps/hipi-work-ui/test/workbench/sidebar/conversation-preview-interaction.test.ts
node --test apps/hipi-work-ui/test/workbench/conversation/message-projection.test.ts
node --test apps/hipi-work-ui/test/workbench/bounded-read.test.ts
node --test apps/hipi-work-ui/test/workbench/conversation/conversation-history-controller.test.ts
node --test apps/hipi-work-ui/test/workbench/conversation/conversation-virtualizer.test.ts
node --conditions=source --test apps/hipi-work-ui/test/workbench/conversation/history-reads.test.ts
(cd apps/hipi-work-ui && node ../../node_modules/vitest/dist/cli.js --run test/workbench/conversation/markdown/message-markdown.test.tsx test/workbench/sidebar/conversation-preview.test.tsx)
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
