# Bounded Markdown SSR observations

This is a developer measurement artifact, not a production benchmark gate. It renders the checkout's real `MessageMarkdown` and `PreferencesProvider` using React static SSR. It does **not** measure browser layout, painting, input responsiveness, selection, scrolling, streaming scheduling, or Electron behavior.

## Run without installs or a production build

Requires the checkout's existing dependencies, Bash, Node, and GNU `timeout`. From the repository root:

```sh
bash docs/agent-work/benchmarks/markdown/run.sh "$PWD" cases
bash docs/agent-work/benchmarks/markdown/run.sh "$PWD" sizes
# Separate processes make each selected case the first renderer invocation:
bash docs/agent-work/benchmarks/markdown/run.sh "$PWD" cases realistic-32Ki
bash docs/agent-work/benchmarks/markdown/run.sh "$PWD" cases realistic-streaming-32Ki
```

The script creates and removes a local `node_modules` symlink only if one is absent. No dependency installation occurs. Set `BENCHMARK_OUTPUT_DIR` to an existing or new output directory to keep generated JSON elsewhere. Original measurement JSON remains unchanged; new outputs begin `rerun-`.

This harness is test-only. It imports the installed `unified` 11.0.5, `remark-parse` 11.0.0, `remark-rehype` 11.1.2, and `vfile` 6.0.3 transitives used by the exact current lockfile, plus the existing React/GFM/Vitest dependencies. It does not add production dependencies or use an independent parser version. Recheck the harness chain if react-markdown or its lockfile changes.

One Vitest worker, sequential cases, 768MiB V8 old-space ceiling, 60-second test timeout, and 90-second outer wall timeout with a five-second kill grace bound each invocation. The old-space ceiling is **not** a process RSS limit. The outer timeout matters because synchronous parsing can prevent a JavaScript timeout from firing. Original isolated cold runs used a 45-second outer timeout; original all-case and ladder runs used 90 seconds.

## Workload and methodology

`render-cost.test.tsx` contains the exact original prose and generation rules. Realistic sources repeat a fixed Markdown block containing a heading, English/Chinese prose, bold/code, list/task entries, a GFM table, fenced TypeScript and an inert HTTP link, then truncate to the requested UTF-16 length. Exact text is also saved in `size-results.json.txt` and future output files. No network resource is fetched.

Cases cover realistic 8Ki and 32Ki, streaming 32Ki, 32Ki asterisk and unmatched-bracket runs, 512 nested blockquotes padded to 32Ki, repeated mixed delimiters, a 32,769-unit over-ceiling source, and a 1Mi-unit fallback source. Each has one first and three subsequent SSR observations. Errors are recorded and end that case's repeats. Vitest completion alone is **not** a no-errors assertion: inspect each JSON `error` field.

The size ladder measures 2/4/8/16/32Ki with one first and five subsequent samples per operation:

1. Streaming repair via the actual `markdownDisplaySource`. When the current policy rejects a size, record `repair.status = policy-rejected` and the rejection; do not override the product ceiling.
2. Fresh unified processor construction + remark-parse + remark-gfm + remark-rehype, matching react-markdown's parser/conversion chain. This excludes repair, React conversion, SSR, and module loading; it includes Markdown parsing and Markdown-AST to HTML-AST conversion.
3. Full real-component streaming SSR, including its real policy fallback, with `hasRichBody` identifying whether rich rendering occurred.

Policy changed after the original measurements: streaming rich text now has a provisional 2Ki ceiling. For rejected sizes, the standalone parser measurement uses the unchanged raw source and is explicitly labeled `parseSource = raw-source-policy-rejected`. It is an isolated parser-cost experiment, **not** a parser path exercised by the current streaming UI. Allowed input is labeled `repaired-display-source`. Current full SSR at 4/8/16/32Ki measures the original-text fallback; never compare it to the historical rich SSR as if they rendered the same structure.

Timing uses `performance.now()`. Imports finish before timers start. The ladder runs in increasing size order, so only the first parser invocation is process-cold, and SSR benefits from previous parser runs. First-per-shape timing must not be labeled process-cold. Separate selected-case invocations establish first-render timings in fresh processes, still excluding imports/startup.

No forced GC, randomization, machine isolation or production React build was used. Samples are few: report observed median/min/max only, not p99 or throughput promises. Different phases have independent samples; their times cannot be subtracted to obtain an exact React-only cost. MaxRSS is the worker's cumulative Linux process high-water mark, including Vitest, imports, caches and retained heap; it is not incremental per-render memory or combined parent/child memory.

## Original observed findings

Environment: Node 24.19.0, React 19.3.1, Vitest 4.1.11, react-markdown 10.1.0, remark-gfm 4.0.1, remend 1.4.0; Linux x86-64, AMD EPYC 9V74. These are shared-host observations, not a supported minimum-hardware claim.

Five-sample warmed median [min–max], milliseconds:

| Input UTF-16 units | Parse + GFM → HAST | Full streaming SSR | Output UTF-16 units |
| --- | --- | --- | --- |
| 2,048 | 9.44 [6.07–22.43] | 14.35 [13.18–15.54] | 7,175 |
| 4,096 | 14.57 [12.90–22.52] | 20.92 [17.92–22.66] | 14,248 |
| 8,192 | 27.65 [25.72–32.07] | 43.11 [37.60–46.16] | 28,307 |
| 16,384 | 51.00 [44.59–56.63] | 66.94 [48.39–82.47] | 56,334 |
| 32,768 | 107.96 [92.33–121.89] | 134.16 [113.21–140.03] | 97,019 |

Repair medians were 0.10–0.51ms. Fresh-process first SSR of realistic 32Ki was 294.7ms, or 248.5ms with streaming repair; each output was 99,299 UTF-8 bytes. This does not imply repair speeds rendering: they were separate small runs.

The unmatched-bracket case reached 168.9ms warmed. The over-ceiling and 1Mi fallbacks rendered in 0.19–0.38ms, each producing about 17.3K output units. All original cases completed without caught exceptions. The maximum observed cumulative worker maxRSS was 312,936KiB.

These results justify treating the original 32Ki rich ceiling as provisional, especially for continuous streaming. Lowering it is a mitigation, not proof of frame-safe work. Browser long-task/input/scrolling measurements and potentially off-main-thread parsing remain necessary. An 80ms refresh interval does not make a 100ms synchronous parse nonblocking.

## Evidence and source identity

Original outputs and logs are copied alongside this README:

Historical JSON and logs have an extra `.txt` extension so source archives retain them; their contents are unchanged.

- `results.json.txt`: all nine cases.
- `results-realistic-32Ki.json.txt`: isolated fresh-process realistic 32Ki.
- `results-realistic-streaming-32Ki.json.txt`: isolated fresh-process streaming 32Ki.
- `size-results.json.txt`: separated repair/parse/SSR size ladder.
- `run.log.txt`, `cold-realistic.log.txt`, `cold-streaming.log.txt`, `size-run.log.txt`: original Vitest output.

Every JSON includes exact input hashes and source hashes. Original tested SHA-256:

- `message-markdown.tsx`: `9a78efe416c3f90d91549f71dd1c9115f21570e07f5fc91eee8479bc1febf16a`
- `markdown-policy.ts`: `b5f25b27e279662560e9ef1b6e2056a9ffc721968f606e78468f914239de3c39`
- `package-lock.json`: `b98a041bd89bb16dd5379838cdb4e68853f859b855e0389e14f6c385f37fd6d3`
- Preferences original batch: `63b42de85a4aa0129b4912f805d86713691c4411596c85fff2f603a56cbbfc7f`
- Preferences ladder: `23317c3e9abbf7a387bd1e849ad0d0b8eef8532a815e6b1dc402a0851a3a41bd`

The UI worker changed preferences between batches. Renderer/policy hashes were checked unchanged at the end of the original runs. New measurements are evidence for the hashes they record, not automatic acceptance of the original or final product. Do not modify production ceilings solely to make this harness pass; it intentionally has no hard timing assertions.

## Reconstructed harness validation

The retained harness was smoke-tested with only `cases above-ceiling-32769`; see `harness-validation.log.txt` and `rerun-cases-above-ceiling-32769.json.txt`. The unselected size test returns without measurements. This run confirms path resolution, real component import, bounded execution and JSON output, not all original cases. Source had changed by this smoke test: renderer SHA `e1db8df2baf5d05a56ebdf56eeefb7d0cfa88f299a4674417c37b14979eb84d3`, policy SHA `4e896c855b80bc349637207259078c7931864ad940d6f524df8b2529572c018c`. Its fresh-process fallback was 12.18ms, with subsequent samples 0.46–0.73ms; do not replace the original warmed fallback data with this differently ordered run.

## Integrated harness validation with current policy

One `sizes` invocation completed after adding explicit policy-rejection handling. See `current-policy-sizes.json.txt` and `current-policy-sizes.log.txt`. At 2Ki the real renderer produced rich text; at 4/8/16/32Ki repair was explicitly rejected, standalone parsing used labeled raw source, and real SSR produced fallback (`hasRichBody: false`). No product limit was overridden.

Current SSR medians were 29.43ms at 2Ki, then 0.21/0.11/0.19/0.39ms for the larger fallback cases. The 32Ki first fallback observation was 24.14ms; its five warm observations ranged 0.33–0.52ms. The isolated raw-parser costs varied materially from historical results on this shared host; these runs are not a controlled before/after regression comparison. Source hashes match the reconstructed-harness smoke test above. This validation establishes the harness handles the changed policy and writes complete evidence, not final browser acceptance.
