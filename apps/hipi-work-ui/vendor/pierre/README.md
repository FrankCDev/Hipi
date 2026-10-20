# Public file UI dependencies

The application imports public registry packages. No implementation, theme, icon, branding or user content from the reference application is included here.

| Package | Version | License | Official source |
| --- | --- | --- | --- |
| @pierre/diffs | 1.5.2 | Apache-2.0 | https://github.com/pierrecomputer/pierre/tree/main/packages/diffs |
| @pierre/trees | 1.0.0-beta.6 | Apache-2.0 | https://github.com/pierrecomputer/pierre/tree/main/packages/trees |
| shiki | 4.5.0 | MIT | https://github.com/shikijs/shiki |

`inventory.json` records the 55 installed packages reachable through these three packages' dependency declarations, including shared and type-only dependencies. This is an installed dependency inventory, not a claim that every package is included in the renderer bundle. Each record contains its exact version, lockfile integrity, installation lifecycle commands and SHA-256 hashes for the original license/notice files. No package in this inventory declares `preinstall`, `install` or `postinstall`. Development build/test commands were not executed.

All original LICENSE/NOTICE files are retained under `licenses/`. The one exception in naming is `lru_map`, whose published package supplies its complete MIT license at the end of README.md; that section is retained with its source recorded. Pierre's theme package includes the upstream Primer notice, retained unchanged.

Installations used exact versions and `npm --ignore-scripts`. Native packaging must copy this directory into `dist/third-party/pierre`. Existing bundled-input license checks remain authoritative for the actual distribution graph.

## Runtime boundary

- `@pierre/diffs/edit` supplies `Editor`, its editing/history commands and the public `TextDocument` extension point. The application's small subclass only enforces the existing 128 KiB transaction limit before mutation.
- `@pierre/diffs/react` supplies `CodeView`, `EditProvider` and read-only `FileDiff`. Application sessions own permissions, text revisions, saves and recovery; a tab owns bounded in-memory renderer state.
- `@pierre/trees` supplies the real virtualized file tree. The application supplies only already-authorized loaded directory pages and its domain action callbacks.
- File rendering selects a finite set of statically imported CSS, HTML, JavaScript, JSON, Python, shell, TypeScript and YAML grammars. Unknown extensions use plain text. Shiki's JavaScript engine is selected explicitly, and the optional Pierre worker pool is disabled. The application does not request a remote highlighter, grammar, theme or WASM binary.
- Theme CSS is an original semantic-token adapter. It inherits application font and editor-region settings; no private reference theme is copied.

Reference package identities were verified independently, but the reference application's bundled package versions are unknown. Matching public library identity does not establish exact version, platform accessibility, IME, performance or visual parity.
