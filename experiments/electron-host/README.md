# Electron host compatibility probe

This is an isolated compatibility experiment, not the Hipi Work desktop application.
It has no UI, preload, application IPC adapter, installer or production permission boundary.
The production host must use TypeScript and the shared application contracts; these small `.mjs`
fixtures intentionally avoid adding Electron or new build dependencies to the monorepo.

## Pinned candidate

Electron **42.11.15**, embedded Node **24.19.0**, Linux x64 is the reproducible experiment baseline.
The Node version matches this development environment, and the release fixes utility-process messages
lost just before exit. Neither fact alone selects the production version. On 2026-10-19 the official
release dashboard lists stable 42, 43 and 44 branches. Electron supports the latest three stable majors;
42 is the oldest supported line. Production selection needs a fresh security/support-window review,
upgrade plan, packaging review and target-platform compatibility testing.

Sources:
- [Exact release and component versions](https://releases.electronjs.org/release/v42.11.15)
- [Official release assets](https://github.com/electron/electron/releases/tag/v42.11.15)
- [Support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Utility process API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Pinned environment variable documentation](https://github.com/electron/electron/blob/v42.11.15/docs/api/environment-variables.md)

## Run without installation scripts

Obtain the official Electron 42.11.15 archive for your platform and architecture from the release
above. Verify its SHA256 against that release's `SHASUMS256.txt`, then extract it outside the repo.
Do not run npm lifecycle scripts or disable Electron's sandbox for this probe. The files below do
not download or install anything. On macOS, `ELECTRON_BINARY` points to the extracted
`Electron.app/Contents/MacOS/Electron`; on Linux it points to the extracted `electron` executable.
Use an existing supported display session for the host probe. macOS and Windows have not been tested.

From the repository root, using a shell variable with your actual executable path:

```sh
# Genuine Electron main -> Chromium utilityProcess -> node:sqlite, with message acknowledgement.
"$ELECTRON_BINARY" experiments/electron-host/main.mjs

# Optional genuine utilityProcess -> public PI runtime test adapter (requires hydrated workspaces).
"$ELECTRON_BINARY" experiments/electron-host/main.mjs --runtime

# Separate evidence: embedded Node only, not Electron main or utilityProcess.
ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BINARY" experiments/electron-host/node-mode.mjs

# Separate evidence: embedded Node loads the public PI runtime adapter and opens SQLite workspace.
# First hydrate the repo's pinned dependencies using npm ci --ignore-scripts.
ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BINARY" --conditions=source experiments/electron-host/runtime-node-mode.mjs
```

The host succeeds only with `electron-ready`, `utility-sqlite-verified` (or `utility-runtime-verified`) and exit code 0.
A normal Node child-process test cannot satisfy that condition. The runtime probe creates only a
fresh temporary workspace and conversation, checks its snapshot, closes runtime resources, and
removes its own temporary data. It does not invoke a paid provider or external tool.

## Verification record, 2026-10-19

- Official Linux x64 archive, 124,909,142 bytes, SHA256:
  `5624ebaa0055cee6ea624e41ba9012e1ac76857448d197dbaf36c4d1812cc681`.
- Official checksum-file SHA256:
  `61e3f0cf9c6e9791dcf3c2813f7ac8b2444d6b610308b768fba0f4425bdc69b7`.
- Both hashes matched GitHub release API metadata; archive entry paths were checked before extraction.
- Initial real Electron launch: exit 133 (SIGTRAP), before `app.whenReady`. Diagnostics included
  D-Bus socket `Operation not permitted` and Fontconfig cache directories not writable.
- Environment: Linux x64, no DISPLAY/WAYLAND_DISPLAY, no Xvfb on PATH. GTK, NSS and GBM libraries exist.
- No sandbox-disabling flag, OS security change, system-component installation, or lifecycle execution.

- Retry with writable temporary XDG cache/config: exit 1 before app readiness; explicit
  `Missing X server or $DISPLAY` / `The platform failed to initialize` diagnostics. D-Bus socket
  access remained restricted. This is an environment blocker, not an application success.
- Same verified binary with `ELECTRON_RUN_AS_NODE=1`: exit 0, reported Electron 42.11.15,
  Node 24.19.0 and SQLite result 42. This proves embedded Node/SQLite only, not utilityProcess.
- All fixture modules pass `node --check` (syntax only). Repo Biome excludes `experiments/`; its targeted
  invocation processed no files. Root TypeScript configuration also excludes these `.mjs` fixtures.
  Neither root lint nor TypeScript checking provides coverage for this experiment.
- After workspace hydration and core validation, the integration owner ran the embedded-Node runtime
  adapter probe successfully (exit 0):
  `{"mode":"embedded-node-runtime-only","version":1,"kind":"runtime-result","electron":"42.11.15","node":"24.19.0","value":42,"workspace":"probe"}`.
  This loads the public test runtime adapter, creates a real SQLite-backed workspace and conversation,
  reads its snapshot, closes the runtime and removes temporary data. It does not prove execution
  inside Electron `utilityProcess`, renderer integration, or desktop packaging.

 GUI/utility-process startup,
macOS, Windows, packaged paths, signing, renderer security, process-tree cleanup and production
runtime integration remain unqualified until their own evidence is obtained.
