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
