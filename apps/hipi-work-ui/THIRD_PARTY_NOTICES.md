# UI source attribution

The generated shared components in `src/components/ui/`, including `input-group.tsx`, adapt official shadcn/ui registry output to this application's semantic tokens and required controls. Untouched generated originals, hashes, CLI logs and concentrated adaptations are recorded in [vendor/shadcn/README.md](vendor/shadcn/README.md). The owned `icon.tsx` vocabulary is separate. Official sources: https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/new-york-v4/ui and https://ui.shadcn.com/docs/components/radix/input-group.

shadcn/ui is MIT-licensed:

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Pinned registry packages retain their own upstream license notices in the dependency tree. The UI does not load remote fonts, icons, scripts or preview services.

## PDF preview resources

PDF.js (`pdfjs-dist` 6.4.299, Apache-2.0, https://mozilla.github.io/pdf.js/) supplies the canvas renderer and separately emitted local worker. The application also statically bundles its 168 CMaps and 14 standard-font assets. Their Adobe, Foxit/PDFium and Liberation notices, original PDF.js license, and exact resource inventory are in [vendor/pdfjs](vendor/pdfjs/README.md) and must accompany distributions. No CMap, font, ICC or WASM URL is taken from document content; no remote font or preview service is used.

## Markdown dependencies

- react-markdown 10.1.0, MIT, https://github.com/remarkjs/react-markdown — React rendering of a parsed Markdown tree.
- remark-gfm 4.0.1, MIT, https://github.com/remarkjs/remark-gfm — GitHub-flavored Markdown parsing.
- remend 1.4.0, Apache-2.0, https://github.com/vercel/streamdown/tree/main/packages/remend — transient incomplete-Markdown repair. The Streamdown component and its default caches/plugins are not used.

Their original license files and transitive dependency notices remain in the installed packages. Direct versions and resolved integrity hashes are recorded in package-lock.json. No upstream implementation source was copied into the application. There is no remote font, highlighting, math, image or preview service dependency.

## Virtual message list dependencies

- @tanstack/react-virtual 3.14.21, MIT, https://github.com/TanStack/virtual/tree/main/packages/react-virtual — React integration for the message viewport.
- @tanstack/virtual-core 3.19.6, MIT, https://github.com/TanStack/virtual/tree/main/packages/virtual-core — its sole runtime dependency, providing dynamic measurement and end anchoring.

Both packages retain their original license files in the installed dependency tree. No implementation from the user's reference application assets was copied into this UI.

## File editor dependencies

- @codemirror/state 6.5.2, @codemirror/view 6.38.6 and @codemirror/commands 6.8.1, MIT, https://codemirror.net/ — Markdown editor state, view and commands. These are used directly, without a React wrapper or copied editor implementation. The former MergeView dependency was replaced by the public Pierre comparison renderer.
- @codemirror/lang-markdown 6.5.2, @codemirror/language 6.13.1 and @lezer/highlight 1.2.5, MIT, https://codemirror.net/ — local Markdown parsing, semantic syntax highlighting and language-aware editing. Original notices and exact installed-closure inventory are retained in [vendor/codemirror](vendor/codemirror/README.md) and must accompany distributions under `third-party/codemirror`. No grammar network loader or remote preview is configured.
- The initial CodeMirror installation used `--ignore-scripts` and added 13 MIT packages, with no existing resolved version changes or new install lifecycle scripts at that stage. The dependency packages' development `prepare` commands were not executed.
- All resolved versions and integrity hashes are in the root lockfile. Original license files remain with the installed packages; distribution must preserve these notices. This dependency review does not establish native IME, accessibility, browser performance or three-platform acceptance.

CodeMirror is MIT-licensed, Copyright (C) 2018–2022 by Marijn Haverbeke and others. The permission and warranty terms of the MIT license reproduced below apply; individual package copyright years are retained in their original LICENSE files.

## Pierre and syntax highlighting

- @pierre/diffs 1.5.2 and @pierre/trees 1.0.0-beta.6, Apache-2.0, Copyright 2025 Pierre Computer Company, https://github.com/pierrecomputer/pierre — ordinary text/code editor, read-only comparison and virtualized file tree.
- shiki 4.5.0, MIT, Copyright 2021 Pine Wu and 2023 Anthony Fu, https://github.com/shikijs/shiki — bundled syntax tokenization using the JavaScript regular-expression engine.
- Original licenses and notices for the installed dependency closure, including Pierre's Primer theme notice, are retained in [vendor/pierre](vendor/pierre/README.md). The hash inventory identifies each source. All installs used `--ignore-scripts`; no installation lifecycle scripts were run.
- Application-owned adapters preserve runtime file authority, compare-and-save revisions, input bounds and recovery. The reference application's private implementation and assets are not included. Its exact bundled dependency versions are unknown.

Distributions must include `third-party/pierre` with these notices. File rendering uses bundled finite grammars and a semantic CSS-variable theme, not a remote highlighting service. Selecting the same library does not establish native IME, accessibility or performance acceptance.

MIT License

Copyright (c) 2021-present Tanner Linsley

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Offline Chinese font fallback

Noto Sans SC, upstream Google Fonts commit a85815a42757630ce188fdad368c2dfc444d4773, is bundled as a complete (not glyph-subsetted) variable WOFF2 under SIL Open Font License 1.1. Copyright 2014–2021 Adobe; Reserved Font Name: Source. Its original OFL notice and source/conversion/hash/coverage manifest are shipped in `dist/third-party/fonts/`. Conversion preserves all 30,890 upstream cmap codepoints; this is not coverage of all Unicode. The CSS fallback only matches CJK/punctuation and preserves the selected Latin font. DOM previews inherit it; PDF canvas font coverage depends on the document and PDF renderer. No font CDN or remote font request is used.
