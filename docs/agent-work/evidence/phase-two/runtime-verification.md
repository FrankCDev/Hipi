# Phase-two runtime verification

Executed 2026-10-19 on Linux x86_64, Node 24.19.0, npm 11.9.0. This is a local, deterministic-provider acceptance slice, not a production or three-platform qualification.

## Runtime tests

```sh
node --conditions=source --test \
  packages/work-runtime/test/core.test.ts \
  packages/work-runtime/test/catalog.test.ts \
  packages/work-runtime/test/identity.test.ts \
  packages/work-runtime/test/transport.test.ts \
  packages/work-runtime/test/transport-runtime.test.ts \
  packages/work-runtime/test/dev-server.test.ts
```

Result: **36 passed, 0 failed, 0 skipped**, exit 0. Complete output: [runtime-tests.txt](runtime-tests.txt).

- Catalog tests use real file-backed PI/SQLite: persistent identity and names, conversations rediscovered after restart, registration recovery after reserve/directory/storage/PI-commit failure points, legacy-directory discovery, listings that do not schedule the provider even with host resume enabled, persistent capacity, root alias ownership, copied-root and symlink rejection, and preservation of missing/unknown-version data.
- Shutdown tests hold initialization before directory registration, begin close, verify a second owner is rejected, then release initialization and reopen successfully. Concurrent metadata reading completes before root ownership is released.
- HTTP tests exercise actual loopback authentication, exact Origin including the 5173/5174 mismatch, protocol rejection, identity non-disclosure on failure, and bounded code-only diagnostics even when the diagnostic consumer throws.
- A replacement test switches the runtime behind one live URL and token: the original client rejects handshake rebinding, queries, creation, submission, receipt lookup and observation with `STORE_MISMATCH`. It verifies no misdirected workspace or receipt exists in the replacement store.
- Inherited child IPC tests cover the same handshake/list contracts, missing/wrong expected identity, channel absence, and real SIGKILL/restart with persistent store identity, workspace/conversation discovery and original receipt identities. HTTP and IPC both validate the shared request/result contracts.
- Existing real PI submission, stream, cancellation-of-wait, retry, failpoint, exclusive-owner and observer-cleanup tests remain included. No real model API, paid tokens or external tools are used.

## Interrupted-generation finding

Adding restart discovery exposed an overly strong earlier test assertion: PI can persist an aborted generation as an assistant Entry before resuming. Therefore assistant message count is not submission count. The public model message has `stopReason: 'aborted'`; the application preserves that evidence as `Message.interrupted: true` instead of dropping it. Recovery assertions check the original receipt, unique user inputs, and complete answers from the settled Submissions; extra interrupted fragments remain identifiable. The UI separately marks these fragments.

## Persistence and safety boundaries

- Root catalog schema v1 stores a random identity bound to the canonical local root. A copied/moved root at a different path is rejected; relocation and clone re-identification are not implemented. Same-path cross-host cloning and backup rollback detection remain unsupported.
- Registration is pending → PI initialization → ready, not a cross-database transaction. Recovery repairs committed PI metadata; incomplete initialization remains available for explicit same-ID/name retry. Existing registered data is not silently replaced with an empty store.
- Directory queries use the public PI Storage document APIs without a Harness. Opening the storage adapter may perform its schema initialization; this is not a claim of a physically read-only SQLite connection.
- Root enumeration is capped at 64 entries; persisted workspace and per-workspace conversation catalogs are each capped at 16. This is not long-history pagination or an arbitrary-filesystem explorer.
- SQLite/PI process-crash evidence does not establish power-loss durability. Network filesystems, Windows/macOS locking and filesystem behavior, hostile same-OS-user filesystem mutation, disk-full and migration/backup workflows are not qualified.
- The HTTP host remains loopback, single-user and token/Origin/Host protected. Node inherited IPC is not Electron sender/preload qualification. No public server or tools permission sandbox was added.

## Whole-repository checks

Final `npm run check` completed with exit 0 after the final UI source freeze, including the interrupted-fragment label. Full output: [runtime-check.txt](runtime-check.txt). Root Biome checked 1,524 files and made no fixes. Pinned/runtime dependency checks, relative imports, entry graph budgets, coding-agent install-lock verification, whole-repository TypeScript, browser smoke bundles, runtime strict TypeScript/browser-safe contract-client bundles, and UI scoped Biome (28 files)/strict TypeScript all passed.

The existing npm configuration warnings (`http-proxy`, `min-release-age`) and npm upgrade notice remain in the unedited output. No npm upgrade or global configuration change was made. `git diff --check` also passed. Compilation/bundle checks are not native browser or Electron interaction evidence; the UI report records the actual Chromium blocker separately.

No `npm test`, full Vitest suite, production build, commit or push was run for this phase. No new dependency or lockfile modification was required by this runtime change.
