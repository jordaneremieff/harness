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
| `agent` | `extensions/agent` | Manager-local ordinary hosts, including nested ordinary hosts, and their separate subagent subtrees. Native spend starts at ownership; historical entries are excluded. | `agents: 2 active · $0.37 local · subs 1/$0.12`; missing evidence adds `+?`. Detached records appear separately with `$?`. | Last primary shutdown, including reload. Observed idle spend remains until that manager closes. |
| `subagent` | `extensions/subagent` | Current session's subagent-only subtree: executing local workers plus cumulative observed worker spend. Idle/paused hosts are not active. Terminal spend remains visible. | `subagents: 2 active · $0.37`; `subagents: 0 active · $0.37` after completion. Missing usage/owner evidence adds `+?`. | When the subtree has neither workers nor evidence to show, and on `session_shutdown`. |

## Nested work snapshots

The package owns this contract over Pi's public `EventBus`. The current
producer is the subagent extension; the consumer is an ordinary-session host
in the agent extension. Neither participant imports the other or reads its
store. Status text remains presentation only.

A consumer subscribes to `harness:work-status:snapshot` before session startup.
It requests a snapshot through `harness:work-status:request` with:

```ts
{ version: 1, publisher: "subagent", sessionId: string }
```

The producer answers synchronously on that same session's bus and publishes replacements
when its records or live ownership change:

```ts
{
  version: 1,
  publisher: "subagent",
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

A subtree starts with workers whose owner is `sessionId`, then follows only
subagent-owned worker-session edges. Each worker occurs once. It excludes
ordinary agents and subagent roots owned by those ordinary agents. Thus the
primary's subagent subtree and every ordinary host's subagent subtree are
disjoint, even for mixed agent/subagent depth. Ordinary hosts share one agent
manager per store; their native costs appear once in that manager's `agent`
status, independent of which primary initiated them.

On teardown the producer publishes `{ version: 1, publisher: "subagent",
sessionId, available: false }` and removes its request listener. This means
live observation ended, not zero cost. The consumer retains the last known cost
and marks the source unavailable. Absence, invalid payloads, and unsupported
versions do not establish zero work. No polling, retry queue, persistence,
model context, or authority transfer belongs to this contract.

The consumer establishes a cost baseline from the first available snapshot at
ownership startup, excluding old retained worker spend. Later snapshots replace
the current difference from that baseline. Worker reload retains that baseline;
session replacement retains the prior observed difference and starts a fresh
baseline. An absent initial snapshot leaves an explicit gap. The first later
snapshot supplies a comparison baseline; subsequent increases add known spend,
but the gap remains. Later data never retroactively establishes zero spend for
the unobserved interval. Decreasing
reported totals retain known spend and mark the observation incomplete. The
consumer unsubscribes at host close. Primary shutdown closes the
manager; primary reload therefore starts a fresh observation interval. Each
primary attached to the same manager sees the same explicitly local scope.

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
