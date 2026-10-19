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

- @codemirror/state 6.5.2, @codemirror/view 6.38.6, @codemirror/commands 6.8.1 and @codemirror/merge 6.11.1, MIT, https://codemirror.net/ — editor state, view, commands and explicit-baseline comparison. These are used directly, without a React wrapper or copied editor implementation.
- Installation used `--ignore-scripts`; the lockfile added 13 MIT packages, with no existing resolved version changes or new install lifecycle scripts. The dependency packages' development `prepare` commands were not executed.
- All resolved versions and integrity hashes are in the root lockfile. Original license files remain with the installed packages; distribution must preserve these notices. This dependency review does not establish native IME, accessibility, browser performance or three-platform acceptance.

CodeMirror is MIT-licensed, Copyright (C) 2018–2022 by Marijn Haverbeke and others. The permission and warranty terms of the MIT license reproduced below apply; individual package copyright years are retained in their original LICENSE files.

MIT License

Copyright (c) 2021-present Tanner Linsley

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
