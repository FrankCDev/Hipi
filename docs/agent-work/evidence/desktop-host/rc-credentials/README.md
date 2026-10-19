# Desktop build and credentials checkpoint

Date: 2026-10-19. Source checkout has no Git metadata. This is not a signed release qualification.

- `npm run prepare:desktop --workspace=@hipi/work-desktop`: passed. See `build.txt`; renderer chunk warning retained.
- `node node_modules/electron/install.js`: official installer completed with exit 0 using packaged checksums. No mirror, certificate bypass, or remote-checksum override was used.
- `node_modules/electron/dist/electron --version`: returned `v42.11.15`; environment DBus/font cache diagnostics retained in `electron-version.txt`.
- Actual Electron application launch, deterministic mode, temporary user data: failed with exit 133, `socket() failed: Operation not permitted`. See `electron-app-launch.txt`. No sandbox or system permission settings were changed. Renderer, native lifecycle, utility process, and native keychain acceptance remain blocked.
- Desktop credential, host, lifecycle and recovery targeted tests: 29 passed (`tests.txt`). Credential tests use only synthetic secrets and local synthetic crypto. They verify weak Linux backend rejection, unavailable encryption, serialized writes/removal, encrypted persistence, corrupted/oversized/wrong-key preservation, atomic replacement failure cleanup, secret-free errors, narrow renderer request validation, RPC quotas and generation isolation. They do not prove native OS encryption behavior.
- Desktop `npm run check`: passed (Biome, TypeScript, preload import graph and main/runtime ownership checks).
- Built `runtime.mjs` was copied outside the checkout to a directory with spaces and non-ASCII characters. Under Node 24.19.0, a synthetic parentPort harness confirmed startup and clean shutdown for both deterministic and production modes with separate temporary stores. No credentials were configured or model requests submitted. This validates bundled runtime loading and shutdown, not actual Electron IPC or a packaged installer.

Production starts with explicit `--provider=production`, independent `production-store`, no ambient authentication and no automatic paid resumption. Deterministic mode remains explicitly selectable with `start:deterministic`. Credential management uses a separate shared v1 schema, not AppClient request receipts. Main owns safeStorage and the bounded encrypted file; utility secret reads use a private incarnation-scoped RPC. Atomic rename does not constitute a cross-platform power-loss guarantee.
