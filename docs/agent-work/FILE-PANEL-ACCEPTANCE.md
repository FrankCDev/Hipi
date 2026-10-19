# File panel acceptance

Status: implementation and deterministic controller / server-render tests only. The checks below require an actual browser or desktop window and have not been run in the current environment. SSR cannot prove focus trapping, pointer capture, editor composition, preview teardown, or pixel layout.

## Scope and ownership

- `Workbench` owns the editor session, dirty-workspace guard, and `beforeunload` handler. Closing the file panel unmounts its presentation, never clears or disposes that session.
- Exactly one file workbench is mounted: dock or the existing Radix-backed Dialog. Closing or changing presentation mode disposes the preview session; reopen the preview to view it again. Unsaved text remains in memory, not durable storage.
- The existing verified-store `LocalState` stores only `file-panel.open` and `file-panel.width`. Reads and writes validate exact booleans and integer widths from 320 to 720. No runtime or IPC contract changes.
- The dock uses measured work-area width, after navigation. It reserves 480 pixels for the conversation and 8 for the resize handle. Below 808 available pixels, it uses a modal instead of shrinking the conversation or creating a second editor.

## Real-browser checks still required

Use a real authorized workspace and text file. Repeat in Chinese and English, light/dark and custom editor themes, then at 200% zoom.

1. With fresh local state, open the welcome screen. Confirm no empty file column. Use the toolbar's Show files / 显示文件 control; verify the label and expanded state change. Close using its own Hide files control and confirm keyboard focus returns to the toolbar button.
2. At a wide window, open and edit a file without saving. Hide and reopen the panel: the exact text and dirty state remain. Reload or close the window while hidden: the native unsaved-work warning still appears. Cancel it. Switch workspaces while hidden: Stay retains the file and selected workspace; explicit discard proceeds through the original guard.
3. While the text is dirty, shrink until the available work area is below 808 CSS pixels. Confirm a single Dialog/editor, no horizontal overflow, and the same unsaved text. Tab/Shift+Tab remain inside; Escape closes and returns focus to Show files. Reopen and grow to wide mode; the text remains. Repeat during an asynchronous save and compare, including failed/unknown write outcomes.
4. Drag the divider past both limits; the conversation retains at least 480 pixels. Release outside the divider, cancel a touch pointer, close during a drag, resize into modal mode during a drag, and disconnect. Confirm no stuck capture, cursor, or later pointer-driven resizing.
5. Focus the divider using Tab. Left expands the right panel; Right contracts it, in 24-pixel steps. Home/End reach the current bounds. Verify visible focus and screen-reader name, orientation, current/min/max values. Resize the window again and verify the bounds update.
6. Open a PDF/image preview, then close the panel and reopen. Confirm the preview has closed, its worker/blob URL/render job no longer runs, and no stale preview flashes after close. Repeat while a preview request is loading. This is distinct from preserving editor text.
7. Change width and visibility, reload the same verified store and confirm restoration. Connect a different store and confirm defaults. Deny browser storage: controls remain usable and a persistence warning appears. Inject invalid widths/boolean strings only into local UI preference records; invalid records must not restore.
8. At 320, 720, 1024, and 1440 CSS-pixel viewport widths, confirm toolbar actions remain reachable, long paths scroll/wrap, modal close stays visible, and the composer is not pushed into a narrow column. Test Chinese IME composition before closing/reopening, keyboard-only navigation, and long translated labels.

## Deterministic checks

From `apps/hipi-work-ui`:

- `node ../../node_modules/vitest/dist/cli.js --run test/file-panel.test.tsx`
- `node --test test/local-persistence.test.ts`

The tests cover defaults, validated store-scoped persistence, denied writes, subscriptions, deferred resize writes, fractional width bounds, the narrow-mode decision, SSR single-surface semantics, and dirty-session preservation across hidden and reopened presentation. They do not replace the real-browser checklist above.
