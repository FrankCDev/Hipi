# Offline Noto Sans SC fallback

This directory vendors one complete upstream variable font, converted to WOFF2 without glyph subsetting. It is not a fixture-character subset and does not depend on fonts installed by CI or on a network CDN.

- Upstream: https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc
- Original TTF: 17,772,300 bytes. SHA-256 and exact immutable URL are in source-manifest.json.
- Conversion: existing offline fontTools 4.57.0 and Brotli 1.1.0; `TTFont(source, recalcTimestamp=False)`, set `flavor="woff2"`, save. No font names or glyph subsets were changed. Python is not an application, build or CI dependency.
- Converted WOFF2: 7,782,072 bytes. The exact cmap mapping before and after conversion is equal (30,890 codepoints). Basic Han U+4E00–U+9FFF coverage is 20,976/20,992; U+9FF0–U+9FFF are absent. The full observed coverage ranges are recorded; no claim covers all Unicode, every rare character, every shaping case, or all Chinese standards.
- Original OFL 1.1 notice is preserved verbatim. The reserved name is “Source”; the CSS-only family alias “Hipi Noto Sans SC” does not use it or imply upstream endorsement. Font data remains under OFL, independent of the application license.
- CSS matching is restricted to CJK and punctuation ranges. User-selected system/serif/mono fonts stay before this fallback; Latin is not matched by this font face. The full binary is retained. A future unicode-range shard scheme must preserve the complete supported cmap, rather than adopting incomplete CDN subsets.
- The renderer serves only the local WOFF2 with font/woff2 and font-src 'self'. Its name, bytes, hash, license and manifest are explicitly allowlisted in font-assets.mjs. Fontsource 5.3.1's smaller 101 shards were examined and rejected for this purpose because their effective cmap union was incomplete.
- DOM UI/editor/preview text inherits theme fonts. PDF canvas rendering still depends on document fonts and PDF.js support; this CSS fallback is not a PDF font repair feature.

The font payload and original OFL/source manifest must ship together. Real platform glyph selection and screenshots remain separate acceptance gates from hash and theme tests.
