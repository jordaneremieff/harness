# policy

The policy extension records paired tool calls and outcomes against fixed
built-in shell rules and operator-approved local rules. It also runs the one
mechanism selected for the session.

Built-ins remain fixed in code. Local rules are stored on the machine, but an
entry affects no call until the operator approves it. The agent-facing tools can
only submit an inert proposal or read the registry. Only `/policy` command and
panel actions can approve, reject, change state, or change effect.

No mode changes a tool input. Every mode records.

## Modes

`--policy-mode` accepts `observe`, `notice`, `annotate`, and `enforce`. It
overrides `PI_POLICY_MODE`; an omitted or blank environment value defaults to
`observe`. The session resolves its mode once and keeps it.

| Mode | Built-in and local behavior |
|---|---|
| `observe` | Record matched ids and apply no mechanism. |
| `notice` | Record, then show a TUI warning containing all matched ids. No model-visible text is added. |
| `annotate` | Record, then append guidance for matched built-ins and active local rules to a successful result. |
| `enforce` | Block every built-in match and every active local rule whose effect is `block`. An active local `steer` match never blocks and is annotated after a successful call. |

A call matching both blocking and steering local rules is blocked. Its reason is
assembled from the blocking built-ins first and blocking local entries second.
Local slugs are sorted before they join the built-in ids in `classes`.

Guidance is prefixed with `[policy]`, deduplicated by text, terminal-safe, and
limited to 512 UTF-8 bytes. Only complete guidance notes are included; when the
next note does not fit, it remains available for a later result. One rule id is
annotated at most once per session. Failed calls are not annotated. In `enforce`, a block is returned only after the
record writer reserves a queue slot.

An unknown mode reports one configuration failure and stops the policy slice for
the session.

## Local registry

The registry is `<policy-dir>/rules.jsonl`, beside daily telemetry files. It is
append-only JSONL: no action rewrites or removes an earlier line. A later valid
event supersedes earlier content during reduction.

Filesystem contract:

- policy directory mode `0700`, owned by the current user, and not a symbolic
  link;
- registry file mode `0600`, owned by the current user, regular, and opened with
  `O_NOFOLLOW` where available;
- one checked `O_APPEND` write per event;
- registry size at most 4 MiB;
- one event line at most 64 KiB;
- reduced snapshot at most 256 rules and 256 pending proposals.

The reader caches a snapshot until `dev:ino:size:mtimeMs` changes. A missing file
is an empty healthy registry. Every nonempty line must be the current event
shape. A malformed JSON line, unknown event kind, invalid field, non-private
path, foreign owner, incomplete final line, or exceeded bound invalidates the
whole snapshot. There are no older-shape readers.

No registry I/O runs at `session_start`. The first tool call, `/policy` command,
agent tool, or panel use loads it lazily.

### Event schema

```text
proposal {kind:"proposal", id:uuid, operation:"upsert"|"discard",
          slug, reason, candidate?, audit}
decision {kind:"decision", id:uuid, proposalId,
          decision:"approved"|"rejected", effect?:"steer"|"block", audit}
state    {kind:"state", id:uuid, slug,
          state:"active"|"disabled"|"discarded", audit}
effect   {kind:"effect", id:uuid, slug, effect:"steer"|"block", audit}

audit    {at:ISO-8601, session, model:"provider/id"|null,
          surface:"agent-tool"|"command"|"panel"}
```

An upsert proposal carries:

```text
candidate {slug, note, match, suggest?, scope?}
```

`note` is required plain-language guidance. `suggest`, when present, is rendered
as `Suggested form: <command> <flags>.` after the note.

Slugs are at most 80 characters and match
`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`. They cannot begin with `routing.`,
`form.`, or `bounds.`, which are reserved for telemetry ids built into the
extension. Notes are at most 2000 characters; reasons at most 1000; commands at
most 200; lists at most 64 entries; and absolute working-directory prefixes at
most 500 characters. The rendered local guidance (note plus suggested form) is
also limited to 400 UTF-8 bytes. An upsert exceeding that rendered bound is
rejected before its proposal is appended, with the actual size and bound in the
error.

### Reduction and authority

- A proposal creates one pending entry. A slug can have only one pending
  proposal at a time. Pending entries never match.
- Approval of an upsert requires the operator to choose `steer` or `block`. It
  creates a new active rule or replaces an existing active/disabled rule's
  candidate content. Content does not change before approval.
- Rejection removes the pending entry and changes no rule.
- Approval of a discard accepts no effect and marks the rule discarded.
- A direct operator state event can set active, disabled, or discarded. An
  operator effect event can set steer or block. Direct discard is refused while
  that slug has a pending proposal; resolve the proposal first.
- Disabled and discarded entries never match. Discarded is terminal: state and
  effect cannot change, and its slug cannot be reused.
- Decisions with no pending proposal and state/effect events with no retained
  rule are ignored by reduction and rejected before write by the registry API.
- Decision, state, and effect events from `agent-tool` do not apply.

Only active rules enter matching and telemetry. Operator lists show active and
disabled retained rules; the terminal marker remains in the reduced registry so
the slug cannot return. `/policy show <slug>` can still show that marker when the
slug is supplied directly.

## Match grammar

Local matching applies only to the `bash` tool and uses the same unmodified
`input.command` text read once for built-in classification. It calls the shell
shape parser; it does not expand variables, aliases, globs, generated words, or
shell data.

```text
match {
  command,
  flags?,
  absentFlags?,
  operands?: {min?, max?, any?, at?: {index: [allowed values]}},
  pipe?: {from?, to?, fromRedirect?, toRedirect?, next?, later?}
}
```

A statement matches when any stage satisfies every supplied constraint:

- `command` equals the stage command basename.
- Every `flags` entry occurs exactly in stage arguments.
- No `absentFlags` entry occurs in stage arguments.
- Operands are stage arguments not beginning with `-`. `min` and `max` bound
  their count, `any` requires one listed value, and `at` maps zero-based operand
  indexes to allowed values.
- `from`, `to`, `fromRedirect`, and `toRedirect` must equal the parser's boolean
  for that stage.
- `next` requires the immediately following stage in the same statement to have
  a listed command.
- `later` requires any later stage in that statement to have a listed command.

A command name only inside a variable value or comment does not match. Parsed
nested command substitutions are their own statements and can match by shape.

Optional scope is:

```text
scope {modelProviders?, models?, cwdPrefixes?}
```

`modelProviders` matches exact model provider identifiers such as
`openai-codex`. `models` matches exact `provider/id` strings such as
`openai-codex/gpt-5.6-sol`. `cwdPrefixes` contains absolute directory paths and
uses string prefix matching against the call's working directory. Scope only
restricts the session context; it does not select a command or tool.
`match.command` selects the command. Missing scope or missing fields are
unconstrained.

## Agent tools

### `policy_propose`

Submits one pending proposal with audit surface `agent-tool`.

- `operation:"upsert"` requires `slug`, `reason`, `note`, and `match`; optional
  `suggest` and `scope` use the grammar above.
- `operation:"discard"` permits only `slug` and `reason`.

Every object schema rejects unknown properties. The tool has no approval,
rejection, state, or effect parameter. Success returns the pending proposal id
and explicitly states that the proposal is inert. Validation, including the
400-byte rendered-guidance check, and registry failures leave the file unchanged
and return an actionable error.

### `policy_rules`

Read-only. It prints the current session context followed by bounded,
terminal-safe registry rows:

```text
SESSION CONTEXT
model provider: openai-codex
model: openai-codex/gpt-5.6-sol
cwd: /absolute/current/working/directory

LOCAL RULES
slug | state | effect | note

PENDING PROPOSALS
proposal-id | operation | slug | reason

registry health: ok
```

When the session has no model, both `model provider` and `model` print
`(none)`. Empty local-rule or pending-proposal sections also print `(none)`. An
unreadable registry prints `registry health: unreadable: reason` in the existing
health-line format. It writes no audit event.

## Operator gates

`/policy` without arguments opens the panel in TUI mode. Text verbs work in
other modes:

- `/policy list` prints built-in groups, local retained rules, pending
  proposals, and registry health.
- `/policy show <ref>` resolves a built-in id, local slug, or pending proposal
  id. Local detail includes content, state/effect, whether scope matches the
  current session (and the first excluding field when it does not), proposal id,
  and proposed, approved, and updated audit fields. Pending detail includes
  reason, audit, and the upsert candidate.
- `/policy approve <proposal-id> <steer|block>` approves an upsert.
- `/policy approve <proposal-id>` approves a discard.
- `/policy reject <proposal-id>` rejects a pending proposal.
- `/policy state <slug> <active|disabled|discarded>` changes retained state.
- `/policy effect <slug> <steer|block>` changes retained effect.
- `/policy mode` reports the session mode and source.
- `/policy help` prints usage.

Command writes carry audit surface `command`. Completion includes bounded verb,
reference, proposal, slug, state, and effect choices from the latest loaded
snapshot.

### Panel

`v` cycles **Rules → Local → Activity**. Rules and Activity retain their prior
rendering and bounded readers. The Local view lists pending proposals first,
then retained rules, with a full detail pane. Retained detail reports whether
scope matches the current session and names the first excluding field. Registry
errors are shown in that view.

| Key | View | Action |
|---|---|---|
| `↑` / `↓` | all | Move selection |
| `b` / `space` | all | Page detail backward / forward |
| `v` | all | Cycle view |
| `g` | Rules | Expand/collapse a built-in group |
| `/` | Rules, Local | Filter rows; Enter or Escape leaves entry |
| `a` / `x` | Local pending row | Approve / reject |
| `s` / `e` | Local retained row | Set state / effect |
| `Escape` | all | Close |

For an upsert approval the host first selects steer/block, then confirms. A
discard approval confirms without an effect. Rejection confirms. State selection
offers active/disabled/discarded and confirms the terminal choice. Effect
selection offers steer/block. Actions use an injected host outside rendering,
write audit surface `panel` at action time, reload the snapshot after success,
and show a one-line outcome or failure.

## Rule composition procedure

This is an operator-directed procedure, not an automatic lifecycle:

1. The operator provides the rule hint and decides that a local rule should be
   considered.
2. The current session packages only bounded, redacted context needed to express
   the command shape and desired plain-language note.
3. A clean-context agent composes the candidate and calls `policy_propose`.
4. The entry remains pending and inert.
5. The operator inspects it and uses a command or panel gate. Only approval
   introduces or changes behavior, and the operator chooses steer or block.

There are no automatic state changes at session start or elsewhere. Repeated
observations never change authority.

## Telemetry and built-ins

Every completed call writes the existing daily
`<policy-dir>/YYYY-MM-DD.jsonl` record. Local slugs follow built-in ids in the
`classes` array, so existing fire summaries and Activity rows count them without
a second telemetry format. Daily readers only accept the daily filename regex;
`rules.jsonl` is invisible to them.

Records retain the existing fields for timestamps, session facts, model,
thinking level, project context, tool/call identity, duration, output bytes,
truncation, error kind, tokens, policy mode, classes, redacted shell text, and
mechanism effects. Result text is never stored.

The shell built-ins remain the `routing.*`, `form.*`, and `bounds.*` definitions
in `shell-rules.ts`. Their parser and enforcement behavior are unchanged. The
shell reader handles statements, pipelines, quotes, redirects, heredocs, and
nested substitutions to a fixed depth. Built-in guidance remains fixed in code.

## Privacy, bounds, and failures

Only the shell domain reads an input field, `input.command`. Stored command text
uses the existing bounded best-effort redactor for recognized credentials,
headers, secret flags, URL credentials, private keys, bearer values, signed
parameters, known key shapes, JWTs, and opaque base64 shapes. Local matching
uses the same transient pre-redaction string as built-in classification; it is
not copied into `rules.jsonl`.

Registry output, command output, tool output, and panel fields are terminal-safe
and bounded. Guidance remains capped at 512 bytes. Telemetry fire scans read at
most 4 MiB. Activity reads at most 4 MiB and returns at most 200 matched records.
The record queue remains bounded at 512 entries.

A local registry read failure disables local matching for the rest of the
session and emits one warning with the reason. Built-in recording and mechanisms
continue. `policy_rules`, `/policy`, and the panel expose registry health;
`policy_propose` cannot write through an unreadable snapshot. Missing registry
files are healthy and empty.

Telemetry writer failures keep their existing behavior: the first failure stops
recording and all mechanisms for the session, reports once, and fails open at a
tool boundary. Browser failures do not stop telemetry. A block already returned
before a later disk failure can still lose its record.

## Configuration

| Setting | Purpose |
|---|---|
| `PI_POLICY_DIR` | Shared record/registry directory; default `<agentDir>/policy` |
| `--policy-mode` | Session mechanism; overrides `PI_POLICY_MODE` |
| `PI_POLICY_MODE` | `observe` (default), `notice`, `annotate`, or `enforce` |

The directory override must name a trusted private directory. No other path or
credential setting is used.
