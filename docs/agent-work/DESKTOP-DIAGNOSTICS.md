# Desktop diagnostic export

2026-10-19. Implemented source-level host diagnostics; not full runtime diagnostics or native release acceptance. See [desktop host](DESKTOP-HOST.md) and [RC tracker](RC-TRACKER.md).

## User flow and data boundary

The native Help menu provides **Export desktop diagnostics…** after desktop startup. It remains independent of the renderer and does not expose a renderer IPC capability. It preserves the existing application menu. Native text follows the OS locale (Chinese or English fallback), independently of the workbench locale.

The host constructs a fresh JSON document from an explicit allowlist:

- Fixed schema version and product name; numeric app, Electron and Node versions, optionally followed by `-(alpha|beta|rc).number` (each numeric component is at most six digits and total length at most 32; unsupported formats become `unknown`).
- Known platform and architecture enums; synchronous supervisor lifecycle state.
- Five fixed event counters: runtime unavailable, shutdown timeout, renderer gone, export preparation failure and unconfirmed export write. Each counter saturates at 9,999. The counters cover only this desktop process, are not persistent, and are not a complete runtime error ledger.

No exception message/stack, URL, path, username, environment variable, argument, store/session/task ID, work content, prompt, credential or raw log is accepted into retained diagnostic data. Unknown event codes are discarded. This is construction-time exclusion, not collection followed by secret scanning. No network upload is implemented. Reading state neither starts a runtime nor resumes model work. Exported version/platform information still describes the user's software environment; users decide whether and with whom to share the resulting file.

The full JSON and scope explanation are passed to a native preview dialog before the save picker. Cancel is the default. The picker selects a new local JSON filename. The exact previewed snapshot is saved, not a later changed snapshot. JSON is bounded to 4 KiB. Existing files and symlinks are refused through exclusive creation; exports never overwrite existing files, even if the platform picker offers replacement. New files request POSIX mode 0600; this is not a guarantee of Windows ACL semantics or filesystem encryption. A user-selected synced/network directory may be managed by that filesystem/provider; the application itself does not upload the file.

Only one export is admitted at a time. Closing the window invalidates pending preview/picker continuation. Once writing starts, closing does not mean the write was cancelled. A failed or ten-second unconfirmed write reports an unknown result and is never replayed automatically. Admission remains occupied until the actual I/O settles, even after the wait expires. A partial file can remain; the message asks users to inspect their selected location before another attempt. There is no crash/power-loss durability claim and no automatic deletion of a possibly written file.

## Evidence and open gates

`apps/hipi-work-desktop/test/diagnostics.test.ts` uses no GUI, provider calls or credentials. Eleven tests cover secret sentinel/extra-field exclusion, saturation/size bounds, read-only supervisor inspection, preview-before-save, cancellation and preparation failures, concurrent admission, window-close invalidation, write uncertainty/no replay, exclusive real filesystem creation, bilingual keys, strict bounded prerelease versions and write timeout ownership. The existing ten lifecycle tests also pass after adding the read-only supervisor method. Desktop strict TypeScript, scoped Biome and boundary checks are separate checks.

Remaining native checks on Windows, macOS and Linux: menu placement and keyboard access; full preview readability without truncation; accessibility/focus; save picker cancel/replacement behavior; non-ASCII paths; permission failures; closing during dialogs/writes; applicable filesystem permissions and symlink behavior. The source test exercises symlinks on POSIX; Windows requires a native authorized symlink fixture. No GUI or target-platform installation acceptance was performed for this change.

Startup failures that exit before window creation cannot use this menu. Runtime operation/request diagnostics, persistent crash evidence and deeper troubleshooting remain outside this host-only export. This implementation must not mark the broader diagnostic, recovery or three-platform RC gates passed.
