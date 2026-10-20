# Desktop packaging and release gates

2026-10-19. This is an unsigned staging pipeline, not an approved 1.0 RC or a release authorization. [RC-TRACKER.md](RC-TRACKER.md) and [ACCEPTANCE.md](ACCEPTANCE.md) remain authoritative for acceptance. The application version remains the workspace manifest version; packaging never invents a release tag.

## Reproducible inputs and commands

Run from the repository root with Node 24.19.0 and the reviewed lockfile:

```sh
npm ci --ignore-scripts
node apps/hipi-work-desktop/scripts/hydrate-release-models.mjs
node apps/hipi-work-desktop/scripts/verify-source.mjs
node apps/hipi-work-desktop/scripts/build-release.mjs
node apps/hipi-work-desktop/scripts/stage-release.mjs
node apps/hipi-work-desktop/scripts/package-release.mjs --x64
```

On Apple Silicon use `--arm64`. Packaging always selects the host OS; it rejects arbitrary builder options, signing and publishing arguments. `--dir` produces an unpacked inspection build, not a distributable installer. Move an existing `.artifacts/hipi-work/packages` directory aside before another attempt; the wrapper refuses to mix results with previous builds. No system install command is part of this procedure.

Hydration fetches only the public typed catalog revision in `apps/hipi-work-desktop/packaging/model-catalog.json`, checks its SHA-256, then uses the existing offline hydrator. It does not fetch live provider inventories, inspect credentials, or invoke a model. Source launches and tests require hydrated provider data. A missing, incompatible, or hash-mismatched catalog is a build failure; do not silently substitute live data. This Hipi pin is independent of the upstream Nix pin: the latter lacked a model required by current source tests and was not changed.

The source entrypoint checks every explicitly named test file exists before invoking Node or Vitest, then checks hydrated model data, strict workspace types, browser/desktop boundaries, the listed Node tests, and the explicitly listed UI Vitest files. It never invokes the repository-wide Vitest suite or paid provider tests. Add newly approved tests to the explicit list; discovery is deliberately not automatic. The repository's full `npm run check` is a separate required integration check.

`build-release.mjs` hashes workspace sources and necessary build inputs before and after `prepare --release`, rejecting edits during compilation. It records generated-bundle hashes. Staging refuses bundle or dependency/version drift from that record. Packaging also rejects a changed staging provenance during its run. Keep the worktree stable during a release candidate build; a later source fix requires a new build and new acceptance evidence.

## Toolchain decision

Use electron-builder only, pinned at 26.15.3 in desktop development dependencies. The official npm registry query on 2026-10-19 returned MIT, Node >=14, and integrity `sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==`. The project build host remains Node 24.19.0, Electron 42.11.15 and Vite 8.0.16. Electron's own bundled Node is a distinct runtime that needs its own verification.

The dependency install used `--ignore-scripts`: 224 new lock entries, no prior package-version changes, and npm reported 225 additions. New transitive `electron-winstaller@5.4.0` declares `install: node ./script/select-7z-arch.js`; it was inspected but not executed. It copies bundled 7-Zip architecture files. The selected Windows target is NSIS, not Squirrel. Do not enable `install-app-deps`, npm lifecycle rebuilds, or Squirrel as a workaround. Deprecation notices for `boolean@3.2.0` and `rimraf@2.6.3` remain dependency-review findings. A successful package is not a clean dependency audit.

References: [builder configuration](https://www.electron.build/configuration/), [builder repository](https://github.com/electron-userland/electron-builder), [official registry metadata](https://registry.npmjs.org/electron-builder/26.15.3).

## Candidate outputs and support evidence

| Native build host | Architecture | Configured output | Actual product support |
| --- | --- | --- | --- |
| Ubuntu 24.04 CI | x64 | AppImage and tar.gz | Pending install/GUI acceptance |
| Windows Server 2022 CI | x64 | Per-user NSIS installer and zip | Pending Windows client install/GUI acceptance |
| macOS 14 CI | arm64 | dmg and zip | Pending signing, notarization and native acceptance |
| macOS 15 Intel CI | x64 | dmg and zip | Pending signing, notarization and native acceptance |

The [GitHub-hosted runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) was checked for these exact runner labels. CI availability and successful packaging do not establish minimum supported OS, hardware, architecture, or distribution compatibility. Windows/Linux arm64 and universal Mac packages are not configured or promised.

The [Electron 42.11.15 README](https://github.com/electron/electron/blob/v42.11.15/README.md) states macOS Monterey and later, Windows 10 and later, and lists Ubuntu 18.04+, Fedora 32+, Debian 10+ for its Linux binaries built on Ubuntu 22.04. Those are upstream statements, not Hipi Work compatibility results. Hipi minimum OS and hardware remain unverified until tested on the exact proposed minima. No builder minimum-system field is used to turn an untested number into a support claim.

## Payload and provenance boundary

`dist` is a build intermediate. Staging creates a separate dependency-free application manifest and copies only:

- main, sandboxed preload, independent runtime and independent parser bundles;
- renderer index and compiled JS/CSS assets;
- PDF asset inventory, all four PDF/CMap/font licenses, and UI notices;
- root license, retained bundle-package LICENSE/NOTICE texts and a dependency provenance manifest;
- version, toolchain, lock/model-catalog hashes, workspace-source snapshot hashes and payload SHA-256 records.

No source tree, node_modules, source maps, esbuild metafiles, environment files, databases, credentials, temporary fixtures, or arbitrary renderer JSON is accepted. Unknown build payloads and symlinks fail closed. Maps/metafiles are excluded and source-map references/private checkout paths in allowed text are rejected. This is an explicit build-payload boundary, not a guarantee that arbitrary application strings are secret-free; release review must also inspect generated code and diagnostic exports.

The dependency manifest resolves package owners from retained esbuild output inputs and Vite chunk modules/assets, rather than blindly copying the complete production dependency closure. Build-only metafiles remain outside the package. This is input-level provenance, not a claim to a complete audited SBOM for Electron's native distribution. Packages without collected license text are marked `manual-review-required`; staging and packaging fail until resolved. PDF licenses and the asset inventory are mandatory. Electron's distribution also retains its own upstream license files.

Workspace packages explicitly inherit the root MIT license. `isarray@1.0.0` retains its locked README's full license section. `react-remove-scroll-bar@2.3.8` uses its declared MIT terms plus an unchanged, hash-pinned later upstream license; [supplement provenance](../../apps/hipi-work-desktop/packaging/licenses/README.md) records this distinction. Any version/declaration/hash change requires review.

ASAR stays enabled. Only `dist/runtime.mjs`, `dist/preview-parser.mjs` and the independent Node-only `dist/maintenance.mjs` are unpacked. The main process resolves the utility entry through `runtimeResource`; the parser stays next to the real runtime file. The post-pack hook reads the generated ASAR with the packager's pinned ASAR reader, checks its exact file set and all staged SHA-256 values, and checks all three unpacked files. This proves archive layout and byte integrity; it does not prove that Electron's utility process or worker actually starts on every OS.

### AppImage outer launcher security gate

The original 2026-10-19 AppImages are rejected for distribution: builder 26.15.3 generated `Exec=AppRun --no-sandbox %U`, and its AppRun independently added that flag when `unshare -Ur true` failed or was unavailable. Unpacked-binary smoke tests did not inspect this outer launcher and cannot establish AppImage sandbox behavior.

The reviewed replacement uses `appImage.executableArgs: []` and a project-owned minimal AppRun. The Linux post-pack hook places it in the application directory; the pinned builder copies that directory over its generated launcher. No vendor dependency is patched. The launcher preserves argument boundaries and required AppDir library/data paths, rejects sandbox-disabling arguments, and directly executes Electron without a fallback or retry. Host sandbox failures remain failures. This does not make Ubuntu 24.04 GUI support pass; its native security-policy blocker remains open.

Before writing artifact checksums/provenance, `package-release.mjs` reads the actual AppImage through the packager's pinned 7-Zip reader, without executing the image. Both AppRun and the desktop entry must match complete reviewed bytes, occur exactly once, be root-owned regular files, and have modes 0755/0644 respectively. The main binary, `chrome-sandbox` and `chrome_crashpad_handler` must also occur once as root-owned regular 0755 archive entries. Relevant metadata fields must be unique. Builder changes, unexpected desktop fields, altered flags, privileged or writable executable modes, or a failed launcher overwrite stop packaging. This checks launcher integrity and selected native-file metadata, not the complete native Electron payload or a real AppImage GUI launch. Old packages must remain historical evidence, not downloads offered as safe candidates. macOS and Windows packaging do not use this launcher.

The Linux post-pack hook independently checks those three native executables with `lstat` before any configured archive is produced. It rejects links, directories, missing files and every mode other than 0755 without changing them. Thus portable packaging cannot silently introduce a SUID helper to make a blocked host pass. This staging check also precedes tar.gz creation; it is not a final tar.gz archive audit or proof of working host namespaces. Actual AppImage metadata is checked again after serialization. [Linux host validation](LINUX-SANDBOX-VALIDATION.md#ubuntu-2404-production-packaging-decision) records the separate Ubuntu 24.04 installation/security decision.

Output files use `Hipi-Work-<version>-<os>-<arch>-unsigned.<ext>`. `SHA256SUMS` and `release-provenance.json` accompany installers/archives. The latter records remaining acceptance states as `not_run`. The CI workflow retains only selected packages and evidence for seven days, with read-only repository permissions. It never creates a GitHub release, publishes an update feed, accesses signing credentials, or installs the application.

## Mandatory target-platform release gate

For each candidate artifact, record exact SHA-256, OS/build, architecture, hardware, installed location and result for:

1. Install, launch from a clean non-repository location with spaces/non-ASCII characters, production default, renderer/preload isolation, independent utility and parser start, PDF resources, SQLite reopen, and clean shutdown.
2. Keychain/credential-store behavior, single-owner lock, crash and lost-response recovery, file grants/revocation, sleep/resume, Chinese IME, keyboard navigation and accessibility.
3. Platform signing and notarization where applicable. Unsigned staging must not be represented as trusted distribution; do not bypass OS security warnings to get a pass.
4. Verified update source, integrity and version compatibility; interrupted download/install, startup failure, migration backup/restore and failed recovery. There is currently no automatic updater or production update feed. Application rollback does not prove data downgrade safety.
5. Confirm dependency-license review, source/lock/toolchain provenance, performance budgets, and all remaining [RC gates](RC-TRACKER.md).

Use `passed`, `failed`, `blocked`, or `not_run` with actual evidence. A CI green job only closes the source/package checks it executed. Native installation, GUI, signing, update and recovery gates remain open until separately observed. No commit, push, tag, publication, credential provisioning or user-device access is authorized by this document.
