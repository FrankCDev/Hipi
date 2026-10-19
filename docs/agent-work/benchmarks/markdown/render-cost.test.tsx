import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { renderToStaticMarkup } from 'react-dom/server';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { VFile } from 'vfile';
import { test } from 'vitest';
import { PreferencesProvider } from '@benchmark-ui/app/preferences.tsx';
import { MessageMarkdown } from '@benchmark-ui/features/workbench/message-markdown.tsx';
import { markdownDisplaySource } from '@benchmark-ui/features/workbench/markdown-policy.ts';

const root = process.env.HIPI_REPO_ROOT;
if (!root) throw new Error('HIPI_REPO_ROOT must identify the checkout');
const outputDirectory = process.env.BENCHMARK_OUTPUT_DIR ?? import.meta.dirname;
const paths = [
  'apps/hipi-work-ui/src/features/workbench/message-markdown.tsx',
  'apps/hipi-work-ui/src/features/workbench/markdown-policy.ts',
  'apps/hipi-work-ui/src/app/preferences.tsx',
  'package-lock.json',
];
const hashes = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const prose = '# Implementation summary\n\nThis response explains **bounded rendering**, with 中文 and `inline code`.\n\n- Read the source\n- [x] Validate behavior\n- [ ] Review output\n\n| Stage | Result |\n| --- | --- |\n| Parse | Ready |\n| Render | Safe |\n\n```ts\nconst result = { stable: true };\n```\n\n[Documentation](https://example.com/docs)\n\n';
function fill(pattern: string, length: number) {
  return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}
function measure(action: () => void, warmCount: number) {
  const start = performance.now();
  action();
  const firstMs = performance.now() - start;
  const warmMs: number[] = [];
  for (let index = 0; index < warmCount; index++) {
    const start = performance.now();
    action();
    warmMs.push(performance.now() - start);
  }
  const sorted = [...warmMs].sort((a, b) => a - b);
  return { firstMs, warmMs, warmP50Ms: sorted[Math.floor(sorted.length / 2)], warmMinMs: sorted[0], warmMaxMs: sorted.at(-1) };
}
function render(source: string, streaming: boolean) {
  return renderToStaticMarkup(<PreferencesProvider><MessageMarkdown source={source} streaming={streaming} /></PreferencesProvider>);
}
function save(name: string, records: unknown[]) {
  writeFileSync(join(outputDirectory, name), JSON.stringify({ hashes, prose, node: process.version, platform: process.platform, arch: process.arch, records }, null, 2));
}

test('bounded renderer cases', () => {
  if (process.env.BENCHMARK_MODE === 'sizes') return;
  const cases = [
    { name: 'realistic-8Ki', source: fill(prose, 8192), streaming: false },
    { name: 'realistic-32Ki', source: fill(prose, 32768), streaming: false },
    { name: 'realistic-streaming-32Ki', source: fill(prose, 32768), streaming: true },
    { name: 'delimiter-run-32Ki', source: '*'.repeat(32768), streaming: false },
    { name: 'unmatched-brackets-32Ki', source: '['.repeat(32768), streaming: true },
    { name: 'nested-quotes-depth512-32Ki', source: '> '.repeat(512) + 'x'.repeat(32768 - 1024), streaming: false },
    { name: 'mixed-delimiters-32Ki', source: fill('*a _b **c __d ~e ~~f [g `h ', 32768), streaming: true },
    { name: 'above-ceiling-32769', source: fill(prose, 32769), streaming: true },
    { name: 'fallback-1Mi', source: fill(prose, 1048576), streaming: true },
  ];
  const records: unknown[] = [];
  for (const item of cases) {
    if (process.env.MARKDOWN_CASE && item.name !== process.env.MARKDOWN_CASE) continue;
    const durations: number[] = [];
    let html = '';
    let error: string | undefined;
    for (let index = 0; index < 4; index++) {
      const start = performance.now();
      try { html = render(item.source, item.streaming); }
      catch (caught) { error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught); }
      durations.push(performance.now() - start);
      if (error) break;
    }
    records.push({ name: item.name, streaming: item.streaming, inputUtf16Units: item.source.length, inputBytes: Buffer.byteLength(item.source), inputSha256: createHash('sha256').update(item.source).digest('hex'), outputUtf16Units: html.length, outputBytes: Buffer.byteLength(html), hasRichBody: html.includes('markdown-body'), firstMs: durations[0], warmMs: durations.slice(1), error, cumulativeProcessMaxRssKiB: process.resourceUsage().maxRSS });
    save(`rerun-cases${process.env.MARKDOWN_CASE ? '-' + process.env.MARKDOWN_CASE : ''}.json`, records);
  }
});

test('bounded size ladder', () => {
  if (process.env.BENCHMARK_MODE !== 'sizes') return;
  const records: unknown[] = [];
  for (const size of [2048, 4096, 8192, 16384, 32768]) {
    const source = fill(prose, size);
    let repaired = source;
    let repair: ReturnType<typeof measure> | { status: 'policy-rejected'; error: string };
    let parseSource: 'repaired-display-source' | 'raw-source-policy-rejected' = 'repaired-display-source';
    try {
      repair = measure(() => { repaired = markdownDisplaySource(source, true); }, 5);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Rich display ceiling exceeded') throw error;
      repair = { status: 'policy-rejected', error: error.message };
      parseSource = 'raw-source-policy-rejected';
      repaired = source;
    }
    const parse = measure(() => {
      const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true });
      const file = new VFile({ value: repaired });
      processor.runSync(processor.parse(file), file);
    }, 5);
    let html = '';
    const ssr = measure(() => { html = render(source, true); }, 5);
    records.push({ inputUtf16Units: size, inputBytes: Buffer.byteLength(source), inputSha256: createHash('sha256').update(source).digest('hex'), repair, parseSource, parse, ssr, hasRichBody: html.includes('markdown-body'), outputUtf16Units: html.length, outputBytes: Buffer.byteLength(html), cumulativeProcessMaxRssKiB: process.resourceUsage().maxRSS });
    save('rerun-sizes.json', records);
  }
});
