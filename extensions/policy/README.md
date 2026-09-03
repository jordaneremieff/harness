# policy

`policy` records paired tool calls and outcomes, evaluates one unified rule
aggregate, and applies the mechanism selected for the session. Package rules and
operator-approved local rules are both `RuleRecord`s reduced from one private,
append-only `rules.jsonl` event log.

There is no second built-in/local dispatch path. A record carries:

- immutable `id`, source (`package` or `local`), domain, and matcher;
- a versioned definition (`active|retired`, `steer|block`, note, optional
  suggestion and scope);
- at most one complete operator override slot;
- derived matcher availability and stale-override status.

Package matchers name installed code predicates. Local matchers use the closed
`command-shape/v1` declarative language. For every package record, `id` and the
code `matcher.key` are distinct fields with the enforced invariant that their
values are equal.

The agent can read rules and submit inert proposals. Only the `/policy` command
and eligible panel actions exercise operator gates. No mode rewrites tool input,
no observation changes authority, and every mode records.

## Modes and dispatch

`--policy-mode` accepts `observe`, `notice`, `annotate`, and `enforce` and
overrides `PI_POLICY_MODE`. An unset or blank environment value defaults to
`observe`. The mode is resolved once per session.

| Mode | Effective behavior |
|---|---|
| `observe` | Record matched ids; apply no mechanism. |
| `notice` | Record and show a terminal warning for a matched call in TUI mode. No model-visible text is added. |
| `annotate` | Record and append bounded guidance to an eligible successful result. |
| `enforce` | Block when any matched record has effective effect `block`; otherwise annotate matched effective `steer` records after success. |

One call uses this order:

1. On first policy use, synchronize the package catalog, then load and reduce the
   registry.
2. Capture `bash` command text once.
3. Select records whose definition/override gives effective state `active`,
   whose matcher is available, and whose scope admits the session.
4. Only then resolve a package predicate or enter declarative matching.
5. Compute the call's effective mechanism once from that candidate set, its
   effective effects, the session mode, and registry health.
6. Record the same matched ids and the redacted form of the same capture.

Matched package records retain installed catalog order. Matched local records
follow, sorted by id. Telemetry classes, guidance, and block reasons all use
that same order.

Thus a disabled, retired, unavailable, or out-of-scope package record cannot
invoke its predicate. Declarative records never dispatch through the package
predicate registry.

Guidance is prefixed with `[policy]`, deduplicated by rendered text, and limited
to 512 UTF-8 bytes. A rule id is annotated at most once per session. Failed calls
are not annotated. In `enforce`, a block is returned only after the telemetry
writer reserves capacity for its record.

If the rule store is degraded, installed package defaults are used in memory and
any mechanism stronger than notice is capped at notice. `observe` still applies
no mechanism. This avoids either trusting unreadable operator state or silently
turning package guidance into a block.

## Unified event log

The registry is `<policy-dir>/rules.jsonl`, beside daily telemetry files. Every
complete line is exactly one current-shape event. Later events supersede earlier
ones during reduction; no operation rewrites history.

### Event shapes

```text
catalog {
  kind:"catalog",
  rows: PackageDefinitionRow[],              // complete installed set
  audit:{surface:"package"}
}

proposal {
  kind:"proposal", id:uuid,
  operation:"add"|"retire"|"disable",
  ruleId, reason, candidate?,
  audit:SessionAudit(surface="agent-tool")
}

decision {
  kind:"decision", id:uuid, proposalId,
  decision:"approved"|"rejected", effect?:"steer"|"block",
  audit:SessionAudit
}

override-set {
  kind:"override", id:uuid, ruleId, operation:"set",
  override:{
    state?:"disabled", effect?:"steer"|"block",
    reason, audit:SessionAudit, againstDefinitionRevision
  }
}

override-clear {
  kind:"override", id:uuid, ruleId, operation:"clear",
  reason, audit:SessionAudit
}

definition {
  kind:"definition", id:uuid, ruleId, state:"retired",
  reason, audit:SessionAudit
}

SessionAudit {
  at:ISO-8601, session, model:"provider/id"|null,
  surface:"agent-tool"|"command"|"panel"
}
```

Objects are closed: unknown fields, missing fields, unknown enum values, invalid
identifiers, malformed audits, and over-bound values reject the complete line.
There is no old-format or migration reader.

A package row contains `id`, domain `tool-call`, code matcher, default effect,
note, optional suggestion/scope, and a canonical 12-hex definition revision.
The revision identifies canonical definition content; it is not an event-log
integrity digest. A local add candidate contains domain `tool-call`, a
declarative matcher, note, and optional suggestion/scope. Its id is the
proposal's `ruleId`.

Identifiers are at most 80 characters and match
`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`. Notes are at most 2,000 characters,
reasons at most 1,000, commands at most 200, lists at most 64 entries, and
absolute cwd prefixes at most 500 characters. Rendered local guidance is at
most 400 UTF-8 bytes. The file is at most 4 MiB and each event line at most 64
KiB. The aggregate retains at most 256 local records and 256 pending proposals;
package rows do not count toward the local-record limit.

### Catalog synchronization

No registry I/O occurs during extension registration or `session_start`. The
first tool call, `/policy` command, `policy_rules`, or `policy_propose` performs
catalog synchronization.

A catalog event carries the complete installed package row set. Reduction makes
every row in the latest catalog event an active package definition and marks
every previously stored package definition absent from that event `retired`.
Overrides remain attached across change, removal, and reintroduction. Sync
appends only when the active installed set differs by id/content revision from
the reduced stored set. Concurrent first-use synchronizers can append duplicate
catalog events, but their payloads are content-identical and reduction is
idempotent.

If an installed package row has the same id as a retained local record,
reduction and both in-memory catalog paths retain the local record and skip the
package row. The registry remains healthy and writable. Its non-degraded health
line names every colliding id, and `/policy show` marks the retained local
record as a catalog collision, so the condition is visible without inspecting
the event log.

A package update never silently clears an override. The override records its
target definition revision; a later definition revision makes
`staleOverride=true` while preserving and continuing to report the slot.

### Proposals, decisions, and direct authority

- One rule id can have at most one pending proposal. Pending proposals are inert.
- Add is allowed only when the id has never been taken. Operator approval
  requires `steer` or `block` and creates one active local definition.
- Rejection removes the pending proposal without changing a record.
- Approved retire marks an existing local definition retired and forbids an
  effect argument.
- Approved disable creates a complete override slot for any existing record,
  preserving an existing effect override, setting state `disabled`, taking the
  proposal reason and decision audit, and targeting the current definition
  revision.
- Approval of a retire or disable proposal is refused if its target has already
  retired. A definition revision change alone does not invalidate approval;
  disable approval targets the current revision, and a later revision is
  reported through `staleOverride`.
- Direct disable/enable/effect are allowed for package and local records.
  Direct definition retirement is local-only.
- Decision, override, and definition events with audit surface `agent-tool` are
  ignored defensively by reduction and refused by the sanctioned writer.

Retirement does not free an id. Package definitions can return only through a
later package catalog; local definitions do not have an unretire operation.

### One complete override slot

The override slot is replaced as one unit. Writers compose the complete intended
slot from the current reduced record and requested change:

- `disable` sets `state:"disabled"` and preserves an existing override effect;
- `effect` sets the effect and preserves an existing disabled state;
- `enable` removes the disabled state, preserving an effect if present;
- if `enable` leaves no state or effect, it writes a clear, which removes the
  entire slot.

Every set carries one reason, operator audit, and the current definition
revision. Every clear also requires a reason and operator audit. Consequently
the reduced slot has the reason from the most recent override event, while the
append-only log retains the full sequence.

## Store health and filesystem contract

The policy directory must be a current-user-owned, non-symlink directory with
mode `0700`. The registry must be a current-user-owned regular file with mode
`0600`; reads and writes use `O_NOFOLLOW` where available. Each event uses one
checked `O_APPEND` write.

A missing registry is healthy and synchronizes normally. An incomplete final
line is treated as an append in flight: all complete lines are reduced, the
suffix is skipped and reported once with path and line, and writes are refused
until it completes or is repaired. It does not mark health degraded.

Any malformed **complete** line, invalid path/permissions/owner, exceeded bound,
or reduction invariant failure latches degraded health for that policy session:

- use only installed package defaults in memory;
- name the malformed or invariant-causing line, or name the failing filesystem
  property for a file-level failure;
- expose the same repair state through command, panel, and tool surfaces;
- set telemetry `ruleStoreDegraded:true`;
- refuse every rule write;
- cap mechanisms at notice.

For a line failure, the repair says that the file is append-only JSONL with one
event per line and instructs the operator to edit or remove the named line. For
a file-level failure, it gives the concrete property repair, such as restoring
the private mode. After repair, start a new policy session. The implementation
intentionally has no locks, event digests, monotonic revision
counter, stale-process guard, lockdown mode, or migration reader. Duplicate
whole catalog events and an incomplete final line are the only concurrency
accommodations.

## Declarative command-shape matching

Local rules apply only to `bash` and use the existing bounded shell shape parser.
They do not expand aliases, variables, globs, generated words, or shell data.

```text
matcher {
  kind:"declarative", language:"command-shape/v1",
  spec:{
    command,
    flags?, absentFlags?,
    operands?:{min?, max?, any?, at?:{index:[allowed values]}},
    pipe?:{from?, to?, fromRedirect?, toRedirect?, next?, later?}
  }
}
```

A statement matches when one stage satisfies every supplied constraint:

- `command` equals the stage command basename;
- every `flags` value occurs literally and no `absentFlags` value occurs;
- operands are arguments not starting with `-`; `min`/`max` bound count, `any`
  requires one listed operand, and `at` maps zero-based indexes to allowed
  values;
- pipe/redirect booleans equal the parser facts exactly;
- `next` constrains the immediate next stage, while `later` permits any later
  stage in the same statement.

Nested command substitutions are parsed as separate statements. A command name
inside a comment or variable value does not match.

Optional scope is:

```text
scope {modelProviders?, models?, cwdPrefixes?}
```

Provider and `provider/id` model matches are exact and case-sensitive.
`cwdPrefixes` entries must be absolute and use string-prefix matching. Missing
scope dimensions are unconstrained. Scope filters session context only;
`matcher.spec.command` selects the command.

## Agent tools

### `policy_propose`

Submits one inert proposal with audit surface `agent-tool`:

- `operation:"add"` requires `id`, `reason`, `note`, and `match`; optional
  `suggestion` and `scope` use the forms above;
- `operation:"retire"` permits only `id` and `reason`;
- `operation:"disable"` permits only `id` and `reason`.

The emitted schema has top-level `type:"object"` plus closed `anyOf` arms, and
every nested object schema is also closed. This keeps object-only providers
compatible without weakening each operation's required fields. The tool exposes
no effect, enable, approve, reject, override, or direct-retirement authority.
Success returns the proposal id and explicitly says it remains inert pending
operator approval.

### `policy_rules`

Read-only. It prints exact current provider/model/cwd values, every package and
local record, pending proposals, and registry health. Each record reports
provenance, matcher kind/key or language, effective state/effect, override
reason and audit, stale status, matcher availability, and note. Empty sections
print `(none)`.

## Operator command

`/policy` opens the panel. Text forms are:

```text
/policy list
/policy show <id-or-proposal-id>
/policy approve <proposal-id> <steer|block>   # add; effect required
/policy approve <proposal-id>                 # retire/disable; effect forbidden
/policy reject <proposal-id>
/policy disable <id> <reason...>
/policy enable <id> <reason...>
/policy effect <id> <steer|block> <reason...>
/policy retire <local-id> <reason...>
/policy mode
/policy help
```

All direct changes require a nonblank reason. Command decisions and changes use
audit surface `command`. Completion is token-aware: `show` offers rule and
proposal ids; gate verbs offer pending proposal ids; direct state-changing verbs
offer eligible rule ids; and add approval and `effect` offer `steer` and `block`
in their value position.

Every command result and refusal has a mode-appropriate operator-visible path:

- TUI and RPC use `ctx.ui.notify`, with information/error severity preserved.
- JSON appends a `policy_command` custom entry whose data is `{text}`. Pi emits
  that non-context entry as an `entry_appended` JSON frame and persists it with
  the session when session persistence is enabled.
- Print mode writes successful text through `process.stdout` and refusals through
  `process.stderr`. Pi's noninteractive output guard routes extension stdout to
  the terminal's stderr stream so Pi retains ownership of result/protocol
  stdout.

No entry renderer is registered. Entry renderers are TUI-only, while this
extension appends `policy_command` entries only in JSON mode and already uses
notifications on UI-capable command paths.

## Panel

`v` cycles **Rules → Proposals → Activity**. The Rules list is one unified list;
detail shows definition/source/matcher, effective state/effect, scope visibility,
override reason and full audit, staleness, matcher availability, and total/per-
model fire counts. Proposals show complete candidate and proposal audit.
Activity includes the telemetry health bit.

| Key | View | Action |
|---|---|---|
| `↑` / `↓` | all | Move selection |
| `b` / `space` | all | Page detail backward / forward |
| `v` | all | Cycle view |
| `/` | Rules, Proposals | Filter |
| `a` / `x` | Proposals | Approve / reject |
| `d` / `n` / `e` / `r` | Rules | Disable / enable / effect / local retirement |
| `Escape` | all | Close |

Every panel approval and rejection requires confirmation before the registry
call. Add approval first selects `steer` or `block`, then confirms the chosen
effect. Successful decisions write audit surface `panel`; a cancelled selection
or declined confirmation writes nothing. The panel is an overlay that hides and
then refocuses around Pi's selector-backed prompts so the panel remains usable.

Reason-bearing actions display their exact `/policy ... <reason...>` command
instead of nesting `ctx.ui.input`. In installed Pi 0.84.4, the interactive input
implementation clears the custom component from `editorContainer` and restores
the default editor when input closes; it does not restore the still-open custom
panel. The command fallback avoids orphaning panel focus and preserves the same
operator gate and override composition through audit surface `command`.

## Telemetry, privacy, and bounds

Completed calls append the existing private daily
`<policy-dir>/YYYY-MM-DD.jsonl` records. `classes` lists matched package ids in
catalog order followed by matched local ids sorted by id. Every new record
explicitly includes `ruleStoreDegraded`; old rows
without the field display as false in Activity. `rules.jsonl` does not match the
daily filename pattern and is never treated as telemetry.

Records keep timestamps, session facts, model, thinking level, project context,
tool/call identity, duration, output bytes, truncation, inferred error kind,
tokens, policy mode, classes, redacted shell capture, mechanism effects, and the
rule-store health bit. Tool result text is not persisted.

Only `bash` reads `input.command`. Matching uses its transient pre-redaction
value; `rules.jsonl` never contains observed command text. Telemetry stores the
existing bounded best-effort redaction for recognized assignments, headers,
secret flags, URL credentials, private keys, bearer values, signed parameters,
known key forms, JWTs, and opaque base64 shapes.

Text/tool/panel outputs are terminal-safe and capped. Telemetry fire scans read
at most 4 MiB. Activity reads at most 4 MiB and returns at most 200 matched
records. The telemetry queue remains bounded at 512 entries.

Telemetry writer failure keeps the established fail-open boundary: the first
failure stops recording and all mechanisms for the session, reports once, and
clears pending calls. Browser failures do not stop telemetry. A block already
returned before a later disk failure can still lose its record.

## Configuration

| Setting | Purpose |
|---|---|
| `PI_POLICY_DIR` | Rule/telemetry directory; default `<agentDir>/policy` |
| `--policy-mode` | Session mechanism; overrides `PI_POLICY_MODE` |
| `PI_POLICY_MODE` | `observe` (default), `notice`, `annotate`, or `enforce` |

`PI_POLICY_DIR` must identify a trusted private directory. No other policy path
or credential setting is used.
