# shadcn/ui source components

The components in `src/components/ui/` were generated with the official `shadcn@4.22.1` CLI and adapted for Hipi Work. The original MIT notice is preserved in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

Official sources: [CLI guide](https://ui.shadcn.com/docs/cli), [component registry](https://ui.shadcn.com/r/styles/new-york-v4/) and [upstream source](https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/new-york-v4/ui).

## Local adaptations

- Preserve Radix composition, refs, native props and keyboard behavior; use the application's `cn`, explicit relative imports and formatting.
- Use semantic theme, focus and disabled-state tokens instead of fixed colors or dark-class styling.
- Default Button to `type="button"`; retain explicit submit support. The composer owns Textarea sizing.
- Add translated dialog close labels, bounded scroll bodies and right-panel placement.
- Preserve Input Group layout and focus behavior. Keep reduced-motion support without unused animation utilities.

The application package manifest and root lockfile are the dependency source of truth. CLI logs, disposable staging locks, original comparison snapshots and per-npm-package license copies are not retained here.
