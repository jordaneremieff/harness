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

| Key | Publisher and presentation contract | Meaning | Cleared by |
|---|---|---|---|
| `agent` | [Agent roster and coverage](../../extensions/agent/README.md#roster-and-coverage) | A dot for work that this session sent with the agent tools, then working and total agents created by the current primary session, including agents they create, with observed native cost. Each primary receives its own figures. | No agents in that session scope and no such work out, primary lifecycle cleanup, or manager close. Retained idle agents remain in scope. |
| `explorer` | [Explorer app update](../../extensions/explorer/README.md#open-explorer) | The Explorer native app update is active. | Update completion or session shutdown. |
| `jobs` | [Background job status](../../extensions/jobs/README.md#footer-status-and-terminal-records) | A dot, then the background commands that run now out of every one that the session started, from its first job on. | Session shutdown; the next runtime of the session shows it again. |
| `stash` | [Background distillation](../../extensions/stash/README.md#background-distillation) | A `/stash new` request is starting. The status covers admission, not the work that follows. | The last pending admission returns or fails, or the session shuts down. |

## Rules

- A key is one lowercase word naming the publisher slice. The footer orders cells
  alphabetically by key, independent of when each publisher first reports status.
- The publisher sets its key on relevant changes and clears it with
  `setStatus(key, undefined)` on `session_shutdown` and when its registered
  meaning no longer has state to show. A cost/status projection may remain
  after terminal work when the registry row says so.
- A consumer renders status text generically; it must not parse or
  reformat another extension's text (AGENTS.md: no sibling protocol).
- Text stays short and bounded: the footer is width-constrained, and the
  statusline sanitizes display text.
- A key that reports work which will come back and start the session's next
  turn leads its text with a dot whose colour says what to do, like a traffic
  light:
  - yellow filled dot (`●`, theme colour `warning`): such work is out and will
    come back by itself; wait;
  - red filled dot (`●`, theme colour `error`): such work failed, or waits on
    something that needs intervention; look;
  - grey hollow dot (`○`, theme colour `muted`): no such work is out; the
    next step is the operator's.

  Colour is drawn only in the interactive terminal; other hosts receive the
  plain glyph. Each publisher decides with its own code which of its work
  counts and when it shows red.
- A click on a status cell in the fullscreen footer runs the extension command
  whose name equals the key, with no arguments. A publisher that registers a
  command of its key's name makes that command, with no arguments, open its
  own view, or at least do nothing harmful. A key that names no extension
  command is not a control. The consumer matches the key exactly and reads
  nothing from the text.
- A new key is added to this registry by its publisher in the same change
  that introduces it.
