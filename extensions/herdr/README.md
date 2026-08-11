# herdr: pi session identity for herdr UI

Reports the pi session name to herdr's tab bar and the model to its sidebar,
so sessions are distinguishable at a glance without duplication. The extension
is a display-only complement to herdr's own pi integration; it never reports
lifecycle state or session references.

## Surfaces

| Surface | Effect | Config |
|---|---|---|
| Tab bar | `tab.rename` to the session name on `/name` | none |
| Sidebar token | `model` metadata token, rendered as `$model` in a sidebar row | one `rows_by_agent.pi` row |

The session name lives on the tab; herdr's default sidebar line already
carries the tab name there. The model is reported as a `$model` token so a
sidebar row can show the one fact the tab cannot. Add the row under
`[ui.sidebar.agents.rows_by_agent]` so only pi panes are affected:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "workspace", "tab"],
  ["$model"],
]
```

Other agents keep herdr's default layout.

## Behavior

- `session_start` reports the model token and the tab label. Resume, reload,
  and herdr restart converge on the next event.
- `session_info_changed` (the `/name` command) re-reports with the new name.
- `model_select` refreshes the `model` token.
- `session_shutdown` with reason `quit` clears the token and restores the
  numeric fallback label for the tab's current position.

Manual names stay authoritative:

- An auto-named tab (label equals its position number) may be taken over.
- A tab this extension named follows the session and returns to its current
  numeric label when the name clears. Herdr 0.8 has no API to clear a tab's
  `custom_name`, so the result looks automatic but remains a custom label.
- Any other tab label is never touched.

The extension only acts when `HERDR_ENV=1`, the herdr socket and pane id are
present, and pi runs in TUI mode. Outside herdr it loads as a no-op. All
socket traffic gets one bounded retry. Display reports then drop their final
error; the next event re-synchronizes.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `PI_HERDR_MAX_NAME_LENGTH` | Cap for session names written as tab labels | 60 |

## Boundaries

- Lifecycle state (idle/working/blocked) and native session restore stay with
  herdr's own pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`,
  installed by `herdr integration install pi`).
- No herdr-side plugin or daemon runs; the pi side has the name
  authoritatively.
- The outer terminal window title is never touched.
