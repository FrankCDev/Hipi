# Linux GUI hardening and offline maintenance

2026-10-20. This is a packaging prerequisite for the separately reviewed Ubuntu 24.04 route. It is not a Debian installer, an AppArmor policy, an installation approval, or evidence that Ubuntu 24.04 GUI startup passes. See [Linux host validation](LINUX-SANDBOX-VALIDATION.md) for the remaining host-security and installed-acceptance gates.

## Problem and selected boundary

The previous maintenance smoke invoked `ELECTRON_RUN_AS_NODE=1 hipi-work maintenance.mjs`. That intentionally exposed the GUI binary as a general Node interpreter. A future application-specific namespace policy must not silently grant its GUI attachment context to this maintenance interpreter.

Linux now packages a separate, pinned official Node runtime and an independent `hipi-work-maintenance` shell launcher. The GUI continues to create its real runtime with `utilityProcess.fork` and its document parser with `worker_threads`. Neither mechanism requires Electron's RunAsNode fuse. The maintenance CLI remains a separate offline bundle; its bundle gate excludes model execution, provider, credential, network and child-process imports.

The production launcher always selects `resources/maintenance-runtime/bin/node` and `resources/app.asar.unpacked/dist/maintenance.mjs` relative to its own canonical location. It does not use PATH to find Node, install npm packages, accept an interpreter override, or expose a switch for arbitrary Node code. Arguments go after the fixed maintenance entry. Missing files fail rather than falling back to a global runtime. The Linux runtime pin is x64 only; other Linux architectures fail explicitly until separately reviewed and tested. Windows and macOS retain their current Electron Node-mode maintenance route and fuse configuration.

## Authenticated runtime and notices

- Official release: [Node.js 24.22.0 LTS](https://nodejs.org/en/blog/release/v24.22.0), released 2026-10-14.
- Exact archive: [node-v24.22.0-linux-x64.tar.xz](https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz).
- SHA-256: `cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008`, independently checked against the official release's checksum listing before the download was used.
- [Runtime pin](../../apps/hipi-work-desktop/packaging/node-maintenance-runtime.json) also records the derived hashes of `bin/node`, the complete upstream `LICENSE` including bundled third-party notices, `README.md` and `CHANGELOG.md`. These are copied unchanged, alongside a provenance file that repeats the exact reviewed pin. The complete LICENSE is 157,609 bytes. npm, npx, headers and package managers are not shipped.

On Linux x64, before staging, run:

```sh
node apps/hipi-work-desktop/scripts/hydrate-maintenance-runtime.mjs
```

Hydration downloads only the pinned HTTPS URL, rejects redirects and oversized/mismatched bytes, and extracts only the authenticated members to stdout before writing its own fixed paths. A cached archive is checked again. Altered existing runtime output fails instead of being repaired silently. This is local build preparation, not a system installation. The build host remains separately pinned at Node 24.19.0; maintenance's Node version is not a build-tool upgrade.

## Fuse and serialized-package gates

On Linux only, builder sets `runAsNode=false`, `enableNodeOptionsEnvironmentVariable=false`, `enableNodeCliInspectArguments=false` and `onlyLoadAppFromAsar=true`. The package wrapper reads back the final binary using the builder's locked `@electron/fuses` reader **after builder exits**. The `afterPack` hook runs before builder flips fuses, so it is not sufficient for this assertion.

The existing ASAR allowlist/digest, standalone entry and portable-executable checks remain. Additional final AppImage and tar.gz checks bind the serialized GUI binary, portable helpers, launchers, ASAR, unpacked entries and maintenance runtime/notices to the exact verified output bytes. They require unique regular entries and expected modes. AppImage requires root archive ownership. Builder's portable tar deliberately omits ownership; the tar gate requires those fields to remain absent, not a claimed installed owner. GNU tar's `0/0` rendering of omitted owners is not installation evidence. The tar reader also rejects duplicate/ambiguous paths and non-file/directory entries without extracting them. Packaging records fuse states, runtime provenance and critical-file digests alongside artifact hashes. These are integrity checks, not signing or a complete native dependency audit.

`onlyLoadAppFromAsar` prevents the app-directory fallback. It is not cryptographic ASAR authentication on Linux. These fuse changes remove unnecessary entry points; they do not make the Node-enabled main/utility process an application permission sandbox. See the [official fuse reference](https://www.electronjs.org/docs/latest/tutorial/fuses).

## Compatibility and maintenance operation

Disabling Electron's Node-options fuse also disables `NODE_EXTRA_CA_CERTS`, not just `NODE_OPTIONS`. Existing Linux deployments that rely on that variable to trust a private corporate/provider CA will no longer gain that trust through the GUI environment. No TLS verification bypass or replacement CA mechanism is introduced. Private-CA support needs an explicit, reviewed application trust configuration and acceptance before claiming compatibility. Windows/macOS behavior is unchanged. The standalone maintenance launcher clears `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `ELECTRON_RUN_AS_NODE` and `ELECTRON_NO_ASAR`; maintenance is offline and does not need provider certificates.

Close Hipi Work and its backend, then launch maintenance from an independent terminal outside the GUI process tree:

```sh
"/path/to/unpacked Hipi Work/hipi-work-maintenance" --help
"/path/to/unpacked Hipi Work/hipi-work-maintenance" backup --source "/path/to/closed-store" --destination "/path/to/new-backup"
"/path/to/unpacked Hipi Work/hipi-work-maintenance" verify --backup "/path/to/new-backup"
"/path/to/unpacked Hipi Work/hipi-work-maintenance" restore --backup "/path/to/new-backup" --destination "/path/to/new-history-archive"
```

The portable tar/unpacked folder exposes this launcher. Do not use the GUI or AppImage as a maintenance interpreter. A future fixed installation can expose a launcher symlink to the reviewed root-owned installation, but the standalone Node path must remain outside the GUI's profile attachment and it must not be spawned from the profiled GUI. Inherited process policy cannot be escaped merely by using a different executable. This patch does not create that installation or verify its process labels.

Restore creates a separate read-only historical archive, never a resumable execution store. It does not resume tasks, replay effects, restore credentials or recover external project files. The source store remains independently reopenable. See [maintenance operations](STORE-MAINTENANCE.md) for limits and commands.

## Acceptance boundary

The Linux packaged smoke uses the bundled official Node from a relocated path with spaces and Chinese characters, outside the checkout. It checks SQLite, the actual parser worker bundle, reviewed icon bytes, help, backup/verify, separate archive restore, history/activity metadata and NDJSON export. It checks every preexisting original-store file and the read-only archive retain their hashes, then reopens the original source fixture and compares message identities and the completed receipt. SQLite can create an empty WAL and its 32 KiB shared-memory index during a read-only open; only these new paired sidecars for a known database are permitted and recorded separately. Nonempty new WAL, changed existing WAL/database, missing files and unrelated additions fail. No sidecars are deleted or immutable-open shortcut used to force a pass. All fixture execution is deterministic and uses no real model or keys.

This offline fixture is created and reopened by the pinned build-host Node, not Electron. Actual Electron-created SQLite to bundled Node maintenance to Electron reopen remains a distinct native acceptance requirement. The native harness must close the actual packaged application, run maintenance independently from its parent shell rather than inside the GUI process tree, and reopen the same original store through packaged Electron to compare its original messages and completed receipt.

The opt-in native entry is `node apps/hipi-work-desktop/scripts/smoke-linux-maintenance-gui.mjs`. It runs every existing baseline GUI interaction, checks the completed receipt, waits for clean application/debugger/helper exit, then performs standalone maintenance on that exact owned Electron store. The second genuine Electron launch checks the same message identities, original text and completed receipt. The callback binds launcher/runtime provenance and final fuses, separately verifies read-only archive/export and original-file hashes, and never reopens the recovery archive as an execution store. Pending or failed callback closure retains the owned directories. Its `gui-maintenance/packaged-maintenance.json` and screenshots are separate from the unchanged baseline `gui-smoke` evidence. Contract tests and a host-Node fixture probe are not native execution evidence; this entry remains not-run until the real supported host completes it.

This is not an Electron GUI pass. Existing native GUI/restart, long-history, file-workbench/parser and renderer-sandbox acceptance must run against a fresh artifact with these fuses. No existing GUI validator may be skipped or weakened because the standalone CLI passes. Future installed Ubuntu 24.04 validation still requires its exact reviewed package/host, action-time policy approval, fixed-path ownership checks, actual labels, lifecycle safety and separate installed launch evidence.
