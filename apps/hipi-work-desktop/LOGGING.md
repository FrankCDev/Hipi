# Desktop operational logging

The private, Node-only `@hipi/work-logging` package uses pinned Pino 10.4.0 for structured serialization and rotating-file-stream 3.2.10 for file output/rotation. Its public `record(event, context)` / asynchronous `close()` contract exposes no Pino or Electron types. Electron supplies the log directory and owns lifecycle; the Node development launcher uses the same package without a disk destination. There is no worker transport, custom file writer, or dependency on Electron in this package.

## Ownership and output

- Only main writes `desktop.log`. Utility diagnostics retain the validated, generation-fenced IPC route to main. Renderer/preload cannot submit arbitrary logs. No logging IPC, console interception, automatic error capture or remote transport is enabled.
- Initialization follows launch/profile validation and single-instance ownership. Production uses `app.getPath('logs')`; development uses `Hipi Work Development/logs` beneath app-data, separately from production. Smoke runs retain their isolated temporary profile.
- Disk is UTF-8 JSONL with UTC `time`, schema version, level, event, role, PID, process-session UUID and allowlisted scalar context. Context includes runtime-generation/request UUIDs, duration, exit code and fixed stage/category/outcome. Request IDs identify a host invocation, not an end-to-end provider trace. Successful requests are debug-only and not written to disk.
- Development output is readable stderr with fixed event-specific instructions; main startup announces its log directory only there. CLI lifecycle events are emitted once through the logger, never with arbitrary exception text. Operational logging never writes protocol stdout. Vite/esbuild retain their own compiler diagnostics.
- Native child stdout/stderr is relayed unchanged to the development terminal, separately from operational records. It can contain native diagnostic paths or messages and is not copied into persistent operational logs or diagnostic exports. Main's already-formatted operational events pass through this relay without a second logger wrapper.
- Messages, stacks, URLs, credentials, prompts, tool data and arbitrary objects are excluded. Only own data properties are read; getters and caller serializers are not invoked. Diagnostic precision is intentionally narrower than unrestricted exception dumps.

## Product storage budget

These are Hipi's initial budgets, not universal industry standards:

- Each record is at most 1,024 UTF-8 bytes before newline.
- The rotation threshold is 5 MiB. One bounded record may cross it. Keep active `desktop.log` plus one `desktop.1.log` archive, bounded by `2 × (5 MiB + 1,026 bytes)` under normal managed writes.
- Startup removes only those two owned files older than 14 days by modification time. This is not continuous wall-clock expiry. Unrelated files are untouched.
- Final log directory must be a real directory; existing log targets must be regular, singly linked files. Parent ancestry is a trusted shell-provided path and can include OS-managed symlinks. These checks do not protect against hostile same-user filesystem races.
- Newly created directories/files request 0700/0600 on POSIX. Existing permissions and Windows ACLs are not changed.
- RFS owns asynchronous file output. Admission stops when its public Writable backpressure signal is false and resumes on `drain`; excess events are dropped, with `droppedRecords` saturated at 9,999. There is no extra application queue or retry. `record()` reports admission, not disk durability.
- `close()` rejects further records and waits up to two seconds for accepted output, returning `flushed`, `failed` or `timeout`. Repeated calls share one promise. It does not claim fsync/power-loss durability. Logging failure never overrides runtime shutdown ownership.

## Failure and sharing boundary

Directory/write/rotation failures emit one fixed stderr `LOG_WRITE_FAILED` marker per logger instead of raw errors or paths. Failed logging stops accepting events. RFS's public rotation API owns archive handling; no text-cropping fallback or second writer is used. Application exit awaits bounded close rather than abandoning an accepted async queue.

Help → Export diagnostics remains a separate, previewed 4 KiB session-counter export. It does not include these log files; nothing is uploaded automatically. A raw-log viewer/exporter is not implemented here.

## Evidence and limitations

From `packages/work-logging`, run `node --test test/logging.test.mjs` for actual Pino/RFS JSONL, rotation, retention, stream errors, admission/backpressure, bounded close, redaction, linked targets, Node bundle relocation and browser-import rejection. From the desktop package, run `node --test test/logging.test.mjs scripts/boundary-graph.test.mjs` for workspace resolution and composition-root-only logging imports. Native Electron, Windows/macOS filesystem behavior and production performance require platform qualification; these tests do not establish them.

Official references: [Pino](https://github.com/pinojs/pino), [rotating-file-stream](https://github.com/iccicci/rotating-file-stream).
