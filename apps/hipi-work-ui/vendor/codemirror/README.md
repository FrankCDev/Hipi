# Public Markdown editor dependencies

The Markdown editor uses public CodeMirror 6 packages, without a React wrapper or copied reference implementation. Ordinary text/code and comparison continue to use Pierre.

| Direct package | Exact version | License | Official source |
| --- | --- | --- | --- |
| @codemirror/commands | 6.8.1 | MIT | https://code.haverbeke.berlin/codemirror/commands |
| @codemirror/state | 6.5.2 | MIT | https://code.haverbeke.berlin/codemirror/state |
| @codemirror/view | 6.38.6 | MIT | https://code.haverbeke.berlin/codemirror/view |
| @codemirror/lang-markdown | 6.5.2 | MIT | https://code.haverbeke.berlin/codemirror/lang-markdown |
| @codemirror/language | 6.13.1 | MIT | https://code.haverbeke.berlin/codemirror/language |
| @lezer/highlight | 1.2.5 | MIT | https://code.haverbeke.berlin/lezer/highlight |

`inventory.json` records the 24 installed package paths reachable through these direct packages' dependency declarations, their exact versions and lockfile integrity, and SHA-256 hashes of the original notices in `licenses/`. All are MIT-licensed. No inventoried package declares `preinstall`, `install` or `postinstall`. Dependency development `prepare` commands were not executed. The Markdown addition used exact pins and `npm install --ignore-scripts`; it added 12 lockfile package paths and changed no pre-existing resolved version or integrity.

This is an installed closure, not a claim that every package is bundled. In particular, the JavaScript language package declares a lint dependency used by its public types; its runtime module does not import that lint package. The lint closure has separate newer state/view versions. Native packaging's actual bundle-owner checks remain authoritative. Original notices must accompany distributions under `dist/third-party/codemirror`; existing Pierre inventory hashes are unchanged.

## Runtime boundary

- `markdown()` and the public Markdown language supply parsing and Markdown editing keymaps. `HighlightStyle`, `syntaxHighlighting` and `EditorView.lineWrapping` supply syntax presentation through application semantic colors and fonts.
- The application statically imports the Markdown extension. Its official dependency graph statically includes local HTML, CSS and JavaScript parsers for embedded source. No dynamic language descriptions, remote loaders, workers, WASM, grammar URLs or CDN fallbacks are configured. Unlisted code fences remain plain source.
- HTML completion and automatic paste-URL rewriting are disabled. The approved shared Find/Replace UI retains its public matching engine, latest-document/read-only checks, IME handling and one bounded undoable transaction.
- Same-tab Source/Preview switches read the current editor draft. Preview reuses the existing bounded `MessageMarkdown`: raw HTML is skipped, images are inert placeholders, links are inert text, and large content falls back to paged original text. Preview has no file-write callback.
- The tab retains CodeMirror state, undo/selection and source scroll independently of preview scroll. Switching presentation does not read a file, change a revision or trigger a save. Existing autosave scheduling remains owned by the file session.

The reference application's exact bundled versions are unknown. These checks do not establish native IME, accessibility, visual, performance or three-platform acceptance.
