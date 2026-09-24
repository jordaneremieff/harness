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
| `agent` | `extensions/agent` | Active manager-local ordinary hosts and each primary's cumulative observed native price. Includes nested ordinary hosts, not their subagent price. | `agents 2 · $0.37`; `agents 0 · $0.00` before work. Missing usage adds `+?`. Nonzero or unavailable detached records add a separate `$?` suffix. | Session shutdown clears the cell. Exact-session checkpoints survive reload; reopen restores saved native files only. Idle and zero stay visible. |
| `subagent` | `extensions/subagent` | Executing subagent workers and cumulative observed price from two disjoint domains: the session's raw subtree and ordinary-host subagent subtrees. | `subagents 2 · $0.37`; `subagents 0 · $0.00` before work. Missing usage/ownership adds `+?` to count and price. | Session shutdown clears the cell. Exact-session checkpoints survive reload; reopen restores saved native files only. Idle and zero stay visible. |

## Nested work snapshots

The package owns this contract over Pi's public `EventBus`. Publishers identify
two disjoint numeric domains. `subagent` publishes its raw subagent-only subtree;
`agent` publishes the aggregate subagent observations from manager-owned ordinary
hosts for the observing primary. The subagent display combines them, but its raw
publication never includes the `agent` contribution. This prevents feedback.
Neither participant imports the other or reads its store. Status text remains
presentation only.

A consumer subscribes to `harness:work-status:snapshot` before session startup.
It requests a snapshot through `harness:work-status:request` with:

```ts
{ version: 1, publisher: "subagent" | "agent", sessionId: string }
```

The producer answers synchronously on that same session's bus and publishes replacements
when its records or live ownership change:

```ts
{
  version: 1,
  publisher: "subagent" | "agent",
  sessionId: string,
  available: true,
  active: number,
  cost: number,
  incomplete: boolean
}
```

`active` is a nonnegative safe integer. It counts executing local workers, not
idle or paused retained workers. `cost` is a finite nonnegative USD estimate
from observed native usage. It includes terminal workers and each worker's
post-fork usage once. `incomplete` marks unavailable usage or ownership evidence;
known spend remains visible and is not an invoice total. Snapshots replace
previous snapshots; they are never additive deltas.

The `subagent` raw subtree starts with workers whose owner is `sessionId`, then follows only
subagent-owned worker-session edges, including prior native session identities
retained on the same worker after replacement. Copied fork ancestry creates no
ownership edge. Each worker occurs once. It excludes
ordinary agents and subagent roots owned by those ordinary agents. Thus the
primary's subagent subtree and every ordinary host's subagent subtree are
disjoint, even for mixed agent/subagent depth. Ordinary hosts share one agent
manager per store; each host appears once in that manager's `agent` active
count, independent of which primary initiated it. Each primary's
cumulative price records only manager changes during its attached intervals,
plus that exact session's saved observations.

On teardown the producer publishes `{ version: 1, publisher: "subagent",
sessionId, available: false }` and removes its request listener. This means
live observation ended, not zero cost. The consumer retains the last known cost
and marks the source unavailable. Absence, invalid payloads, and unsupported
versions do not establish zero work. No polling, retry queue, model context,
or authority transfer belongs to this exchange. Each publisher owns its native
custom checkpoints; consumers neither read nor write another publisher's entries.

An ordinary host's consumer establishes a cost baseline from the first available snapshot at
ownership startup, excluding old retained worker spend. Later snapshots replace
the current difference from that baseline. Worker reload retains that baseline;
session replacement retains the prior observed difference and starts a fresh
baseline. An absent initial snapshot leaves an explicit gap. The first later
snapshot supplies a comparison baseline; subsequent increases add known spend,
but the gap remains. Later data never retroactively establishes zero spend for
the unobserved interval. Decreasing
reported totals retain known spend and mark the observation incomplete. The
consumer unsubscribes at host close. Intentional closure after complete settled
observations does not invent unknown spend. A missing observation at closure
remains incomplete in the checkpoint. Each departing primary clears its own cell.
True shutdown of the last primary closes the manager after final accounting.
Primary reload retains the manager and its price baseline while old UI callbacks
are removed; the fresh runtime binds a new status callback.

Both publishers save meaningful changes through native custom entries, outside
model context. Checkpoints carry the exact native session ID. Same-process reload
retains in-memory checkpoints; reopening restores only a native session file Pi
actually saved. Before the first assistant message, Pi buffers custom entries in
memory without creating the file. The first assistant message flushes the buffered
entries. New sessions and copied forks reject another session's checkpoints.
Restore examines all session entries, not just the selected branch;
tree navigation does not undo incurred cost. A restored primary establishes a
new manager baseline, adding only subsequent observed changes. Separate primaries
retain separate histories. These totals do not reconstruct unobserved intervals
or charge inherited transcript history.

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
