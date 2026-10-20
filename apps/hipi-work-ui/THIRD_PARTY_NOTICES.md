# Third-party notices

## shadcn/ui source components

The shared components in `src/components/ui/` adapt official shadcn/ui registry output. Sources: https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/new-york-v4/ui and https://ui.shadcn.com/docs/components. Local adaptations are described in [vendor/shadcn/README.md](vendor/shadcn/README.md). The application-owned `icon.tsx` vocabulary is separate.

shadcn/ui is MIT-licensed:

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## npm dependencies

`package.json` and the root lockfile record npm dependencies. Original license files remain in the installed packages. Desktop staging collects LICENSE/NOTICE files for packages actually retained by the bundlers into `licenses/`, with their locations recorded in `dependency-licenses.json`. Packages that publish a complete license in their README use that notice. No second dependency license tree or installed-closure inventory is maintained in the source repository.

## PDF preview resources

PDF.js supplies the local PDF renderer, worker, CMaps and standard-font assets. The required PDF.js, Adobe CMap, Foxit/PDFium and Liberation notices are retained in [vendor/pdfjs](vendor/pdfjs/README.md) and shipped in `dist/third-party/pdfjs/`.

## Offline Chinese font fallback

Noto Sans SC is bundled as a complete variable WOFF2 under SIL Open Font License 1.1. Copyright 2014–2021 Adobe; Reserved Font Name: Source. The original OFL notice and source/conversion manifest are retained in [vendor/fonts](vendor/fonts/README.md) and shipped in `dist/third-party/fonts/`. No font CDN is used.
