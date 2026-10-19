# Phase-two UI verification

Date: 2026-10-19 (UTC). UI source freeze was communicated to the integration owner at 10:04:57. A required follow-up added the runtime's `Message.interrupted` marker beside the message author, with Chinese/English copy; source was frozen again at 10:05:55. No other source changes followed that freeze.

## Targeted behavioral tests

Command, executed after the final source freeze:

```sh
node --conditions=source --test \
  apps/hipi-work-ui/test/connection.test.ts \
  apps/hipi-work-ui/test/local-persistence.test.ts \
  apps/hipi-work-ui/test/local-state.test.ts \
  apps/hipi-work-ui/test/receipt-reconciliation.test.ts \
  apps/hipi-work-ui/test/reopen-request.test.ts
```

Result: **32 passed, 0 failed, 0 skipped**, exit code 0. Complete actual output: [ui-tests.txt](ui-tests.txt).

Coverage includes verified handshake identity, rejected/malformed/late handshakes, classified errors, unsupported Web Locks, store isolation, original-payload retry, malformed persistence, write failures, stale callbacks, receipt scope matching, confirmation/clear ordering, later identical drafts, and canceled reopen requests whose transports resolve or reject late.

The lease-termination test uses a real Node worker and native Web Locks. It proves lock release after that worker terminates. It is **not a browser crash, browser reload or Electron lifecycle test**. Helper tests with storage substitutes are not real browser interaction tests.

## UI checks and development transforms

Commands:

```sh
npm run check --workspace=@hipi/work-ui
node apps/hipi-work-ui/scripts/check-dev.mjs
```

The UI check runs app-scoped Biome and strict TypeScript. The dev check starts a real loopback Vite server, reads its HTML entry and transforms the owned source/CSS modules. These checks do not execute the UI in a browser. The final post-freeze run passed: **28 files checked by Biome, strict TypeScript exit 0, and 24 Vite development transforms**. Complete output: [ui-check.txt](ui-check.txt) and [ui-dev-transforms.txt](ui-dev-transforms.txt). The earlier 23-transform count preceded the new reopen-cancellation helper; 24 is the final count. npm printed two existing configuration warnings (`http-proxy` and `min-release-age`); no Biome warning or TypeScript error was reported.

## Browser attempt: blocked before assertions

Command:

```sh
HIPI_PLAYWRIGHT_PATH=/opt/codex/cua_node/lib/node_modules/playwright \
HIPI_CHROMIUM_PATH=/usr/bin/chromium \
HIPI_EVIDENCE_DIR=/workspace/scratch/c51696462341/hipi-work-phase-two-ui-evidence \
node --conditions=source apps/hipi-work-ui/scripts/verify-browser.mjs
```

Actual stdout:

```text
{"result":"FAILED_OR_BLOCKED","checks":0,"output":"/workspace/scratch/c51696462341/hipi-work-phase-two-ui-evidence"}
```

At 10:00:48 Chromium exited during startup with `socket() failed: Operation not permitted (1)`. **0 browser assertions ran; no screenshots were produced.** Complete structured failure and browser stderr: [ui-browser-blocked.txt](ui-browser-blocked.txt). The attempt preceded the final interrupted-fragment label; it validates neither that label nor the earlier UI. Repeating the same sandbox-blocked attempt would not provide visual evidence, so it was not repeated and sandbox protection was not disabled.

## Delivery boundaries

- A single **origin–store pair** has one editing tab through Web Locks. This is not a global lock across different origins, browsers, profiles or native hosts. Browser persistence is likewise scoped to the current origin/profile. Concurrent multi-window editing is not supported in this increment; core observers remain separate.
- Missing Web Locks fails closed with a browser-capability error. Tokens stay in memory. A verified persistent store identity selects restoration data; the URL is not used as store identity.
- The UI displays interrupted message fragments explicitly. That marker is a production rendering change covered by static checks, not a claimed browser visual test.
- Conversation creation is not idempotent. On an uncertain creation response the UI refreshes the authoritative list, blocks immediate resubmission in the same dialog, and tells the user to close and inspect the list before creating again.
- Browser storage failure may require reconnecting to reconcile after storage is restored. Inputs stay available in memory; the UI asks the user to copy important text before leaving. Storage is not encrypted and is not a backup.
- No paid model, project-file editing, production build, full `npm test`, commit or push was run by this UI task.
- No real-browser visual, native IME, screen-reader, three-platform Electron or long-session performance acceptance is claimed. Full repository checks are owned by the integration task.
