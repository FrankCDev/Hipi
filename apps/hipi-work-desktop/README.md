# Hipi Work desktop host

A real Electron host for the durable Node core and shared browser-safe UI. Production mode uses the official OpenAI adapter and explicitly configured credentials; deterministic acceptance mode remains separate. This source slice is not a signed or qualified production release.

## Source organization

The three explicit process roots remain `src/main.ts`, `src/preload.ts` and `src/runtime-entry.ts`. Capability implementations live in `appearance`, `credentials`, `diagnostics`, `files`, `fonts`, `ipc`, `launch`, `previews`, `runtime` and `shell`. Imports target named leaf modules rather than catch-all barrels. Main owns native services and utility supervision; preload owns only validated bridges; the utility owns runtime and database execution. Feature directories may contain both host and utility leaves, so the transitive dependency checker enforces process ownership independently of directory placement.

`launch/profile.ts` also owns production single-instance acquisition; its smoke profile override remains explicitly deterministic-only. Source moves do not change emitted entrypoints, parser-relative resources or ASAR unpack paths.

## Ownership and security

- The sandboxed renderer has no Node integration. Context isolation is enabled. The preload exposes only validated application requests and observations, never raw IPC, filesystem access, or Electron objects.
- Production main accepts only the exact owned webContents and its main frame at `hipi-work://app/index.html`. Navigation, child windows, webviews and permission requests are rejected. Built local assets have a restrictive CSP; the production desktop has no HTTP listener. The explicitly compiled development entry uses only its exact session URL on `127.0.0.1:5173`, with the same sender/frame checks and sandbox restrictions.
- A utility process owns the existing runtime, catalog and workspace SQLite locks. It uses `process.parentPort`, not the existing Node `process.send` adapter. Main never opens a business database.
- Each utility incarnation has a random generation; requests have correlation IDs. Both process boundaries validate public DTOs and cap serialized frames at the runtime contract limit.
- The IPC channel and requests derive their application version from [shared PROTOCOL_VERSION](../../packages/work-runtime/src/contracts.ts): explicit conversation models and execution controls, bounded history, directory/archive commands, tool-pack lifecycle and read-only tool activities use the same validated request route. Mismatched request and handshake-result versions are rejected before further business calls; page cursors remain opaque to the host. File and preview capabilities retain their separate versioned ports.
- There are at most 16 active operations per boundary. Observation delivery waits for the renderer callback to settle before acknowledging; a second unacknowledged frame fails closed. Deadlines stop waiting, not accepted work. A timed-out preload invoke retains its admission slot until the underlying invocation settles.
- Renderer reload/disposal releases only waits and observations. Accepted work is not cancelled. Dirty-window close/reload prompts default to keeping work; runtime shutdown begins only after the window actually closes.
- Host loss reports `CLOSED` (outcome unknown), never success or proof of failure. Pending mutations are never replayed. After an observed utility exit, at most two automatic restarts are allowed per application lifetime; a new handshake and original receipt lookup rebuild the view. Exhaustion requires restarting the app. Shutdown failure retains ownership and never counts as clean exit. A stuck utility can keep application shutdown pending.

The utility process is a fault boundary, not a tool permissions sandbox. Three-platform process-tree cleanup, signed packaging, updates, OS credential storage behavior, and production performance remain unqualified.

## Credentials and production mode

Main owns a bounded encrypted credential file outside both runtime stores. Electron safeStorage must be available; Linux accepts only `gnome_libsecret`, `kwallet`, `kwallet5`, or `kwallet6`. `basic_text`, unknown, and unavailable backends cannot save or read keys. No plaintext fallback or environment credential fallback exists. The v1 credential bridge permits only status, set, and remove for OpenAI; it never reads secrets back to the renderer. The utility obtains credentials through a separate bounded, generation-checked private RPC. Keys are never passed in arguments or environment variables.

Updates are serialized, encrypted to a private temporary file, synced and atomically renamed. Invalid, oversized, or undecryptable original files are retained on failed writes and removal. This protects replacement integrity, but does not claim cross-platform power-loss durability or exclude the file from external backup tools. Status reports availability only, not provider authentication success. Timed-out changes are not retried automatically. Removing a key affects future requests, not a request already accepted by the provider.

Production mode opens history with `resume: false`; continuing interrupted work requires the runtime's explicit continuation command. It uses `production-store`, never the deterministic acceptance store. No real credential or paid model request was used during implementation.

## Workspace files

The separate v1 file bridge is pinned to the active store. Main verifies the owned sender and main frame for both file requests and root management. The renderer can request a native folder picker with a workspace ID and read-only/read-write mode; it cannot supply an absolute path, principal, or grant operation. The native dialog states the requested access in English or Chinese according to the OS locale. Main checks catalog membership before showing it and rejects its result if the renderer lifetime or utility incarnation changed while it was open. Cancelling the dialog grants nothing.

Only the private main-to-utility RPC carries the selected path. The utility owns the file authority and checks the controlled workspace catalog through exact `getWorkspace`; this never opens a workspace, starts a model, or resumes execution. File requests reuse the shared bounded relative-path protocol, revision-conflict checks and bounded text reads. Absolute paths are not returned to the renderer.

Grants are memory-only and utility-generation-bound. A utility or app restart revokes all roots; a fresh picker selection is required, and saved workspace metadata never silently grants access. The UI can explicitly revoke a root. Revocation removes future access and in-flight reads/writes recheck authorization at the broker's defined checkpoints. It does not undo a rename already submitted to the OS or roll back a completed save. A revoke acknowledgement is not a drain/rollback acknowledgement for previously accepted operations. Shutdown cancels and drains previews, closes preview caches and parser workers, then closes the authority and waits for its active filesystem operations before closing the runtime. Deadlines and renderer cancellation stop waiting, not accepted writes; a lost save reply is `WRITE_OUTCOME_UNKNOWN` and is never replayed. Reloading the same owned renderer retains current utility grants.

This is a cooperative local-file boundary, not protection against hostile same-user OS processes. No hostile-process atomic compare-and-swap guarantee or native three-platform picker qualification is claimed.

## Document previews

The separate v1 preview bridge exposes only validated public requests and cancellation by correlation ID. It shares the file authority and generation principal with files; the renderer cannot supply URLs, absolute paths, grants, or principals. Main checks sender/main-frame identity, bounds admission, checks renderer and utility lifetimes before delivering results, and releases tracked handles on renderer disposal. Utility cancellation aborts active parsing. A revoked root cannot be read through a cached preview handle.

DOCX, XLSX and CSV parsing runs in separately bundled Node workers. The utility explicitly resolves `preview-parser.mjs` next to `runtime.mjs`; source development hosts retain their own source-worker path. The parser bundle includes its parsing dependencies and the Node ESM `createRequire` shim, so relocating the distribution does not require source paths or a neighboring `node_modules`. Workers are a fault/resource boundary, not an OS permissions sandbox. PDF/image rendering stays in the browser-safe UI; no parser, PI, or Node implementation enters preload or renderer.

`node scripts/check-preview-bundle.mjs` checks the emitted esbuild input metadata for unwanted CLI/runtime dependencies, copies only the parser bundle to a temporary directory, parses synthetic CSV/DOCX/XLSX fixtures and terminates each worker. Run it after authorized preparation. This qualifies Node bundle relocation only, not native Electron or three-platform installed-path behavior.

`node scripts/check-renderer-assets.mjs` checks the actual emitted PDF worker reference and serves its exact bytes through the production custom-protocol handler. Both `.js` and `.mjs` have JavaScript MIME with `nosniff`. CSP explicitly permits only same-origin workers and keeps `connect-src 'none'`; no remote fetch fallback is enabled. This asset/response check does not prove native Electron custom-scheme worker execution. GUI acceptance remains blocked in the current environment.

## Dependencies and preparation

Electron is pinned at 42.11.15; workspace packages at 0.0.1. Install only with the root-approved `--ignore-scripts` workflow. Electron binary download/install lifecycle is a separate reviewed action; dependency hydration alone does not install or prove the executable.

Before source startup or preparation, run `npm run hydrate:model-data` and `npm run check:model-data` from the repository root after dependency installation. Source-only archives omit the required model JSON even for deterministic mode. See [source prerequisites and diagnostics](../../README.md#development); offline preparation requires already validated data.

`prepare:desktop` is an explicit build, not an install lifecycle script. Follow root AGENTS.md authorization before running it. It emits ESM main/runtime, a standalone ESM document parser worker with build-input metadata, and a bundled CommonJS preload required by Electron sandbox mode. The same command builds the shared UI with its Vite configuration into `dist/renderer`. All source/output paths resolve relative to this script, not the launch directory. Do not load an arbitrary development-server URL in this trusted desktop window.

After explicit build authorization, run `npm run prepare:desktop --workspace=@hipi/work-desktop` from the repository root. Once the reviewed Electron binary is installed, run `npm run start --workspace=@hipi/work-desktop` for production or `npm run start:deterministic --workspace=@hipi/work-desktop` for acceptance tests. OS launches without a provider flag default to production. Deterministic mode requires the explicit `--provider=deterministic` flag and uses its separate store; duplicate, missing-value, or unknown provider flags fail closed. Data lives in Electron's private userData directory and never silently replaces the HTTP acceptance store.

## Targeted verification

### One-command desktop development

After the dependency, reviewed Electron binary, and model-data prerequisites above, run `npm run dev` from the repository root. `npm run dev:desktop` is an alias; `npm run dev -- --provider=deterministic` selects the deterministic provider. The repository remains an npm workspace with one npm lockfile; no pnpm migration is required.

The command owns Vite on exactly `127.0.0.1:5173` (an occupied port is an error), enables React Fast Refresh/CSS HMR, opens Electron DevTools, and watches main, preload, runtime and parser dependencies with esbuild. Successful host rebuilds are coalesced: the previous desktop must finish its existing runtime shutdown before new bundles are published and a replacement starts. Compile errors do not request a restart; if another edit fails during a restart already in progress, the desktop stays stopped until a successful build. React refresh boundaries may require a full renderer reload, which retains the existing unsaved-file protection.

Each command invocation has its own output directory beneath `.artifacts/desktop-development`; release `dist` and provenance are untouched. A new CLI cannot overwrite lazy-loaded runtime/parser files belonging to a surviving earlier desktop. Generated output is retained for debugging; remove it only after all development desktops are closed. Sessions, credentials, logs and stores use the dedicated `Hipi Work Development` directory beneath Electron's OS app-data directory, not the production profile. These development files persist across restarts; the command never deletes them or copies production credentials. Configure a provider separately when testing production mode; starting development does not submit a paid request.

Ctrl+C stops watchers and requests an orderly close through a private child stdin pipe. Unsaved edits or a runtime recovery dialog may keep shutdown/restart waiting: save and close the desktop, or explicitly discard in its dialog, to continue. A further Ctrl+C requests close again; it never force-kills. No process-name cleanup or sandbox override is used. A nonzero desktop shutdown prevents automatic profile reopening. Development-only page/control code is compiled out of normal preparation and release builds; the CLI never downloads a missing Electron binary automatically. See [operational logging](LOGGING.md) for terminal events and isolated desktop logs.

Focused checks: `node --test scripts/dev/process.test.mjs scripts/dev/server.test.mjs scripts/dev/bundle.test.mjs test/development/launch.test.ts test/development/control.test.ts` from this workspace. These exercise real Node child ownership, cancellation before readiness, per-invocation bundle isolation and localhost Vite behavior, not native Electron/keychain/three-platform GUI acceptance.

Offline backup and history recovery are available through the separate source [maintenance CLI](../../docs/agent-work/STORE-MAINTENANCE.md), after the client and backend have fully stopped. Restore creates a new read-only archive, never an executable copy of old pending work. This is not yet a native desktop maintenance window or a qualified cross-platform recovery feature; do not point the normal app at a recovery archive.

From this workspace:

- `node --conditions=source --test test/host.test.ts`
- `node --conditions=source --test test/lifecycle.test.ts`
- `node --conditions=source --test test/runtime-recovery.test.ts`
- `node --conditions=source --test test/credentials.test.ts`
- `node --conditions=source --test test/files.test.ts`
- `node --conditions=source --test test/previews.test.ts`
- `node --conditions=source --test test/startup-assets.test.ts`
- `node scripts/check-renderer-assets.mjs` after authorized preparation
- `node scripts/check-preview-bundle.mjs` after authorized preparation
- `npm run check --workspace=@hipi/work-desktop` from repository root (parent coordinates the full root check).

The recovery tests run real PI + SQLite through the desktop routers: dropped accepted-submit reply, runtime close/reopen, same store identity, original receipt lookup, exactly one observed user message and wrong-store rejection. A separate history case verifies a truncated Unicode/JSON-escaped input preview after reopen, exact text retrieval, and cross-conversation denial. These tests do not run Electron or qualify large-history performance. Host/lifecycle tests use controlled peers to verify rejection, quotas, shutdown and restart behavior. Real Electron, graphical dirty-close/reload, IME, target OS and installed-path tests must be recorded separately; mock tests do not prove them.

Official API references: [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [parentPort](https://www.electronjs.org/docs/latest/api/parent-port), [security checklist](https://www.electronjs.org/docs/latest/tutorial/security).

2026-10-19 validation: the authorized production build passed, including bundled provider source exports. Vite reported a renderer chunk over 500 kB; no performance qualification is implied. The official installer downloaded Electron 42.11.15 with packaged checksums, and `electron --version` returned that version. Actual app launch failed in this execution environment with `socket() failed: Operation not permitted` (exit 133). Sandboxing was not disabled. No native window, utility-process, or OS keychain acceptance is claimed from these results. Credential tests use synthetic crypto and mocked safeStorage only.
