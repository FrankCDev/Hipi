# Hipi Work product mark

Original repository-native vector artwork: two interlocking workspace panels form
an H, separated by an ascending diagonal opening. Broad stems remain readable at
16 px; the fixed blue accent follows the application's default brand palette.
This is not a font glyph, stock icon, or adaptation of another product's logo.
No external artwork, remote resources, fonts, or image-generation service is used.

## Source and derivatives

- `icon.svg`: canonical 256-unit geometry, transparent 16-unit outer margin.
- `png/`: RGBA renders at 16, 24, 32, 48, 64, 128, 256, 512, and 1024 px.
- `icon.ico`: seven PNG-backed entries, 16 through 256 px.
- `icon.icns`: seven PNG-backed entries, 16, 32, 64, 128, 256, 512, 1024 px.
- `asset-inventory.json`: explicit file names, byte sizes, and SHA-256 hashes.
- [BrandMark](../../hipi-work-ui/src/components/brand-mark.tsx): matching geometry
  for UI use, with semantic `--brand` / `--on-brand` colors. Decorative and
  unfocusable; place next to visible product text or inside a named control.

Source artwork and committed derivatives are intentional product assets and must
remain in source archives. They are not user-uploaded pictures or build output.
License: [MIT, repository license](../../../LICENSE). There are no third-party
artwork notices. This license does not assert trademark registration or clearance.

## Offline regeneration

From repository root:

```sh
python apps/hipi-work-desktop/scripts/generate-brand-icons.py
node apps/hipi-work-desktop/scripts/check-brand-icons.mjs
```

Generation uses already-installed Inkscape 1.4 and Pillow 12.3.0; it installs and
downloads nothing. Inkscape rasterizes the SVG independently at each size, then
Pillow normalizes to metadata-free RGBA PNG. Standard-library container writers
embed those exact PNG bytes in ICO and ICNS. Temporary rendering files and the
Inkscape profile are removed after generation. The same installed toolchain
produces byte-identical assets; different renderer/codec versions may change
antialiasing or compression and require reviewing and committing new inventory.

The Node verifier has no additional dependencies. It checks the inventory,
PNG dimensions and RGBA format, every ICO/ICNS representation against its source
PNG, complete container lengths, and UI path geometry against the source SVG.
It does not regenerate assets or claim native platform acceptance.

## Desktop integration contract

For the installed `electron-builder` 26.15.3 API:

- `mac.icon`: absolute path to `branding/icon.icns`.
- `win.icon`: absolute path to `branding/icon.ico`.
- `linux.icon`: absolute path to `branding/png` (size-named PNGs).
- Windows unsigned packaging must use `signExecutable: false`, while retaining
  executable resource editing. `signAndEditExecutable: false` also disables icon
  replacement and leaves the Electron executable icon unchanged.
- The BrowserWindow runtime icon should come from a bundled PNG (or ICO on
  Windows), never a development-only path into this directory. Copy the selected
  asset during prepare, explicitly allow it in the release payload, and verify
  its presence/hash in the staging/package checks.

These contracts are backed by local `app-builder-lib/out/options/*Options.d.ts`
and `out/winPackager.js`. Packaging configuration and release integration are
maintained separately from this asset directory.

## Verification scope

The source was rendered and visually reviewed on light and dark backgrounds at
16, 24, 64, and 256 px, including transparent margins. Generated PNGs and embedded
ICO/ICNS frames are decoded and compared during asset review. Two consecutive
regenerations with the toolchain above produced matching inventory hashes.
This is asset QA only: macOS Finder/Dock, Windows Explorer/taskbar/installer,
Linux shell integration, signed builds, and application functionality still need
target-platform verification. Do not treat a contact sheet as functional QA.
