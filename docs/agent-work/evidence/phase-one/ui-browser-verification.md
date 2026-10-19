# Formal UI browser verification

Date: 2026-10-19. Environment: Linux, Node 24.19.0, npm 11.9.0.

## Executed checks

- `node --test apps/hipi-work-ui/test/local-state.test.ts`: five pure-state tests passed; full output in [ui-local-state-tests.txt](ui-local-state-tests.txt). These test connection-state isolation, immutable retry payloads, receipt/draft reconciliation and connection-owned confirmed-ID markers across pane remount. They do not prove React interactions, HTTP recovery, or native browser behavior.
- `node apps/hipi-work-ui/scripts/check-dev.mjs`: real loopback Vite HTTP entry plus 14 owned TypeScript/TSX/CSS development transforms passed; full output in [ui-dev-transforms.txt](ui-dev-transforms.txt). This is not a production build or browser execution.
- UI scoped Biome and strict TypeScript passed and are included in the separately recorded root check.

## Chromium attempt: environment blocked

Actual command:

```sh
HIPI_EVIDENCE_DIR=/workspace/scratch/c51696462341/hipi-work-ui-evidence node --conditions=source apps/hipi-work-ui/scripts/verify-browser.mjs
```

The script started the isolated real runtime and Vite server, then attempted `/usr/bin/chromium` through the existing Playwright installation with `headless: true` and `chromiumSandbox: true`. Chromium exited before page creation. The script cleaned up the runtime, servers and temporary runtime directory.

Actual diagnostics included:

```text
browserType.launch: Target page, context or browser has been closed
chrome_crashpad_handler: --database is required
FATAL:chrome/browser/process_singleton_posix.cc:297
Check failed: . socket() failed: Operation not permitted (1)
process did exit: exitCode=null, signal=SIGABRT
```

Result: **environment blocked, zero UI assertions executed, no screenshots produced**. This is neither a passing browser test nor evidence of a UI product failure. No sandbox-disable workaround was used. The script retains real-backend interaction checks for a supported environment, including before-admission failure, lost accepted response, same-ID retry, explicit history reopening, connection isolation, themes/language, narrow layout and transport closure.

Unverified: native Electron, Chromium interactions/layout/accessibility, Windows/macOS, native CJK input, screen readers, clean-install replay, production build and long-session performance. The external HTML design preview and its synthetic checks are not evidence for this React application.
