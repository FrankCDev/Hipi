# Runtime verification — phase one

Verified 2026-10-19, Linux x86_64, Node 24.19.0, npm 11.9.0.

## Executed acceptance tests

```sh
node --conditions=source --test \
  packages/work-runtime/test/core.test.ts \
  packages/work-runtime/test/transport.test.ts \
  packages/work-runtime/test/transport-runtime.test.ts \
  packages/work-runtime/test/dev-server.test.ts
```

Result: **21 passed, 0 failed, 0 skipped**, exit 0. Full output: [runtime-tests.txt](runtime-tests.txt).

- 12 core cases use real PI Durable and file-backed SQLite: receipt persistence and conflicts, first streamed updates, read-only reopen, three dispatch crash boundaries, cancellation of waiting only, exclusive ownership, diagnostic callback failures, duplicate dispatch deduplication, observer cancellation/slot reuse, conservative startup cleanup, no scheduling from queries, and atomic input quota.
- 6 transport contract cases use actual loopback HTTP and inherited Node child IPC. Their injected WorkspacePort is isolated from the integration tests. They exercise auth/Origin/Host/input rejection, disconnect, expiration, source terminal status, async callback failure, and slow consumer disposal.
- 2 integration cases use actual PI/SQLite with HTTP and child IPC, including SIGKILL and reopening the original data store for completed and pending work.
- 1 acceptance-host case spawns the documented deterministic-provider command, completes persisted work through HTTP, and verifies clean SIGTERM shutdown. Its ephemeral local token is never printed in this log.

No paid inference, external tools, complete upstream test suite, or production build was run. Models are deterministic fixtures; storage, PI execution, child IPC, and HTTP are real.

## Whole-repository checks

Final `npm run check` completed with exit 0 after the second UI source freeze (including the same-text draft reconciliation regression). Full, untruncated output: [runtime-check.txt](runtime-check.txt). This includes root Biome, pinned dependency/runtime import/relative import checks, entry graph budgets, existing coding-agent install-lock verification, whole-repository TypeScript, existing browser smoke bundles, runtime strict TypeScript plus browser-safe contract/client bundle, and UI scoped Biome plus strict TypeScript. The final formatter reported no fixes. All 21 runtime tests passed on the same unchanged runtime source. `git diff --check` also passed.

The recorded npm warnings concern inherited configuration keys (`http-proxy`, `min-release-age`); they did not fail checks. No npm version upgrade was performed. Browser bundle checks are compilation evidence, not interactive browser or Electron visual evidence.

## Desktop evidence boundary

Electron 42.11.15 embedded Node 24.19.0 passed SQLite and public runtime probes. The real Electron host did not reach application readiness because this environment has no X server / DISPLAY. Embedded Node mode does not establish utilityProcess or desktop compatibility. See [Electron host evidence](../../../../experiments/electron-host/README.md).

## Delivery and reproducibility boundaries

Use [runtime README](../../../../packages/work-runtime/README.md) for clean installation and startup. Dependencies are npm-workspace locked; installs used `--ignore-scripts`. The official upstream model metadata hydration step is needed for whole-repository type checks, not for deterministic inference. Generated caches are not source deliverables.

This is a bounded, short-conversation local acceptance slice. General model output bounds, tools and external side effects, public/multi-tenant security, persistent event replay, long-history pagination, cross-platform locks, disk-full/corruption/migration, and packaged Electron remain unverified. Snapshot epoch/version is not a durable replay cursor. `cancelWait` does not cancel an accepted task. Known UI and browser validation limits are documented separately.
