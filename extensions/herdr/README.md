# herdr: pi session identity for herdr UI

Reports the pi session identity to herdr so the sidebar, pane borders, and tab
bar distinguish sessions at a glance. The extension is a display-only
complement to herdr's own pi integration; it never reports lifecycle state or
session references.

## Surfaces

| Surface | Effect | Config |
|---|---|---|
| Tab bar | `tab.rename` to the session name on `/name` | none |
| Pane border | metadata `title` composed as `<name> · <model>`, or `pi · <model>` while unnamed | none |
| Sidebar agent row | metadata `display_agent` set to the session name | none |
| Sidebar token | `model` metadata token for a `$model` sidebar row | none |

The default herdr sidebar rows render the `agent` token, which resolves to
`display_agent` first, so one metadata report changes the default sidebar
without herdr configuration. Pane borders resolve the metadata `title` before
manual labels.

## Behavior

- `session_start` reports the current session name, model, and tab label.
  Resume, reload, and herdr restart converge on the next event.
- `session_info_changed` (the `/name` command) re-reports with the new name.
- `model_select` refreshes the border composition and the `model` token.
- `session_shutdown` with reason `quit` clears the metadata and restores the
  numeric fallback appearance for the tab's current position.

Manual names stay authoritative:

- An auto-named tab (label equals its position number) may be taken over.
- A tab this extension named follows the session and returns to its current
  numeric label when the name clears. Herdr 0.8 has no API to clear a tab's
  `custom_name`, so the result looks automatic but remains a custom label.
- Any other tab label and any manual pane label are never touched.

The extension only acts when `HERDR_ENV=1`, the herdr socket and pane id are
present, and pi runs in TUI mode. Outside herdr it loads as a no-op. All
socket traffic gets one bounded retry. Display reports then drop their final
error; the next event re-synchronizes.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `PI_HERDR_MAX_NAME_LENGTH` | Cap for reported names and tab labels | 60 |

## Boundaries

- Lifecycle state (idle/working/blocked) and native session restore stay with
  herdr's own pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`,
  installed by `herdr integration install pi`).
- No herdr-side plugin or daemon runs; the pi side has the name
  authoritatively.
- The outer terminal window title is never touched.
