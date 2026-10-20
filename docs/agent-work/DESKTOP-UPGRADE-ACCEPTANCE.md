# Desktop manual upgrade and recovery acceptance

This is a required execution plan, not passed acceptance. No automatic updater or update feed is needed for the initial manual delivery path. Every case below remains `not_run` until observed for the exact final artifacts on the declared target platform. A signed package or a successful archive check does not close A21/A22.

## Evidence and ownership

Record old/new application versions and artifact SHA-256, source/lock identifiers, OS/build/architecture, filesystem, installation location, store schema and the actual steps/results. Use `passed`, `failed`, `blocked` or `not_run`; incomplete substeps cannot inherit a parent pass.

Packaging owns artifact identity, source provenance and native signatures. Desktop/runtime owners retain shutdown, store migration, credentials and recovery behavior. Missing product entrypoints or native host access must be reported as blockers, not substituted with a successful synthetic test.

Do not use a user's actual working data for fault injection. Use disposable, explicitly approved native test accounts or machines and synthetic workspace files. Credential-store qualification uses a dedicated approved fixture rather than an actual provider key; no paid model calls are required for upgrade testing.

## Normal manual upgrade

1. Obtain old/new packages and manifests from the explicitly approved distribution source. Independently verify exact version, target and SHA-256, plus applicable native signature/notarization. A checksum from the same untrusted source is not source authentication. A partial download, wrong target, changed publisher or failed trust check must stop before execution.
2. Save or explicitly discard dirty editor work using the existing UI. Exit normally and verify owned runtime, parser and maintenance processes have actually stopped. A closed window, IPC disconnect or timeout is insufficient. A remaining owner lock is `BUSY`, never permission to delete an owner file or kill an unknown process.
3. Locate the actual production store from the application's host context. Perform the supported offline backup and verify its completed manifest. Retain the original store and backup. Check the canonical [store compatibility table](STORE-MAINTENANCE.md#存储版本兼容性); an unsupported schema or unqualified legacy migration is a blocker. Never copy only SQLite main files, discard WAL, replace owner files, or rename an owner-containing store directory.
4. Execute the native installation/replacement procedure. Windows: per-user NSIS upgrade, including custom paths and running-app handling. macOS: copy from the verified DMG to the intended application location and replace only application files. Linux: qualify the actual AppImage entrypoint and tar installation path without weakening sandbox policy. Test spaces and non-ASCII paths. Application version replacement must not delete user data.
5. Launch without a test-provider override and establish production-default startup without making a model request. In separate deterministic fixtures, verify store identity, workspace/conversation identity, message contents, receipts, pinned/search metadata, tool-pack bindings and settings. Reopening history must not automatically resume tasks, repeat external effects or regrant file access.
6. Verify credential availability or a safe actionable unavailable result. The upgrade must not fall back to plaintext or log secrets. Signature changes may affect platform credential behavior and need native evidence.
7. Exit and reopen again; verify the same persistent facts and clean process/owner release. Validate the installed executable and resources, not just the builder's unpacked directory.

## Required failure cases

| Case | Required observation |
| --- | --- |
| Truncated/altered download, wrong version or architecture | Integrity/identity rejection before installer or app execution; old installation/data remain usable. |
| Missing/untrusted native signature or notarization | Failure without bypassing an OS security warning, removing quarantine or changing trust/security settings. |
| Running app or held store owner | Upgrade/maintenance does not modify an active store or manufacture a second writer; user can safely cancel. |
| Installer cancelled/interrupted; locked or unwritable destination | Original data and backup remain intact; the actual old/new installation state is reported, not assumed atomic. |
| Insufficient disk space or failed writes | No false success; no automatic deletion of backups or user files to recover space. |
| New app fails before opening data | Reinstalling the previously verified application can be qualified separately, only when evidence proves no incompatible data changes occurred. |
| New app fails during/after migration | Preserve source/backup, identify actual schema/state and use a verified recovery/repair path. Never point an older executable at changed data merely because it launches. |
| Older executable sees a newer schema | Safe rejection before migration/execution; no silent downgrade or guessed compatibility. |
| Recovery interrupted or reply lost | Preparing/incomplete archive is rejected; a ready archive is inspected and verified before claiming completion. Retry uses a new destination, not overwrite. |
| Uninstall/reinstall | Default uninstall retains application data; test actual platform behavior. Data removal is a separate user action, not part of this procedure. |

## Recovery is not executable rollback

Normal-store and backup schema compatibility is recorded in the [store compatibility table](STORE-MAINTENANCE.md#存储版本兼容性). The existing restore command creates a new schema-4 read-only historical archive with a new store identity. It does not restore an executable copy of pending work, approved operations, file grants or provider credentials. The normal runtime must reject that archive.

The recovery case must verify complete historical text/export, correct snapshot warnings and unchanged external-effect counts through restore, browse, export and repeated reopen. Preserve original store, backup and failed targets. No in-place overwrite, owner deletion, automatic directory rotation or task replay is allowed.

Recovering readable history cannot be recorded as successful data downgrade or automatic return to executable work. If a usable repair/new-work path or native maintenance entrypoint is absent, keep that part of acceptance blocked and assign it to the desktop/runtime owner. Do not imply that a document or source CLI supplies a shipped native interface.

Real power-loss and filesystem qualification remain distinct from process termination tests. Existing Ubuntu 22 or older-build results do not establish current Windows/macOS/Linux installation or upgrade acceptance. Refer to [release gates](DESKTOP-RELEASE.md), [store maintenance](STORE-MAINTENANCE.md) and [RC tracking](RC-TRACKER.md).
