# Official shadcn/ui provenance and product adaptations

Generated on 2026-10-19 using the official npm registry `shadcn@4.22.1` CLI (MIT), not hand-copied component implementations. CLI tarball: https://registry.npmjs.org/shadcn/-/shadcn-4.22.1.tgz . Official CLI guide: https://ui.shadcn.com/docs/cli . Component registry: https://ui.shadcn.com/r/styles/new-york-v4/ .

## Reproduction and retained evidence

A disposable staging project was configured with `style: new-york`, React 19, Tailwind 4, TypeScript, and no React Server Components. No project init or overwrite was run against Hipi.

1. Install exact `shadcn@4.22.1`, `react@19.3.1`, `react-dom@19.3.1`, `tailwindcss@4.3.3` into staging using `npm install --ignore-scripts --save-exact --registry=https://registry.npmjs.org`.
2. Execute `node node_modules/shadcn/dist/index.js add button select input textarea dialog dropdown-menu tooltip scroll-area --yes` with `npm_config_ignore_scripts=true`, explicit official npm registry, and the environment's HTTP proxy. The CLI's SOCKS proxy selection stalled; the successful invocation unset only ALL_PROXY/all_proxy so the configured HTTP proxy was used.
3. Execute the same CLI with `add popover --yes` for the requested interactive conversation card.
4. Execute the same CLI with `add input-group --yes` for the search control. This created only `input-group.tsx`, reusing Button, Input and Textarea without changing runtime dependencies. `4.22.1/cli-input-group.log` retains its successful output.

All successful CLI invocations completed with exit code 0. `4.22.1/cli-add.log` and `cli-popover.log` retain outputs; sibling TSX files are untouched CLI output, with SHA-256 hashes in `generated-sha256.json`. `staging-package-lock.json` records the disposable toolchain, not application dependencies. No lifecycle scripts were enabled.

## Concentrated adaptations

- Preserve generated Radix composition, Slot/asChild, CVA variants, data slots, refs and primitive prop forwarding. Replace generated `cn` package imports with the project's existing `cn`, use type-only React imports, explicit relative TypeScript extensions, and repository Biome formatting.
- Define components.json and the `@/*` TypeScript/Vite alias for future official CLI updates. Production code uses the repository's explicit relative import convention.
- Map missing semantic popover, input, secondary and destructive tokens onto light/dark product variables. Remove hard-coded black overlay and dark opacity backgrounds; use the existing data-theme strategy. Disable-state colors are opaque independent tokens, never opacity-50. Disabled Input/Textarea placeholders explicitly use disabled-foreground; Select uses a combined disabled + data-placeholder variant so its ordinary placeholder color cannot override the disabled foreground. Main button hover uses its audited solid token. Focus rings use opaque ring tokens, including destructive buttons and focused invalid controls. Invalid controls retain the destructive border, but the ring is scoped to focus-visible rather than made permanently visible.
- Button defaults to type=button, with explicit submit still supported. Input/Textarea explicitly use foreground text. Textarea omits CSS field-sizing-content because the composer owns bounded measured sizing; all refs and IME/input handlers are forwarded unchanged.
- DialogContent requires translated closeLabel and supports closeDisabled for pending create; Footer closeLabel is also required when used. Close hit area is 32px. Dialog uses product overlay and width. PopoverTitle renders h2 to match its generated prop type.
- Search uses the official InputGroup/Addon/Input composition, one outer focus ring, and a translated associated label; create/reopen/connection fields use Input; composer uses Textarea; conversation preview cards use Popover. The workspace picker was initially migrated to Select, then replaced by the requested project/conversation tree; Select remains available in the shared component layer. Existing business state and persistence ownership are unchanged. Remaining primitives are available for the approved phase; no dummy actions were introduced.
- Remove upstream animate-in/out, fade/zoom/slide utility names centrally instead of shipping inert classes or adding an animation-only dependency. State changes are immediate; color transitions remain. Reduced-motion rules remain in the product stylesheet.

Input Group preserves upstream layout and addon focus behavior. Adaptations use opaque semantic focus/disabled tokens and native control-disabled selectors, omit dark-class colors, and replace unavailable radius arithmetic with rounded-sm. Its div/group structure is retained with scoped accessibility-lint explanations; the addon only forwards pointer focus to an already keyboard-focusable control. Legacy search input CSS is removed. Composer overrides are scoped to composer-input with a single outer focus ring; placeholders remain owned by Textarea. Compact create buttons use official outline/icon-sm controls with translated Tooltip and Dialog triggers sharing one button.

## Dependency review

Runtime additions are exact `radix-ui@1.8.1` (MIT, 105530 bytes unpacked) and `lucide-react@1.59.0` (ISC, 36120474 bytes unpacked), from official npm registry tarballs. Radix provides accessible browser primitives; Lucide supplies generated component icons. Existing class-variance-authority/clsx/tailwind-merge are reused. The registry's new cn package is deliberately not added. The CLI is staging-only and is not shipped as a runtime dependency.

Radix's umbrella package adds dependencies for its entire primitive set, although Hipi imports only selected primitives. Individual Radix imports were an alternative, but would diverge further from official generated source. Lucide's unpacked source size is not shipped bundle size; production bundle size/tree shaking has not been measured because builds are not authorized. Both upstream packages have no install lifecycle scripts. `licenses/` retains the official shadcn MIT notice and license files for all 50 added lock entries. They are actively distributed official Radix/Lucide packages; version pinning is not a security guarantee.

`dependency-delta.json` compares the application lock against the previously delivered history source ZIP: 50 new lock entries, no existing package version changes, all new resolved URLs at registry.npmjs.org, no new hasInstallScript flags. These additions are Radix browser primitives/shared hooks plus Lucide. No Node/Electron imports were added to UI. Existing direct @radix-ui/react-dialog is retained pending separate cleanup, not silently removed.

## Verification boundary

UI `npm run check` (Biome and TypeScript) passed after migration. Root checks and browser interaction/visual checks are coordinated separately and must be reported from their own results. No build, Electron, full test suite, commit, or paid model invocation was run for this import.
