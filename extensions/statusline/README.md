# statusline: two-line session footer

This extension replaces Pi's default footer with a two-line statusline for
long-running agentic sessions. Line 1 carries session metrics; line 2 carries
project context and whatever extension statuses other extensions publish
through `ctx.ui.setStatus()`.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| footer | `ctx.ui.setFooter` | Two-line statusline, installed on `session_start` in TUI mode only. |
| `/statusline` | command | Toggle between the custom statusline and Pi's default footer. |

There are no tools, timers beyond one footer-owned tick, background work, or
configuration overlays.

## Line 1: session metrics

Segments join with a dim `│` separator:

1. **Model + thinking.** `ctx.model.name`, accent-colored, plus a
   `[<level>]` bracket (for example `[high]`) in the per-level theme color. The bracket follows the
   model's declared `reasoning` capability, not a provider-name check:
   providers whose Pi thinking level is inert (for example ACP-bridged
   models, which register `reasoning: false`) simply never show it.
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

Usage metrics come from one pass over `ctx.sessionManager.getEntries()` per
render, like Pi's default footer. This includes abandoned branches and
pre-compaction entries; compaction does not bound retained history. Context
usage comes separately from `ctx.getContextUsage()` and describes the active
model context, not cumulative session usage. No second history store or
incremental accounting cache is maintained.

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
keeping the model and context bar to the end. Line 2 drops extension statuses
from the right and always keeps the project label.
`truncateToWidth` is the final guard on both lines.

## Line 2: project + git + extension statuses

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

- `index.ts`: registration, footer factory, tick ownership, `/statusline`.
- `metrics.ts`: pure single-pass session usage scan.
- `format.ts`: pure formatting, cache telemetry, and width-shedding composition.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
npm test
# full suite passes; statusline coverage in extensions/statusline/*.test.mts
```
