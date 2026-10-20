# Linux sandbox host validation

2026-10-19. This records an environment blocker, not a GUI pass or a production security-policy change.

## Observed failure

[Run 39314364770](https://github.com/FrankCDev/Hipi/actions/runs/39314364770) used Ubuntu 24.04, kernel `6.17.0-1022-azure`, host Node `24.19.0`, and Electron `42.11.15`. The native GUI smoke exited before renderer readiness. Its `failure-native.log` says the SUID sandbox helper is not configured with the required root ownership and mode 4755; Chromium aborted instead of running unsandboxed. The GUI report has no completed checks. Source, packaging and Electron Node-mode results are separate evidence and cannot establish renderer startup.

The log establishes failed SUID-helper setup. It does **not** by itself prove which condition made the namespace sandbox unavailable. Ubuntu's [24.04 release notes](https://documentation.ubuntu.com/release-notes/24.04/) document default AppArmor restrictions on unprivileged user namespaces. The subsequent host observations below support that explanation, but do not isolate AppArmor as the sole cause of the earlier Electron failure: the probe uses a different executable, and no matching kernel audit record was collected.

### Actual hosted-runner observations

[Run 39318246047](https://github.com/FrankCDev/Hipi/actions/runs/39318246047), observed at 20:20 UTC on 2026-10-19, produced these `linux-sandbox.json` results without changing host policy:

- **Ubuntu 24.04:** kernel `6.17.0-1022-azure`, Node `24.19.0`, effective UID `1001`; Xvfb, unshare and true all present. `apparmor_restrict_unprivileged_userns=1`, `unprivileged_userns_clone=1`, `max_user_namespaces=63838`. The namespace subprocess exited 1 while writing `/proc/self/uid_map`, reporting `Operation not permitted`; no timeout or signal was reported. Probe status is `blocked`.
- **Ubuntu 22.04:** kernel `6.8.0-1064-azure`, Node `24.19.0`, effective UID `1001`; the same three executables present. `apparmor_restrict_unprivileged_userns=0`, `unprivileged_userns_clone=1`, `max_user_namespaces=63848`. The namespace subprocess completed with exit 0 and empty stderr. Probe status is `candidate_requires_packaged_gui_validation`.
- **Both hosts:** `productGuiValidated=false`. At this checkpoint, the new native-GUI validation had not reached a confirmed terminal result. The Ubuntu 22.04 capability result neither establishes a GUI pass nor resolves Ubuntu 24.04's blocker. The probe records kernel and OS versions, not the runner image build identifier; do not infer the latter from these JSON files.
- **Existing Chrome helper on both hosts:** the fixed `/opt/google/chrome/chrome-sandbox` path was a regular, non-symlink file resolving to that exact path, UID `0`, mode **`0777`**, SHA-256 `be9f5d4be90fa60b985ad3069812b144ba7331fed0c3f980c6d9399d37d60314`. It has **no setuid bit and is world-writable**. Root ownership and a matching hash therefore do not establish a safely configured or usable shared SUID helper. It was not executed or selected. Do not change its permissions or grant setuid to it as an automatic repair.

## Upstream behavior and local contract

- [Chromium zygote initialization](https://github.com/chromium/chromium/blob/main/content/browser/zygote_host/zygote_host_impl_linux.cc) selects a namespace sandbox when its capability check succeeds, otherwise considers the SUID helper. This upstream source explains the route; it is not a build-identical reproduction of the shipped Electron binary.
- [Chromium's capability check](https://github.com/chromium/chromium/blob/main/sandbox/linux/services/credentials.cc) includes creating a user namespace, UID/GID mapping, dropping capabilities and a further namespace operation. A simple successful `unshare -Ur true` is useful evidence, but is not identical to that check or proof of working Electron sandboxing. AppArmor policy can differ by executable path.
- [Electron sandbox documentation](https://www.electronjs.org/docs/latest/tutorial/sandbox) distinguishes renderer configuration from disabling the entire Chromium sandbox. Hipi's `main.ts` has `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true` and `webSecurity: true`. The current GUI harness passes no sandbox-disabling switch.
- Installed Electron `42.11.15` types expose renderer `process.sandboxed`. `app.getAppMetrics()` process `sandboxed` is annotated for macOS/Windows, so it must not be treated as a supported Linux proof. If runtime evidence is added later, collect it from the actual isolated preload/renderer and corroborate OS sandbox state; a configured preference alone is insufficient.

## Read-only capability probe

Run from the repository root:

```sh
node apps/hipi-work-desktop/scripts/probe-linux-sandbox.mjs
node --test apps/hipi-work-desktop/test/probe-linux-sandbox.test.mjs
```

The probe records OS/kernel/Node, effective execution UID, three bounded integer sysctls, whether Xvfb/unshare/true are available, and the result of a five-second `unshare -Ur true` subprocess. It performs no privileged command, persistent configuration write, AppArmor reload, permission change, helper execution, or installation. The child creates only temporary namespaces and exits.

It also inspects the existing fixed `/opt/google/chrome/chrome-sandbox` path without executing it: regular-file/symlink status, root UID, permission mode, exact resolved path, and a bounded hash when the path is an ordinary file that resolves to that exact location. This is metadata, not provenance or API compatibility proof. Missing/inaccessible values stay unavailable; no alternate path is substituted.

Exit 0 on Linux means only `candidate_requires_packaged_gui_validation`: non-root execution, Xvfb present and the namespace probe completed. Exit 1 means `blocked`. On other platforms the probe reports `not_applicable`. Every result explicitly has `productGuiValidated: false`. A namespace failure is not automatically an AppArmor diagnosis. A blocked result must remain visible rather than be converted into GUI success.

Local test evidence: Debian 13 cloud workspace, Node 24.19.0, UID 1000; unshare completed, Xvfb absent, fixed Chrome helper absent. The probe correctly returned `blocked`; its contract test passed. This is not evidence about either GitHub Ubuntu image. Probe code and test received a targeted Biome check; no full-repository formatting or check was run for this task.

## Smallest CI experiment

1. Keep Ubuntu 24.04 source/package/Node-mode validation. Record sandbox capability separately and retain blocked native-GUI evidence. Do not claim Ubuntu 24.04 GUI acceptance or hide the failed native attempt behind a generic success summary.
2. Add a **temporary, separate** `ubuntu-22.04` native GUI validation job, recording the actual runner image version and probe output. Keep the same pinned Electron, production sandbox preferences, fixture isolation and substantive UI/restart checks. Do not use sandbox-disabling flags or alter host policy. A probe pass must still be followed by the actual packaged GUI test; only completed checks count.
3. Keep Ubuntu 24.04 installation/security prerequisites and native GUI acceptance open even if Ubuntu 22.04 passes. Testing a different supported OS configuration does not establish behavior on the blocked one.

GitHub's [runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) still lists `ubuntu-22.04`, but [its retirement announcement](https://github.com/actions/runner-images/issues/14254) says deprecation began **2026-09-17** and retirement is **2027-04-17**. Deprecated images have reduced support guarantees. It is a short-term diagnostic/compatibility host, not the proposed long-term CI baseline. Its actual capability probe now completed as recorded above; native-GUI acceptance still needs the separate execution result.

Workflow changes belong to the coordinating task. Suggested wiring: capture probe JSON and exit status in a distinct step, publish that evidence even on failure, and require the GUI job's successful execution for any native-GUI acceptance claim. If the Ubuntu 24.04 job is intentionally limited to source/package validation, name and summarize it accordingly; the final release gate must still list its native-GUI result as blocked. Do not use `continue-on-error` to report an unrun GUI as passed. The independent probe contract test should be invoked explicitly, since adding a file does not add it to the repository's explicit source-test list.

## Installation and approval boundary

The installed `app-builder-lib` **26.15.3** templates were read, not executed. `templates/linux/after-install.tpl` may change `chrome-sandbox` to mode 4755 or 0755, copy a profile into `/etc/apparmor.d`, and load it with `apparmor_parser`. Its `apparmor-profile.tpl` grants `userns` to a fixed `/opt/...` executable path. Consequently a normal package installation can still have security-setting side effects. Selecting an existing test host is different from changing those settings. Creating/loading a profile, changing setuid ownership/mode, or modifying namespace sysctls requires explicit action-time approval and scoped review; ordinary permission to build/test does not cover it.

[Chromium's official AppArmor guidance](https://github.com/chromium/chromium/blob/main/docs/security/apparmor-userns-restrictions.md) also describes using an already installed Google Chrome SUID helper via `CHROME_DEVEL_SANDBOX`. That avoids newly installing a helper, but uses the older sandbox route. [Its SUID documentation](https://github.com/chromium/chromium/blob/main/docs/linux/suid_sandbox_development.md) warns about helper API-version mismatches and says the page is mostly outdated. No claim of equivalent protection or compatibility is made here. The actual `0777` helper observations above do not satisfy a safely provisioned SUID-helper prerequisite, so they provide no currently usable alternative. Any future separately provisioned helper would require review of installed provenance, ownership, path integrity, supported API compatibility and renderer sandbox evidence. The current harness intentionally does not forward this environment variable. Do not rename/copy Hipi to an allowlisted Chrome path, borrow an exception by impersonating another application, or change the environment silently.

Longer-term Ubuntu 24.04 validation needs a legitimately provisioned and reviewed host or package installation with narrowly scoped, approved security prerequisites. Until then, native GUI acceptance remains blocked. Nothing in this document authorizes disabling the sandbox, changing global host security, running as root, or installing a privileged helper.

## Ubuntu 24.04 production packaging decision

Reviewed 2026-10-20. **There is no validated, currently implemented production packaging route for Ubuntu 24.04 in this checkout.** Keep the Ubuntu 24.04 gate open. Its replacement by Ubuntu 22.04, a skipped GUI check or an unsandboxed launch is not acceptable.

### Latest evidence and existing experiments

[Run 39344683953](https://github.com/FrankCDev/Hipi/actions/runs/39344683953) again exited before renderer readiness on Ubuntu 24.04, kernel `6.17.0-1022-azure`, Electron `42.11.15`. The native log records the same SUID-helper fatal error; the report contains zero completed checks. Its source snapshot is `b6d82fc1acee6b5fd0e9b160189cb632867d60faa9a44eb51983269a17032656`, binary SHA-256 is `61c2cd6c2584c3db608526071f668012183a8b4d45ea790ce3a5381c49043778`, and ASAR SHA-256 is `d5754294652add5448cf8d402b00105ced9b806e8179e5f33dd5835796b7e228`. This is failed native startup evidence, not an isolated AppArmor root-cause proof.

The earlier Debian safety experiment was reviewed rather than installed or rebuilt. Its artifacts contain only an inert executable and mock-tested hooks, not a real Hipi package. The final recorded result has 12 mocked lifecycle checks plus three rejected archive mutations. Later safety corrections explicitly refuse removal/purge: executable-only process scans miss inherited profile contexts, and `postrm` cannot protect a conffile that dpkg has already removed. Those fixtures are not production packaging, native parser verification, installation acceptance or a reviewed rollback plan. Do not promote them into CI installation steps.

### Selected engineering direction, not installation approval

The closest route to the current Electron application is a separately reviewed **fixed-path Ubuntu package with application-specific namespace policy**, while retaining fail-closed portable archives for hosts with working namespace support. Ubuntu documents this app-specific policy mechanism in its [24.04 release notes](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions). This preserves the system-wide restriction and the Chromium sandbox; it still changes host security and is not a zero-permission code fix.

Before a production candidate can be installed, resolve these concrete questions:

1. **Execution scope:** would `org.hipi.work` grant `userns` only to the literal `/opt/Hipi Work/hipi-work` attachment path, with no wildcard, foreign application identity or alternate writable path? Treat the resulting exception as permission for that execution context and inherited contexts, not a guarantee that only Hipi business code can use it. Verify the real installed path, every ancestor's ownership/mode and actual process labels.
2. **Interpreter scope:** read-only inspection of the exact binary above with locked `@electron/fuses` 1.8.0 confirms `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` are enabled. Current offline maintenance intentionally uses Electron's Node mode. A hardened production proposal should preserve maintenance through a separately validated Node CLI outside the policy attachment while disabling these unnecessary GUI entry points. Do not silently remove maintenance or flip fuses in the current package: first verify runtime/worker behavior, CLI delivery, offline recovery and compatibility. Electron documents the consequences in its [fuse reference](https://www.electronjs.org/docs/latest/tutorial/fuses).
3. **Package lifecycle:** what happens on install retry, upgrade, interrupted configuration, removal, purge, modified administrator policy and reboot? Use reviewed Debian package-manager semantics, not the builder's default helper chmod/profile-copy hooks or the deliberately incomplete fixture. [Debian policy](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html) requires maintainer-script idempotency and defines the failure transitions. Ubuntu's [dh_apparmor helper](https://manpages.ubuntu.com/manpages/noble/man1/dh_apparmor.1.html) is a starting point to inspect, not proof of Hipi lifecycle safety or permission to reload policy. Specify and validate retained live-policy behavior rather than assuming a successful file removal unloads it.
4. **Artifact and host binding:** which actual package SHA-256, source snapshot, version, payload/control-script manifest and dependency versions will be tested on which disposable Ubuntu 24.04 host? No placeholder identity, synthetic fixture or unbounded dependency repair belongs in the approval. Audit actual archive paths, modes, owners, duplicate entries and bytes; reject unsafe input rather than repairing an installed helper.
5. **Installed acceptance:** launch the installed executable at its reviewed attachment path as the ordinary user, using temporary user data only. The present GUI harness relocates the binary and therefore cannot prove a fixed-path policy works. An installed-mode harness must never copy, chmod or delete the installation; it must verify policy attachment and sandbox runtime evidence, exercise the substantive GUI/restart flow and confirm owned-process cleanup. Installation, update and recovery tests remain separate gates.

The subsequent live action needs exact action-time approval for that identified host, package, dependency transaction, policy creation/load and specifically reviewed cleanup or disposable-host destruction. There is no pending installation attempt and no actual installable candidate approved by this review. No AppArmor command, privileged helper operation or host setting change was executed.

### Why another package format is not an immediate bypass

- **Snap:** Canonical's [browser-support contract](https://snapcraft.io/docs/reference/interfaces/browser-support-interface/) says preserving the browser sandbox requires `allow-sandbox: true`, privileged policy rules and trusted-publisher review; it does not auto-connect. Its alternative Electron advice disables the internal sandbox, which does not meet Hipi's requirement. A Snap target would need its own confinement/integration review, not merely a new archive extension.
- **Flatpak:** the [official Electron guide](https://docs.flatpak.org/en/latest/electron.html) uses an Electron BaseApp, a runtime and `zypak-wrapper`. This is a separate runtime/sandbox integration with new permission, file-portal, keychain and update acceptance work. It may be evaluated independently, but no such integration is present or verified here. It cannot be claimed as evidence that the existing AppImage or fixed-path package passes.

### Safe packaging checks completed

The portable Linux post-pack check now requires the main binary, sandbox helper and crashpad handler to be regular mode-0755 files; it does not repair them. The final AppImage check separately enforces root archive ownership, exact mode, one entry and unambiguous relevant metadata for these files. The already-listed launcher test covers special-mode metadata without creating any privileged executable, writable modes, missing files, links, directories, duplicate entries/fields and unchanged rejected file mode.

Six focused launcher/metadata tests passed on the Debian workspace. Read-only inspection of the existing AppImage SHA-256 `a53b134a1868329dfb7c037c07efdddb0f05e4da4c2fcd7907d333c5d0525e80` and its unpacked native executable modes passed the new checks. These are packaging metadata results only, not a new build or GUI/Ubuntu 24.04 acceptance. Subsequent source changes require fresh release provenance and native results.
