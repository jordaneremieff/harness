# statusline: two-line session footer

This extension replaces Pi's default footer with a two-line statusline for
long-running agentic sessions. Line 1 carries the session's route identity and
metrics; line 2 carries a compact menu control, project context, and whatever
extension statuses other extensions publish through `ctx.ui.setStatus()`.
Overlays complete the footer: the menu with command search, a model selector,
a reasoning selector, and a reader for the complete status map.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| footer | `ctx.ui.setFooter` | Two-line statusline, installed on `session_start` in TUI mode only. |
| `/statusline` | command | Toggle between the custom statusline and Pi's default footer. |
| `/commands` | command | Open the footer menu: browser destinations, model and reasoning controls, statuses, and command search. |
| `/statuses` | command | Open the read-only reader for the complete extension status map. |
| `≡` cell | footer click target | In fullscreen, the leading padded `≡` cell opens the menu. |
| model and level segments | footer click targets | In fullscreen, a click on the `provider/model` segment opens the model selector; a click on the `[level]` bracket opens the reasoning selector. |
| `+N` cell | footer click target | In fullscreen, the hidden-status count opens the status reader. |

No extension-specific configuration is required. The custom footer starts
enabled; use `/statusline` to switch to Pi's default footer or back.
There are no tools, timers beyond one footer-owned tick, background work, or
configuration overlays.

## Menu

The menu is the first screen of the `≡` overlay and of `/commands`. It is
headed "Menu" and lists, in order:

1. **Restore replaced draft**, only while a replaced draft waits for recovery.
2. **Destinations** that owning extensions announce as data through the
   operator-destination contract (`docs/conventions/operator-panels.md`):
   Agents, Clipboard, Pillars, Policy, Stashes. Each is resolved at menu open
   against the current `pi.getCommands()` inventory to its announcing owner's
   own registration (the inventory entry whose `sourceInfo.path` is the owner
   module), keeping Pi's actual invocation name, so a destination still opens
   when another extension registers the same name and Pi lists `stash:1` and
   `stash:2`. It opens directly on Enter or click through the same guarded
   dispatch as a Run; a destination whose owner registration is missing, or
   appears more than once, is listed with that reason and does not open. A destination is a harmless open; commands that start work,
   such as `/evo`, stay behind search with their argument field.
3. **Model…**, **Reasoning…**, **Statuses**: the session controls, each with
   its current value beside it.
4. **Search commands…**: the full inventory below.

Escape on the menu closes it; Escape on search returns to the menu.

### Model and reasoning

**Model…** lists `ctx.modelRegistry.getAvailable()` as `provider/model-id` rows
with the display name, the current model preselected. A click on a row only
highlights it; **Apply** (or Enter) commits the highlighted row. Apply calls
`pi.setModel(model)` for this session only; a `false` return (authentication
not configured for the provider) is reported as a refusal and nothing changes.
Cancel and Escape change nothing. **Reasoning…** lists the levels
`getSupportedThinkingLevels(model)` reports for the current model, with the same
click-highlights, Apply-commits behaviour; Apply calls
`pi.setThinkingLevel(level)`, which clamps to the model. A model without
reasoning is reported as such and offers no list. No builtin slash text is
sent to the model to emulate these dialogs.

### Command search

Search lists `pi.getCommands()`: extension commands, prompt templates,
and skills under their exact invocation names, including collision suffixes
such as `review:1`. Pi's `sourceInfo` is the provenance shown for each entry;
ownership is never inferred from names or paths. Builtin interactive commands
such as `/model` are not in that inventory and are not offered.

The list filters as you type, matching every query word against the name or
description. Enter or a row click opens the entry's detail: description,
provenance, an argument editor (labelled Direction for `/evo`), and labelled
actions. Selection never executes anything.

- **Run** (extension commands): the selector closes first, so the command's own
  UI can open. The inventory is then re-read and the exact registration is
  compared field by field; only a still-present, unchanged registration is sent
  through `pi.sendUserMessage("/name args", { expandPromptTemplates: true })`.
  Pi runs extension commands immediately, even while the agent is busy, without
  a model acknowledgement. A registration that disappeared or changed is
  refused with a notification, and the selector reopens with the refreshed
  list, so a stale selection never becomes a model prompt.
- **Insert into draft** (prompt templates and skills): the invocation text is
  prepared in the editor, never sent. An empty editor receives it directly. When
  a draft exists the selector asks: *Insert at cursor* pastes through Pi's
  paste handling and keeps the draft; *Replace draft* keeps the removed draft
  recoverable through the *Restore replaced draft* entry at the top of the menu;
  *Keep draft* returns to the command.
- **Back** returns to the list with the query, selection, and typed arguments
  kept; **Menu** returns to the menu; **Close** leaves without an action. Typed
  arguments and the query survive reopening within the session.

### Overlay sizing

Pi renders an overlay at its resolved width and clips lines beyond its
`maxHeight` (85% of the terminal rows here); it is not a layout root. Every
overlay component therefore reads its row budget from the live terminal on each
render, reserves its fixed rows (heading, hint, inputs, and the Close row)
before sizing its list or body, clamps scroll offsets, and rebuilds hit
geometry. A list that overflows its rows gets one more row for Pi's position
indicator (`(3/9)`), so the menu with every destination and session control
keeps Close on screen and its selected entry when the terminal shrinks from
60x20 to 60x12. Close and the final entry stay reachable at 60x20 and 80x24 and
after a height-only shrink. The overlay ignores pointer events whose width differs
from the rendered width, so a click after a resize cannot act on a stale row.
Session shutdown closes an open overlay without dispatch.

## Status reader

The reader shows every entry of `footerData.getExtensionStatuses()` with the
owner key as the label and the value as opaque text: terminal sequences removed,
control characters spaced, nothing parsed and no severity inferred. Close and
Refresh are visible controls; Refresh re-reads the map. The reader needs the
installed statusline footer, which supplies the status provider; with the
footer disabled, `/statuses` says so.

## Pointer and mode boundary

Pi delivers mouse events to footer components only in fullscreen mode. There
the leading cell renders as a padded `≡`, the line-1 model and level segments
are click targets, and the `+N` cell is a click target. In regular mode the
mouse belongs to the terminal, so the leading cell names the keyboard route
(`/commands`) and claims no click. Both commands work in every TUI mode;
outside the TUI they explain the requirement.

## Line 1: session metrics

Segments join with a dim `│` separator:

1. **Route + thinking.** `provider/model-id` (the exact route identity, with
   no label), accent-colored, plus a `[<level>]` bracket (for example
   `[high]`) in the per-level theme color.
   The bracket appears only when the model declares `reasoning: true` and a
   thinking level is present; it does not depend on the provider name.
2. **Context bar + tokens.** A ten-cell block bar (`██████░░░░ 62%`) rendered
   with theme foregrounds so it works in dark and light terminals, plus
   `tokens/contextWindow`. Zero usage shows `0%`. Unknown usage after compaction
   shows `context ?` and `?/contextWindow`; an absent host estimate shows
   `context unavailable`. Overflow fills the bar but preserves the percentage
   above 100. Color ramp: success through 60%, warning through 80%, error above.
   These are display bands, not Pi's configurable compaction threshold or a safe
   remaining token budget.
3. **Cost.** `~$N.NN` sums Pi's recorded cost estimates across the whole session,
   including assistant turns, nested tool calls, compaction, branch summaries,
   and standalone usage entries such as cache refreshes. Hidden below half a
   cent. This is recorded model pricing, not a billing statement.
4. **Duration.** Wall clock since this process attached to the session
   (reset on every `session_start`, including reload). It is an attach
   clock, not a session-age clock.
5. **Cache telemetry.** Two measured parts: a read/write dot for the most recent
   cache-active assistant turn and an assistant session hit-rate percentage.
   See below.

Usage totals use one full `ctx.sessionManager.getEntries()` reconciliation on
attachment and session-tree navigation. This includes abandoned branches and
pre-compaction entries. Paint reads only those aggregate totals. Turn completion,
agent completion and compaction update totals outside paint. The existing idle
tick checks the public leaf ID for standalone usage with no completion event.
Catch-up reads at most 256 new parent-linked entries per callback, then continues
on another owned callback. An unexpected parent-chain change triggers one full
reconciliation. The cache retains totals and a bounded traversal cursor, not a
second copy of session history. It uses public `getLeafId` and `getEntry`; the
extension context does not expose `getEntryCount`.

Context usage comes separately from `ctx.getContextUsage()` and describes the
active model context, not cumulative session usage.

## Cache telemetry

The extension reports only cache usage recorded in assistant turns. It does not
estimate provider cache lifetimes or show a TTL countdown.

- The **dot** reports the most recent cache-active turn: green when it read
  from cache, red when it only wrote. Cache-free turns do not move it.
- The **hit rate** is `cacheRead / (cacheRead + cacheWrite + input)` across
  assistant turns across the session, including abandoned branches. Cache
  refreshes, nested tool calls, and summaries contribute to cost but not this
  rate or the dot. A refresh must not masquerade as cache reuse by an assistant.
  Neither signal establishes that a provider cache remains alive now.

Pi owns cache-refresh scheduling and diagnostics through `/session` and its
transcript notices. The statusline does not add a refresh controller, infer
cache lifetimes, or override `cache_warming_decision`. Pi also owns the editor
spinners; replacing the footer does not replace or hide those spinners.

## Width behavior

Both lines must fit the terminal width. Line 1 sheds its least actionable
segments in order — cache rate, cache dot, duration, token count, then cost —
keeping the model and context bar to the end. Line 2 first shortens the folder
from the left with an ellipsis, preserving its last path component, then shortens
the branch with an ellipsis or omits it. If necessary, it also shortens the last
path component from the left. Only when complete extension statuses
still do not fit with a one-character project label does it drop statuses from
the right. A `+N` cell reports how many statuses are hidden. At extreme widths,
the command control and then the count take priority over the project label
and separator; a viewport too small for the control shows only its fitting
prefix, and a truncated count is not a click target. Both lines remain
unchanged when all segments fit. `truncateToWidth` is the final guard on both
lines.

## Line 2: menu + project + git + extension statuses

The leading cell is the menu control described above; it is never shed.
The project label is the home-relative working directory (`~/work/app`,
following Pi's footer convention) plus the git branch from
`footerData.getGitBranch()`. Extension statuses come from
`footerData.getExtensionStatuses()` — the supported host surface through
which any extension can publish footer text with `ctx.ui.setStatus()`. The
statusline renders them generically, with no per-key special cases, after
sanitizing each one. Model names, project labels, and branch labels use the
same sanitizer before theme colors are applied. Each label ends with a full
style reset, so its conceal, blink, background, or other graphics settings
cannot affect the thinking level, context metrics, or adjacent footer text.
A foreground-color reset alone does not contain those settings.

The sanitize contract is an SGR allowlist. A complete `ESC [ ... m` sequence
survives, so a status that colors itself renders as its author intended.
Everything else goes: other CSI sequences, terminated control strings (OSC,
DCS, SOS, PM, APC in both 7-bit and C1 encodings), two-byte escapes, and
truncated sequences whose parameter bytes would otherwise paint as literal
text. An unterminated control string loses only its introducer, so a stray
byte cannot swallow the rest of the status. Remaining C0/C1/DEL bytes blank
to spaces, whitespace collapses, and input is cut to 512 characters — a cap
that matters because SGR is zero-width and would otherwise slip past width
shedding at any length.

So a hostile status can pick its own colors inside its own cell and nothing
else: each status is bracketed with a reset, which bounds effects like
conceal or blink to that cell. It cannot move the cursor, clear the screen,
set the window title, write the clipboard, or emit a hyperlink.

## Lifecycle and mode boundary

- The footer installs on `session_start` when `ctx.mode === "tui"`. In RPC
  mode `setFooter` is a documented no-op, and in JSON/print there is no
  footer at all, so no install is attempted. `/statusline` toggles the flag
  in any mode but only touches the footer in TUI mode; it notifies when
  `ctx.hasUI`.
- One 5-second interval owns wall-clock freshness: Pi re-renders only on
  events, so without it the duration would go stale while idle. The tick is
  `unref`'d (it cannot hold the process open) and is
  cleared on footer `dispose()`, on `session_shutdown`, and before any
  reinstall, so toggling or reloading can never accumulate intervals.
- Branch changes re-render through `footerData.onBranchChange`.

## Files

- `index.ts`: registration, footer factory, pointer targets, the model and
  reasoning controls, tick ownership, `/statusline`, `/commands`, and `/statuses`.
- `commands.ts`: the menu, registration identity, filtering, guarded dispatch,
  draft preparation, and the search component.
- `destinations.ts`: the operator-destination consumer and registration resolution.
- `controls.ts`: the Apply/Cancel choice overlay behind Model… and Reasoning….
- `statuses.ts`: opaque status entries and the reader component.
- `metrics.ts`: session usage aggregation and bounded append catch-up.
- `format.ts`: pure formatting, cache telemetry, and width-shedding composition
  with the control and count spans used for hit-testing.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

From the repository root, run the focused statusline tests:

```bash
node --test extensions/statusline/*.test.mts
```

See [repository instructions](../../AGENTS.md) for the full development gates.
