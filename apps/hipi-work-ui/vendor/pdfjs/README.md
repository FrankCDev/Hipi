# Bundled PDF resources

`pdfjs-dist` is pinned to 6.4.299. [asset-inventory.json](asset-inventory.json) records the 168 CMaps and 14 standard-font files, their exact byte sizes and SHA-256 hashes. The source manifest is [pdf-assets.generated.ts](../../src/features/files/pdf-assets.generated.ts); regenerate it with `node scripts/generate-pdf-assets.mjs` after reviewing an upgrade, then run the UI formatter and tests.

Every asset uses an explicit static `?url&inline` import. `LocalPdfData` accepts only known resource kinds and exact manifest filenames, then decodes the bundled base64 into bounded bytes. It never fetches a URL. Unknown resources, traversal, prototype keys, ICC and WASM requests fail closed. The desktop can retain `connect-src 'none'`. Resource data is 1,940,006 bytes before base64 (approximately 2.59 MB encoded, plus module overhead); this currently increases the initial renderer bundle. Moving these fixed resources into a static worker module is a future performance evaluation, not an implemented optimization.

Keep all four license files and the inventory with distributions that contain these resources:

- [PDF.js Apache-2.0 license](LICENSE_PDFJS)
- [Adobe CMap notice](LICENSE_CMAPS)
- [Foxit/PDFium font notice](LICENSE_FOXIT)
- [Liberation font license](LICENSE_LIBERATION)

The local resources improve font/CMap availability; they do not establish exact Office/PDF fidelity or provide every font used by arbitrary documents. Unembedded CJK fonts may still use installed platform glyphs. Browser glyph rendering and platform availability require real browser/desktop verification.
