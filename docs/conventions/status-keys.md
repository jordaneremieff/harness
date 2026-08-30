# Footer status-key registry

Repository-level registry for the extension status keys published through
`ctx.ui.setStatus(key, text)`. The host keeps one text per key and exposes
all keys through `footerData.getExtensionStatuses()`; the statusline
extension renders every key generically on its second footer line. Keys are
an informal namespace, so the registry is the contract: a publisher owns its
key, and a consumer must not parse a sibling's status text.

## Host surface

- Publish: `ctx.ui.setStatus(key, text)`; `text` of `undefined` clears the
  key (Pi extension API, `core/extensions/types`).
- Read: `footerData.getExtensionStatuses(): ReadonlyMap<string, string>`
  (Pi footer data provider).
- Render: the statusline extension appends every nonempty value, sanitized,
  to footer line 2 (`extensions/statusline/index.ts`); Pi's own footer also
  renders extension statuses.

## Registry

| Key | Publisher | Meaning | Current texts | Cleared by |
|---|---|---|---|---|
| `stash` | `extensions/stash` | Stash distillation progress for `/stash new <hint>`. The publisher owns the animation; the footer renders the text generically. | `stash: running <spinner frame> · <distiller model [thinking]>` while a distillation runs (TUI, 120 ms animation); then `stash: done <id> · <in> in · <out> out · ~$<cost>`, `stash: skipped`, or `stash: failed`. The done totals appear when the distill session reports stats. | 3 seconds after the terminal text, on `/stash abort`, and on `session_shutdown`. |
| `subagent` | `extensions/subagent` | Current parent session's locally owned active-worker count plus cumulative observed worker spend. Terminal spend remains visible without implying activity. | `subagents: 2 active · $0.37`; `subagents: 0 active · $0.37` after completion. | When the session has neither active workers nor observed spend, and on `session_shutdown`. |
| `pivot` | `extensions/pivot` | Fork-boundary arming: set while the boundary is queued for the session's first interactive input. | `fork boundary armed — next message will be framed` while armed. | When the first interactive input consumes the boundary, and on `session_shutdown`. |
| `herdr` | `extensions/herdr` | herdr attention notices and the `/herdr` jump target. | `herdr: <text>` for agent-status notices (the attention loop); a bare paneId as the `/herdr` jump target. | Not cleared today: every `setStatus("herdr", …)` call passes text and no clear path exists, including on `session_shutdown`. |

## Rules

- A key is one lowercase word naming the publisher slice.
- The publisher sets its key on relevant changes and clears it with
  `setStatus(key, undefined)` on `session_shutdown` and when its registered
  meaning no longer has state to show. A cost/status projection may remain
  after terminal work when the registry row says so.
- A consumer renders status text generically; it must not parse or
  reformat another extension's text (AGENTS.md: no sibling protocol).
- Text stays short and bounded: the footer is width-constrained, and the
  statusline sanitizes display text.
- A new key is added to this registry by its publisher in the same change
  that introduces it.
