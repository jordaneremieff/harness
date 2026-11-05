# statusline: quiet two-line session footer

This extension replaces Pi's default footer with a two-line statusline for
long-running agentic sessions. Line 1 carries the session's route identity and
metrics; line 2 carries the project context and whatever extension statuses
other extensions publish through `ctx.ui.setStatus()`. The footer shows status
only: it adds no navigation labels and no menu. The statusline also owns three
views of the shared browsing frame below the native transcript
(`docs/conventions/operator-panels.md`): Commands, Model, and Statuses. Each
view opens on its own from its command. `/dashboard` shows every published
view, including other extensions' views, as tabs of one frame.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| footer | `ctx.ui.setFooter` | Two-line statusline, installed on `session_start` in TUI mode only. |
| `/statusline` | command | Toggle between the custom statusline and Pi's default footer. |
| `/commands` | command | Open the Commands view: every command, prompt template, and skill, searchable. |
| `/model-reasoning` | command | Open the Model view: this session's model and reasoning in one form. |
| `/statuses` | command | Open the Statuses view: the complete extension status map. |
| `/dashboard` | command | Open every published view as tabs of one frame, starting at the first. |
| model and level segments | footer click targets | In fullscreen, a click on the `provider/model` segment or its `[level]` bracket opens the Model view. |
| `+N` cell | footer click target | In fullscreen, the hidden-status count opens the Statuses view. |

No extension-specific configuration is required. The custom footer starts
enabled; use `/statusline` to switch to Pi's default footer or back. With the
footer disabled, each command still opens its view; Statuses then explains
that it needs the statusline footer. There are no tools, timers beyond one
footer-owned tick, or background work.

## Footer clicks

In fullscreen, two parts of the footer take a plain left click: the
`provider/model` segment or its `[level]` bracket opens the Model view, and
the `+N` cell opens the Statuses view. Every other click stays with Pi, so
drag selection keeps working. A click reported for another width acts on
nothing. In regular mode the mouse belongs to the terminal and the footer
claims no click.

## Views

All three views run in the shared frame. Escape leaves a nested view, then the
frame; Pi then restores the editor and its draft.

### Commands

A searchable list of `pi.getCommands()`: extension commands, prompt templates,
and skills under their exact invocation names, including collision suffixes
such as `review:1`. Pi's `sourceInfo` is the provenance shown for each entry;
ownership is never inferred from names or paths. Builtin interactive commands
such as `/model` are not in that inventory and are not offered. The list
filters as you type, matching every query word against the name or
description; the detail shows the description, the kind, the source path, and
any unsent arguments. Selection never runs anything.

- **Run** and **Run with arguments…** (extension commands): the frame closes
  first, so the command's own UI can open. The exact registration is then
  compared field by field; only a still-present, unchanged registration is sent
  through `pi.sendUserMessage("/name args", { expandPromptTemplates: true })`.
  Pi runs extension commands immediately, even while the agent is busy, without
  a model acknowledgement. A registration that disappeared or changed is
  refused with a notification, so a stale selection never becomes a model
  prompt.
- **Put in editor…** (prompt templates and skills): the invocation text is
  prepared in the editor, never sent. An empty editor receives it directly.
  With a draft, the form asks for the placement: *Insert at the cursor* pastes
  through Pi's paste handling and keeps the draft; *Replace the draft* keeps
  the removed draft recoverable through **Restore replaced draft** in
  Commands.
- The query, the selection, and typed arguments survive closing and reopening
  within the session.

### Model

One staged form for this session's model and reasoning. **Model** lists
`ctx.modelRegistry.getAvailable()` as `provider/model-id` rows with the display
name, filtered as you type, the current model preselected; Up and Down stage a
model. **Reasoning** lists the levels `getSupportedThinkingLevels(model)`
reports for the staged model; a model without reasoning offers none. **Apply**
calls `pi.setModel(model)` when the model changed, for this session only; a
`false` return (authentication not configured for the provider) is shown as a
refusal with the staged fields kept. It then calls `pi.setThinkingLevel(level)`,
which clamps to the model. Cancel and Escape change nothing. No builtin slash
text is sent to the model to emulate these controls.

### Statuses

Every entry of `footerData.getExtensionStatuses()`, with the owner key as the
label and the value as opaque text: terminal sequences removed, control
characters spaced, nothing parsed and no severity inferred. The list rereads
the map on every paint. The view needs the installed statusline footer, which
supplies the status provider; with the footer disabled, it says so.

### Frame size

The frame sits in the editor slot and takes most of the window while keeping
transcript rows above it: at most 60% of the rows and six rows fewer than the
window, at least eight. **Expand** gives it all but four rows; **Shrink**
returns. Every view reads its row budget on each render, so the action bar and
the way out stay on screen when the terminal shrinks. A pointer event reported
for another size acts on nothing. Session shutdown closes an open frame without
dispatch.

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
segments in order (cache rate, cache dot, duration, token count, then cost),
keeping the model and context bar to the end. Line 2 first shortens the folder
from the left with an ellipsis, preserving its last path component, then shortens
the branch with an ellipsis or omits it. If necessary, it also shortens the last
path component from the left. Only when complete extension statuses
still do not fit with a one-character project label does it drop statuses from
the right. A `+N` cell reports how many statuses are hidden. At extreme widths,
the count takes priority over the project label and separator, and a truncated
count is not a click target. Both lines remain unchanged when all segments fit.
`truncateToWidth` is the final guard on both lines.

## Line 2: project + git + extension statuses

The project label is the home-relative working directory
(`~/work/app`, following Pi's footer convention) plus the git branch from
`footerData.getGitBranch()`. Extension statuses come from
`footerData.getExtensionStatuses()`, the supported host surface through
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
to spaces, whitespace collapses, and input is cut to 512 characters, a cap
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
  `ctx.hasUI`. The view commands explain the requirement outside the TUI.
- One 5-second interval owns wall-clock freshness: Pi re-renders only on
  events, so without it the duration would go stale while idle. The tick is
  `unref`'d (it cannot hold the process open) and is
  cleared on footer `dispose()`, on `session_shutdown`, and before any
  reinstall, so toggling or reloading can never accumulate intervals.
- Branch changes re-render through `footerData.onBranchChange`.

## Files

- `index.ts`: registration, the footer factory, the pointer targets, tick
  ownership, the publication of this owner's views, and the
  `/statusline`, `/commands`, `/model-reasoning`, and `/statuses` commands.
- `views.ts`: the Commands, Model, and Statuses views in the shared frame.
- `commands.ts`: editor placement for prompt templates and skills.
- `metrics.ts`: session usage aggregation and bounded append catch-up.
- `format.ts`: pure formatting, cache telemetry, and width-shedding composition
  with the model and count spans used for hit-testing.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

From the repository root, run the focused statusline tests:

```bash
node --test --test-timeout=30000 extensions/statusline/*.test.mts
```

See [repository instructions](../../AGENTS.md) for the full development gates.
