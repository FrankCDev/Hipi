# Desktop diagnostic export

2026-10-19. Implemented source-level host diagnostics and a bounded runtime failure channel, including native startup-failure export. This is not complete runtime observability or native release acceptance. See [desktop host](DESKTOP-HOST.md) and [RC tracker](RC-TRACKER.md).

## User flow and data boundary

The native Help menu provides **Export desktop diagnostics…** after desktop startup. It remains independent of the renderer and does not expose a renderer IPC capability. It preserves the existing application menu. Native text follows the OS locale (Chinese or English fallback), independently of the workbench locale.

The host constructs a fresh schema-version **2** JSON document from an explicit allowlist:

- Fixed product name; numeric app, Electron and Node versions, optionally followed by `-(alpha|beta|rc).number` (each numeric component is at most six digits and total length at most 32; unsupported formats become `unknown`).
- Known platform and architecture enums; synchronous supervisor lifecycle state.
- Six fixed host event counters: runtime unavailable, host startup failed, shutdown timeout, renderer gone, export preparation failure and unconfirmed export write.
- Eight fixed runtime category/phase counters, listed below. Each host/runtime counter saturates at 9,999. Counters cover only this desktop process, are not persistent, and are not a complete runtime error ledger.

The utility sends a separate version **1** diagnostic frame containing only `version`, `generation`, `kind`, `category` and `phase`. The supervisor rejects unsupported versions, extra fields and invalid category/phase pairs. A frame from a stale generation, replaced/exited child or failed incarnation cannot add a runtime counter. Accepted generations are not retained in the export. Frames may be accepted during starting, ready or stopping so that real startup and shutdown failures can be recorded.

The category/phase pairs identify actual catch boundaries:

- `startup / runtime-open`: runtime opening failed; this boundary does not identify the inner cause.
- `startup / file-services-open`: desktop file-service assembly failed.
- `storage / storage-open`: runtime root directory creation/resolution or root catalog opening failed.
- `close / file-services-close`: the router's pre-close file-service cleanup failed.
- `close / subscriptions-close`: shutdown subscription release failed.
- `close / runtime-close`: the actual runtime close call failed.
- `operation / dispatch`: utility file/router dispatch rejected outside its normal handled replies.
- `operation / unknown`: the existing runtime `onError` callback reported a failure without a reliable phase. Exception text is not used to infer one.

A single failure can reach more than one capture boundary, such as storage opening followed by runtime startup failure. Counts are boundary observations, not unique incidents. The storage callback does not cover every later lazy workspace open or storage operation. Ordinary request errors handled by lower layers also do not automatically become diagnostic events. This channel is deliberately narrower than a complete runtime error ledger.

No exception message/stack, SQL, URL, path, username, environment variable, argument, store/session/task ID, work content, prompt, credential or raw log is accepted into retained diagnostic data. Unknown event codes are discarded. This is construction-time exclusion, not collection followed by secret scanning. The runtime error callback no longer relies on ignored stderr for this channel. No network upload is implemented. Reading state neither starts a runtime nor resumes model work; production startup retains `resume: false`. Exported version/platform information still describes the user's software environment; users decide whether and with whom to share the resulting file.

The full JSON and scope explanation are passed to a native preview dialog before the save picker. Cancel is the default. The picker selects a new local JSON filename. The exact previewed snapshot is saved, not a later changed snapshot. JSON remains bounded to 4 KiB. Existing files and symlinks are refused through exclusive creation; exports never overwrite existing files, even if the platform picker offers replacement. New files request POSIX mode 0600; this is not a guarantee of Windows ACL semantics or filesystem encryption. A user-selected synced/network directory may be managed by that filesystem/provider; the application itself does not upload the file.

Only one export is admitted at a time. Normal window closure invalidates pending preview/picker continuation. Once writing starts, closing does not mean the write was cancelled. A failed or ten-second unconfirmed write reports an unknown result and is never replayed automatically. Admission remains occupied until actual I/O settles, even after the wait expires. A partial file can remain; the message asks users to inspect the selected location before another attempt. There is no crash/power-loss durability claim and no automatic deletion of a possibly written file.

## Startup failure and ownership

A host startup failure offers a native **Export desktop diagnostics…** or **Exit** choice once Electron is ready, even if no renderer/window was created. Export uses the same preview, save and uncertainty handling as the Help action. A partially created window is destroyed without prematurely closing this recovery exporter. If Electron readiness itself fails, the fallback is a generic native error box; an export dialog is not guaranteed in that state.

Recovery requests supervisor shutdown while leaving the native review available. Cancelling the review, a dialog failure or a saved/unknown export does not prove that runtime writers stopped. The host waits for observed utility exit before exiting with failure status. An unconfirmed shutdown rejection does not authorize host exit; it shows the shutdown-uncertainty message. A close failure does not release store ownership or permit replacement before actual process exit. If the utility does not exit, recovery can remain waiting; no clean-shutdown claim is made. Diagnostic reporting does not replace the original runtime exception or change the storage cleanup order. A file-write timeout remains unknown even if the user subsequently exits; exiting is not evidence that a pending file write completed.

## Evidence and open gates

The final targeted source run passed **43 tests** across `apps/hipi-work-desktop/test/diagnostics.test.ts` (22), `host.test.ts` (11) and `lifecycle.test.ts` (10), using no GUI, real provider calls or real credentials. Diagnostic cases cover:

- Secret sentinel/extra-field exclusion, strict version/category/phase validation, saturated counters and the original 4 KiB bound.
- Real filesystem storage-open failure through the runtime callback and startup capture; separate runtime-close, file-service-close and subscription-disposal failures.
- Current-generation admission, stale/replaced/exited/failed child rejection and bounded host retention.
- Preview-before-save, cancellation/preparation failures, concurrent admission, normal close invalidation, write uncertainty/timeouts without replay, and exclusive real filesystem creation.
- Startup failure export while the supervisor awaits actual utility exit; cancellation, unknown writes and dialog failures do not end live writer ownership. Observer failures preserve the original exception.
- Chinese/English key completeness and strict bounded prerelease versions.

A further **4 tests** passed across `packages/work-runtime/test/node-cache.test.ts`, `node-unsafe.test.ts` and `apps/hipi-work-desktop/test/runtime-recovery.test.ts`, covering retained owner behavior and real deterministic PI recovery. Desktop and runtime strict TypeScript, scoped Biome and desktop boundary checks passed separately. These checks do not substitute for the repository's final combined gate or a native release run.

Remaining native checks on Windows, macOS and Linux: actual utility-process diagnostic delivery and ordering; startup-failure dialogs with and without a partially created window; shutdown/exit races; menu placement and keyboard access; full preview readability without truncation; accessibility/focus; save picker cancel/replacement behavior; non-ASCII paths; permission failures; closing during dialogs/writes; applicable filesystem permissions and symlink behavior. The source test exercises symlinks on POSIX; Windows requires a native authorized symlink fixture. No GUI or target-platform installation acceptance was performed for this change.

Persistent crash evidence, exhaustive lazy-workspace/storage fault classification and deeper troubleshooting remain open. This implementation must not mark the broader diagnostic, recovery or three-platform RC gates passed.
