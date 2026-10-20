# Packaged long-history GUI acceptance

This separate scenario exercises the actual packaged Electron window against 200 deterministic persisted messages. It supplements [the baseline native smoke](DESKTOP-GUI-SMOKE.md) and does not establish [full RC acceptance](RC-TRACKER.md).

## Run

After rebuilding and packaging the complete current source snapshot on the target OS and architecture:

```sh
node --conditions=source apps/hipi-work-desktop/scripts/smoke-packaged-long-history.mjs
```

The native-session, sandbox, package provenance, private profile, process ownership, deadline, diagnostic redaction and cleanup requirements are the same as the baseline. No directory arguments, sandbox overrides, external credentials or model services are accepted. The baseline scenario is unchanged and retains its own profile and evidence directory.

## Fixture boundary

Before launching the package, the source-only helper creates 100 turns through public runtime commands using an explicit faux provider. It also creates a separate two-message control conversation. No SQL rows, Durable entries, renderer bridge methods or application storage are written directly.

Every fourth assistant message contains actual multiline Markdown with a table, code block, quote and nested list. One bounded original is longer than the public 2048-unit preview and shorter than a full-text page. Its suffix lies outside the preview. The seed writer closes, a new runtime cold-reads all seven history pages and the full original, and that reader closes before native launch. The exported report contains identifiers, counts and content digests, not directory paths. The fixture's elapsed time and sampled Node RSS are source-fixture observations, not native GUI memory measurements or product performance limits.

The 200 seed messages are not represented as manually entered GUI messages. Exactly one additional probe is entered through native Chromium input on the first launch. It uses the package's existing deterministic response and streaming rate without overrides. The second launch performs only read/navigation/expansion actions and never submits the probe again.

## Required native behavior

Both launches select the exact seeded workspace and conversation through visible navigation. Conversation details must confirm both scope IDs before history actions.

1. The latest seeded tail is visible and the mounted row count is below 200.
2. Native wheel events approach and cross the 240px history-load boundary. A bounded passive observer records the same message key before and after prepend. Its index must increase. Its settled viewport-relative Y must stay within 4px of the last observed post-wheel, pre-prepend baseline. A requested wheel delta is not treated as observed movement. Missing baseline evidence is `notvalidated`, never a pass.
3. Further native wheel traversal reaches the first seeded user message. Its adjacent rich assistant message must have actual table, code and quote DOM. Mounted-row and distinct-visible-key observations are recorded without asserting that all 200 rows were mounted or individually viewed.
4. The long original is expanded and collapsed through an actually visible, hit-tested button. Full text, including the suffix beyond the preview, must match exactly. The same row's height must increase and return, while its top remains anchored within 4px. No forced click or direct scroll-offset assignment is used.
5. On the first launch, the probe must visibly enter the global running state. After a native wheel event leaves the bottom, the Jump to latest control and distance greater than 64px must be observed. With no further input, the same reading anchor must remain stable until known execution completion. At least three distinct nonempty partial texts must be observed while the actual global model controls say Running. Labels, missing virtual rows, duplicate samples and completed text do not count. The result must subsequently be confirmed in conversation details.
6. Switching to the control conversation must show exactly its two expected messages, with no long-history content. Returning must show the exact persisted probe IDs and fixed answer. The second launch must show those same IDs and text, repeat prepend/oldest/expansion checks, and preserve scope isolation without another submission.
7. After both native process trees and debugging listeners have exited, a public cold reader verifies all original seed IDs and preview digests, the exact full original, exactly 202 long-history messages, one probe, its completed receipt and answer, and the unchanged two control messages. It closes before profile cleanup.

The 4px tolerance is a layout-position assertion, not a performance budget. A fast stream with too few real samples remains failed/not validated; the harness must not slow the product response, synthesize partial text or lower the requirement to manufacture a pass.

## Evidence and current status

Output is under `.artifacts/hipi-work/packages/gui-long-history/`: `packaged-long-history.json`, first/reopened prepend, oldest, expansion and isolation screenshots, plus bounded native logs. Successful intermediate observations are retained even if a later gate fails. Screenshots require visual inspection. Original-text expansion does not establish physical text selection, IME, clipboard, accessibility or all long-session resource behavior.

Source verification on 2026-10-20 passed 11 focused helper/fixture tests and 21 existing flow/process tests. The fixture test genuinely seeded/cold-read 200 messages and exercised the cold verifier with source-only probe, corruption and duplicate cases. These are source/model tests, not native GUI evidence. The local execution workspace has no Xvfb executable, so this scenario has not been run locally.

The first [native CI run](https://github.com/FrankCDev/Hipi/actions/runs/39347936483), source `147d543e125215395ef1f2af7cc5847c352776b5`, failed on macOS ARM64, macOS Intel and Ubuntu 22.04 at `global Running and true GUI partial`. Verified artifacts show identical successful prepend geometry (Y=598), oldest traversal (170 distinct visible keys), and exact original expansion/collapse with stable row anchors. macOS measured row height 620.484375 → 2633.515625 at Y=-300; Ubuntu measured 669.484375 → 2682.515625 at Y=-277. All three report no renderer errors. The inspected macOS ARM64 failure screenshot shows the probe completed with the unchanged deterministic answer. These are partial native findings, not complete scenario passes: stream-away behavior, second launch and final cold verification were not reached.

Source diagnosis found that global model controls only refreshed every 2000ms, with no refresh on live execution transitions. A short execution could finish before a refresh and never expose Running/Cancel. The repair invalidates the exact model-status query on connected authoritative running/terminal transitions and reconnection. It still reads the runtime's full execution state rather than deriving readiness from partial text or optimistic UI. Focused production-effect/real-query tests cover immediate transitions, no per-token refetch storm, stale-read cancellation and scope isolation. Native validation of this repair remains pending; the fixed response/rate and three-sample requirement are unchanged. Bounded passive start diagnostics now distinguish missing global status from missing partial text if the native condition fails again.

Verified first-run artifact ZIP digests:

- macOS ARM64, artifact 12231802728: `93508ed58dba1bca5b4a9ab0823e910b1ae33ab3130eb36a595bc8c2f842afe0`.
- macOS Intel, artifact 12231364626: `a260c8e07745e6881472bd00434958e4242fc64ab0df528eb093c5248d222a13`.
- Ubuntu 22.04, artifact 12232490975: `d90c5e6a1f8b2caa6323187ec4d8c3892370bf9c37a32e945de428c5efb1d5e1`.

```sh
node --conditions=source --test \
  apps/hipi-work-desktop/scripts/gui-long-history.test.mjs \
  apps/hipi-work-desktop/scripts/gui-long-history-fixture.test.mjs \
  apps/hipi-work-desktop/scripts/gui-flow.test.mjs \
  apps/hipi-work-desktop/scripts/gui-process.test.mjs
```
