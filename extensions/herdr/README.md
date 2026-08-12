# herdr: pi session identity and herd control inside herdr

Reports the pi session to herdr's UI, gives the model read-only and coordination
tools over the surrounding herd, watches sibling agents, and ships a herdr skill
and a `/herdr` jump command. The extension is a presentation and coordination
complement to herdr's own pi integration; it never reports lifecycle state or
session references, and it loads as a no-op outside herdr.

## Surfaces

| Surface | Effect | Config |
|---|---|---|
| Tab bar | `tab.rename` to the session name on `/name`; a guarded first-message label when no name is set | none |
| Sidebar token `model` | Current model, rendered as `$model` | one `rows_by_agent.pi` row |
| Agent tools | Inspection and coordination tools over panes and agents, active only inside herdr | none |
| Attention loop | Notifies when a sibling agent blocks or finishes | none |
| Skill `herdr` | Herdr discovery and coordination recipes, distributed through `resources_discover` | none |
| `/herdr` command | Operator picker that focuses a sibling pane or agent | none |

## Behavior

### Tab label

The session name lives on the tab. The label precedence is:

1. the explicit pi session name (`/name`);
2. a guarded label derived from the first user message, when no name is set;
3. herdr's numeric position label.

The first-message fallback applies three guards, so it only lands when it adds
information: boilerplate openers are rejected (markup, slash commands, harness
handoff phrases), template prefixes are stripped (`Objective:`, `Goal:`,
heading and list markers), and a label already shown on another tab of the
workspace is rejected so the pane keeps its number. The fallback is captured at
the moment the prompt arrives, so a later `/name` always wins.

Manual names stay authoritative:

- An auto-named tab (label equals its position number) may be taken over.
- A tab this extension named follows the session and returns to its current
  numeric label when the name clears. Herdr 0.8 has no API to clear a tab's
  `custom_name`, so the result looks automatic but remains a custom label.
- Any other tab label is never touched.

### Sidebar tokens

The `model` token reports the current model.

Add it under `[ui.sidebar.agents.rows_by_agent]` so only pi panes show it:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "workspace", "tab"],
  ["$model"],
]
```

### Tools

Inside herdr the extension registers inspection tools (`herdr_snapshot`,
`herdr_panes`, `herdr_agents`, `herdr_current`, `herdr_layout`,
`herdr_process_info`, `herdr_explain`, `herdr_read`) and coordination tools
(`herdr_split`, `herdr_run`, `herdr_send_text`, `herdr_send_keys`,
`herdr_agent_start`, `herdr_agent_prompt`, `herdr_agent_wait`, `herdr_notify`).

Safety is structural, not procedural. Methods that destroy or reconfigure state
the model did not create are absent from the tool layer and refused at the call
boundary; every pane target is re-resolved against a fresh `pane.list` before a
write; and writes to one pane are serialized so two tool calls never interleave
input. There are no confirmation dialogs.

### Attention loop

A long-lived subscription watches sibling panes' agent-status events and raises
the two transitions that end a wait: an agent that blocks and an agent that
finishes. herdr's `pane.agent_status_changed` subscription is per-pane, so the
loop subscribes to every sibling and widens or narrows that set on
`pane.created` and `pane.closed`. The session's own pane is ignored, repeated
notifications are throttled, and the loop never writes across agents.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `PI_HERDR_MAX_NAME_LENGTH` | Cap for session names written as tab labels | 60 |

## Boundaries

- Lifecycle state (idle/working/blocked) and native session restore stay with
  herdr's own pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`,
  installed by `herdr integration install pi`). This extension never reports
  them.
- The extension only acts when `HERDR_ENV=1`, the herdr socket and pane id are
  present, and pi runs in TUI mode. Outside herdr it loads as a no-op.
- All socket traffic is best-effort with bounded, semantic retry; display
  reports drop their final error and the next event re-synchronizes.
- The outer terminal window title is never touched.
