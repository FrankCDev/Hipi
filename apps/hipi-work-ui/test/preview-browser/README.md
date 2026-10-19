# Isolated preview acceptance

This fixture uses synthetic in-memory preview/file ports and generated PDF/PNG bytes. It exercises the production preview session, native PDF.js worker, local asset factory and React viewers. It does not access a runtime, user files, external preview sites, credentials or paid models.

From the UI package, with already provisioned tools:

```sh
HIPI_PLAYWRIGHT_PATH=/absolute/path/to/playwright \
HIPI_CHROMIUM_PATH=/absolute/path/to/chromium \
HIPI_EVIDENCE_DIR=/absolute/path/to/evidence \
node scripts/verify-preview-browser.mjs
```

The script requires the Chromium sandbox. It checks a native worker event, one live worker, painted canvases, bundled standard-font and predefined Chinese CMap requests, page/zoom controls, ignored PDF JavaScript and link annotations, worker termination on switching, image object-URL/handle cleanup on close and decode failure, and authorization-refresh cleanup. `cjk-preview.png` must be inspected for correct glyphs: nonblank pixels alone do not prove correct Chinese rendering. The Chinese page intentionally uses an unembedded STSong font with `UniGB-UCS2-H`; substitution depends on platform fonts.

On 2026-10-19, the sandboxed browser launch was blocked by `socket() failed: Operation not permitted`, before any assertion or screenshot. No fake-worker or sandbox-disabled substitute was used. `--transform-only` passed all five Vite source transforms, and the fixture TypeScript check passed; neither result is browser acceptance. The JSON evidence explicitly distinguishes BLOCKED, FAIL, PASS and TRANSFORM_ONLY_BROWSER_NOT_RUN.

Unit/SSR tests `preview-session.test.ts`, `preview-client.test.ts`, `document-preview.test.tsx` and `file-workbench.test.tsx` cover cancellation, stale replies, resource bounds, strict target construction, escaped document/grid output, and the decoded hashes of all 182 inline resources. These do not replace native lifecycle/layout, real transport authorization, or Windows/macOS/Linux desktop acceptance.
