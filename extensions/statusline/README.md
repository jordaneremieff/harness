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
   `tokens/contextWindow`. Shown only when Pi reports a known percentage
   (it is `null` right after compaction). Color ramp: success through 60%,
   warning through 80%, error above. Pi auto-compacts at
   `contextWindow - reserveTokens` (default reserve 16384, ~92% of a 200K
   window), so red leaves roughly a tenth of the window to choose the
   compaction moment deliberately.
3. **Cost.** `~$N.NN` summed over assistant turn usages; hidden below half a
   cent.
4. **Duration.** Wall clock since this process attached to the session
   (reset on every `session_start`, including reload). It is an attach
   clock, not a session-age clock.
5. **Cache telemetry.** Two measured parts: a last-turn hit/miss dot and a
   session hit-rate percentage. See below.

All metrics come from a single pass over `ctx.sessionManager.getBranch()`
per render. The branch is bounded by compaction and the arithmetic is
microsecond-scale at the render rates this extension produces, so there is
deliberately no memoization or incremental accumulator to invalidate. If a
high-frequency render source is ever added (an animation loop, a sub-second
tick), revisit this decision first.

## Cache telemetry

The extension reports only cache usage recorded in assistant turns. It does not
estimate provider cache lifetimes or show a TTL countdown.

- The **dot** reports the most recent cache-active turn: green when it read
  from cache, red when it only wrote. Cache-free turns do not move it.
- The **hit rate** is `cacheRead / (cacheRead + cacheWrite + input)` across
  the branch — the physical share of prompt tokens served from cache. A
  session that warms cache and never reuses it trends toward zero, which is
  the intended reading.

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
sanitizing control characters (stricter than Pi's default footer: all C0
and DEL bytes are stripped, so a hostile or buggy status cannot inject
terminal escapes into the statusline).

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
- `metrics.ts`: pure single-pass session-branch scan.
- `format.ts`: pure formatting, cache telemetry, and width-shedding composition.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
npm test
# full suite passes; statusline coverage in extensions/statusline/*.test.mts
```
