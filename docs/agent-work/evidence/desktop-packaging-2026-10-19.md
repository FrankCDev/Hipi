# Desktop packaging evidence, 2026-10-19

Scope: unsigned Linux staging and packaging regression tests, including both the historical diagnostic package and a later frozen-snapshot package. This checkpoint is not RC acceptance. The source worktree may continue changing; artifacts apply only to their recorded snapshot.

## Capacity checkpoint, 17:40 UTC: build and stage only

The coordinator reported a successful full check (1577 Biome files, no fixes, types and boundaries passed) and explicit verification of 434 Node tests plus 80 UI tests across 16 files. Logs: `/tmp/hipi-capacity-final-check.txt` and `/tmp/hipi-capacity-source-verification.txt`.

The authorized `build:release` and `stage:release` both passed. Compiler input hashes matched before and after compilation. The new stage has source snapshot `a5aeed28a3cf9d77a18ef88f597b30f8dbe854acf4e37cfc8775ee83fba3765e`, lock SHA-256 `c50a291b17168a06904e4f92d6d82cc9b93b390e3bd467ee42d49001d61f06e1`, and build-provenance file SHA-256 `db7222b2bd12db2d689cc5733cd6d110f76638fc44bab60d4d0508fdcee90646`. Version remains 0.0.1 and channel remains unsigned local staging. There are 177 allowlisted payload files, 167 retained-input package owners, and zero missing license records. All four PDF/CMap/font licenses, the PDF asset inventory and UI notices are included.

Bundle sizes: main 95812 bytes; preload 22462 bytes; runtime 2154912 bytes; independent parser 1684895 bytes. Vite reported renderer JavaScript 4165.21 kB (gzip 2126.22 kB), CSS 51.45 kB (gzip 10.98 kB), and PDF worker 1188.81 kB. The large-chunk warning remains; no performance acceptance is inferred. Build/stage logs: `/tmp/hipi-capacity-release-build.txt` and `/tmp/hipi-capacity-release-stage.txt`.

No installer compression or packaged runtime smoke was performed for this checkpoint. Existing `.artifacts/hipi-work/packages/` files were left unchanged and both previous SHA-256 checks passed again. Those installers and their Node-mode smoke evidence belong to the 17:05 source snapshot below, not this capacity checkpoint.

`package:release` reads payload and provenance from the prepared stage; it does not rebuild current source. Its packaging script/configuration come from the executing checkout. New source therefore requires a fresh verified build and stage, and packaging configuration must remain fixed while packaging. The wrapper rejects a nonempty output directory, so earlier installers must be deliberately preserved separately before any future packaging run.

## Frozen source checkpoint, 17:05 UTC

The later frozen build and staging passed with source snapshot `e821b5432c6f64fbe72f0e06026e5b6726cd6821172680a5eb0d29d71b2dbe03`, lock SHA-256 `f363eb52bc31f9fb6a9db860b7115a3b42eb394f172223e2a3b32c282165308b`, and app version 0.0.1. Build input hashes matched before and after compilation. The coordinator's final `npm run check` and explicit source verification passed: 379 Node tests and 61 UI Vitest tests across 13 files. These are source checks, not native GUI tests.

The original Nix model catalog was found incompatible with a current source test model. It was left unchanged. The independently pinned Hipi catalog is `sha256-c49b4793882a914530cbfddd3a30d80bece8a28afebb577f341e2690b120e703`, 946736 bytes, obtained from the public immutable revision endpoint and SHA-256 verified before hydration. It contains the required NVIDIA model; root TypeScript checking passed after hydration. The hydrator now reads with a 32 MiB actual streamed-byte bound, cancellation on overflow, a 60-second timeout and no redirects. Two additional download-bound regression tests passed.

The final stage contains 177 payload files, plus its provenance file. Retained bundler inputs identify 167 package owners; missing license texts are zero after explicit workspace root-license inheritance and the two documented original-license supplements. The PDF asset inventory and all four PDF/CMap/font licenses are included. Actual post-pack ASAR file-set, payload-digest and unpacked runtime/parser checks passed again.

The final generated Linux unpacked distribution was copied outside the repository to a temporary path containing spaces and Chinese characters, then launched from `/tmp` using its own executable with `ELECTRON_RUN_AS_NODE=1`. Its packaged independent CSV parser worker and an in-memory SQLite query both passed. Observed runtime: Electron 42.11.15, Node 24.19.0, SQLite 3.53.3. The temporary copy was removed. This rules out workspace dependency fallback for that smoke test; it does not exercise GUI, preload, utilityProcess IPC or installation.

Final compression completed at 17:08 UTC. Independent `sha256sum -c SHA256SUMS` passed for both artifacts. Output location: `.artifacts/hipi-work/packages/`, alongside `SHA256SUMS` and `release-provenance.json`. The working source may move forward after staging; these artifacts belong to the exact frozen snapshot above, not later edits.

| Frozen artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Hipi-Work-0.0.1-linux-x64-unsigned.tar.gz | 123452349 | 8c7d00470219cc09f07f98a143394e2f4116c5a6a80e727cff81874d0072023e |
| Hipi-Work-0.0.1-linux-x86_64-unsigned.AppImage | 130501209 | fca4c4590a451f6387886d49cb2bd501d143d70d643bbd30f3c22fddbd85442e |

## Passed

- Official npm registry metadata checked for electron-builder 26.15.3; installed through root-owned `--ignore-scripts` workflow. See [release procedure](../DESKTOP-RELEASE.md).
- Fixed public model catalog `sha256-ffa3e98626230f378f80200debb736c4a2238b5f2ba246a92cfc7d8e19604678` downloaded, SHA-256 checked, then hydrated offline.
- Linux production bundles built with source maps disabled. Renderer chunk-size warning remains visible; approximately 4.14 MB main renderer and 1.19 MB PDF worker are not performance acceptance.
- Actual electron-builder Linux x64 package reached the post-pack hook: exact ASAR file set, every staged payload hash, and real unpacked runtime/parser files passed.
- Eight focused regression tests passed: strict payload allowlist; map/private-path rejection; missing explicit test-file rejection; valid ASAR; extra-map rejection; payload-tampering rejection; missing-unpacked-worker rejection; development/ASAR path handling including spaces, Chinese and Windows separators.
- New workflow YAML parsed with four explicit host/architecture matrix rows. This is syntax/configuration evidence, not a GitHub Actions execution.
- Release document relative links checked. No Git metadata exists in this checkout, so no commit SHA or successful `git diff --check` is claimed.

## Historical unsigned artifacts

Location: `.artifacts/hipi-work/packages-historical-20261019/` (local generated output, excluded from repository source).

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| Hipi-Work-0.0.1-linux-x64-unsigned.tar.gz | 123473690 | bc87368229446e7bf8609e716d0c91a6f38bd571f59367315a56254779474ad8 |
| Hipi-Work-0.0.1-linux-x86_64-unsigned.AppImage | 130525706 | 52ee1b5d9c6a702cf7e356b4a64b6d1dd525b283a3665afae968c11ed72d36d6 |

These predate the final source-snapshot build wrapper and actual-bundle license narrowing. Their recorded source digest is a post-build observation, not a proven compiler-input snapshot. Keep them as historical packaging diagnostics only; do not distribute them as the current client.

## Resolved pipeline failures

- Initial download cache attempted the read-only default home directory. Explicit `electronDownload.cache` and builder cache under `.artifacts/hipi-work/cache` resolved this without changing filesystem security or installing anything.
- A test filename mistakenly used `.tsx` instead of `.ts`; the explicit existence gate caught it before Node execution. The test list was corrected.
- The runtime browser-boundary script expects its package working directory. The runner now invokes it with that directory explicitly.
- A source-snapshot build rejected concurrent edits, as intended. Another transitional production build failed on a private/unexported runtime import; the owning implementation fixed that source. Neither failure was marked passed.

## Open acceptance gates

- Later source edits require a new aggregate check and new frozen artifacts; the successful 17:05 source checkpoint and 17:08 package results above do not cover them.
- Native GUI remains blocked in this cloud environment by the observed socket permission restriction. Node/ASAR inspection cannot prove Electron utility-process, renderer, preload or worker behavior in a running application.
- Windows and macOS builds, installation, signing/notarization, GUI/IME/accessibility, system credential storage, update/migration failure and recovery have not run here.
- Default Electron application icon remains a distribution-quality gap. No branded-icon or OS-trust claim is made.
- No automatic updater, production update feed, commit, push, tag, publication, system install or user-device operation was performed.
