# policy

`policy` is a runtime rule engine for tool checks, input correction, result
correction, bounded behavioral state, guidance, and observation. One extension
owns the event pipeline, rule authority, controls, and records. Domain-specific
facts and corrections are internal implementations, not separate guards.

Package rules and operator-approved local rules share one `RuleRecord` aggregate
reduced from a private, append-only `rules.jsonl` log. The current
`command-shape/v1` language and the general `facts/v1` language use the same
runtime and controls. No script language, dynamic plugin loader, background
service, or sibling-extension protocol is involved.

## Authoring a correction

These examples use a hypothetical `chat_history` tool with a string `room`
argument. Use actual configured tool names and their schemas in live rules.

1. Inspect the available capabilities and exact session scope:

   ```json
   {"view":"capabilities"}
   ```

   Pass this to `policy_rules`. The default view lists rules, pending proposals,
   registry health, and current provider/model/cwd scope values.

2. Add an operator-owned lookup table through the operator command:

   ```text
   /policy data set {"expectedRevision":null,"data":{"name":"rooms","kind":"table","rows":[{"key":"lobby","value":"room-17"}]}}
   ```

   The command supplies omitted source and capture-time metadata, then presents
   the complete normalized artifact for approval. A table without `maxAgeMs` is
   revision-controlled and does not require periodic renewal. No model tool can
   change these bindings.

3. Submit an inert rule through `policy_propose`:

   ```json
   {
     "operation": "add",
     "id": "local.room-id",
     "reason": "Use the approved room identifier before execution.",
     "note": "Resolve room names through the approved table.",
     "language": "facts/v1",
     "program": {
       "phase": "input",
       "selector": {"tools": ["chat_history"]},
       "data": ["rooms"],
       "when": {
         "op": "lookup",
         "path": ["input", "room"],
         "table": "rooms",
         "value": "unique"
       },
       "action": {"kind": "substitute", "path": ["room"], "table": "rooms"},
       "onUnavailable": "skip"
     }
   }
   ```

4. Inspect the complete proposal, then approve its exact revision:

   ```text
   /policy approve <proposal-id> exact <proposal-revision>
   ```

   Approval does not override the session mode. The correction applies only in
   `enforce`; the other modes expose the candidate without applying it.

## Rule model

A record contains its id, source, domain, matcher, definition revision, lifecycle
state, note, optional scope, and at most one complete operator override slot.
Availability and stale-override status are derived rather than separate authority.

Package matchers use installed code predicates or `facts/v1` programs. For code
matchers, the record id and matcher key must be equal. Package catalog changes
retain package-source authority. Local additions and replacements require an
operator decision. An old command-effect override never authorizes correction.

Definition effect families describe actual behavior:

- `block`: denial;
- `steer`: guidance;
- `correct`: input or result correction;
- `observe`: metadata observation.

The `steer|block` effect override applies only to command rules. A facts program's
exact action defines its effect; changing that action requires a replacement
rather than a command-effect override.

### Facts programs

The closed grammar is defined by [program.ts](program.ts). Provider-facing tool
schemas describe one condition level and accept nested condition objects without
recursive schema references. The same shape builders supply the internal recursive
schema. Full local validation checks every nested condition before a proposal is
stored, including closed fields, operators, paths, data bindings, shared node and
depth bounds, and phase/action constraints. Transport acceptance does not grant
approval or bypass these checks.

A program declares:

| Field | Contract |
| --- | --- |
| `phase` | `input`, `result`, `completion`, or `context` |
| `selector` | Optional exact physical tools, logical operations, and a declared argument codec |
| `when` | A bounded three-valued condition |
| `action` | One typed action with complete parameters |
| `onUnavailable` | `skip`, or `deny` for an input rule |
| `inputView` | Optional `original` or `effective`; effective-input checks are denials |
| `data` | Approved named data dependencies |
| `state` | Optional observation condition, reset condition, aggregates, and guidance limits |

Conditions support `all`, `any`, `not`, `eq`, `in`, `exists`, `type`, numeric
comparisons, bounded string comparisons, and exact table lookup status. Paths are
arrays of safe own-property keys, not executable expressions. Unknown evidence
stays unknown under negation and composition. Missing comparison values are not
zero or false; `exists` tests actual property presence separately.

Fact roots include `tool`, `operation`, `input`, `original`, `result`, `outcome`,
`state`, `schema`, `data`, and `context`. Corrections use paths relative to their
argument object, rather than condition paths prefixed with `input`.

Public tool availability is available through
`context.tools.<tool-name>.active` and `.configured`, with
`context.catalogAvailable` and `context.turn`. These facts use Pi's public tool
catalog, not a sibling extension's output. An unavailable catalog is not an empty
catalog presented as proof of absence.

A context rule has no current tool. Its selector qualifies completed observations
for its state, not the later context projection. A context selector therefore
requires observation state. Session scope still applies at projection time.

### Actions

| Action | Phase | Behavior |
| --- | --- | --- |
| `deny` | input | Refuse execution in enforce mode |
| `rename-key` | input | Move a value between approved keys without changing the value |
| `substitute` | input | Replace a value through a unique approved table lookup |
| `assert-error` | result | Assert `isError:true` when the approved condition matches |
| `guide` | result or context | Supply bounded policy guidance |
| `observe` | completion | Add an approved metadata label to the common record |

The engine does not independently establish a domain's meaning of failure. The
rule's approved condition and schema/data contract supply that meaning. Error
assertion never clears an existing error. Heuristic text matches remain
inferences rather than an invented execution status.

There is no arbitrary JSON patch, physical tool rename, redispatch, rule-authored
code, tool invocation, network request, or filesystem-write action.

## Execution contract

Input processing preserves the requested arguments, the validated input received
by policy, and the candidate committed by policy as distinct views.

1. Capture the call's approved rules, data, and public tool metadata.
2. Evaluate original-input prohibitions.
3. Plan logical-target substitutions, key renames, then value substitutions.
4. Validate the complete candidate against the outer and any declared inner
   schemas.
5. Evaluate effective-input prohibitions, including the captured eligible shell
   predicates, before one synchronous input commit.

Each correction stage reads one fixed snapshot. Later stages see earlier
corrections. Rule ids provide stable order within a stage; conflicting writes
invalidate the plan rather than depend on extension load order. An invalid or
conflicting plan does not partially modify the original arguments.

Result corrections precede stateless annotations. Completed-call counters and
records update once at `tool_execution_end`, after the result chain. Calls that
skip `tool_result` still reach this observation path. Partial progress does not
count as a completed outcome.

The record distinguishes successful execution, execution error, confirmed own
policy denial, and unexecuted outcomes whose exact preflight cause is unknown.
`abortRequested` reports the signal separately; it does not prove the cause of an
error. The rule decision is separate from the terminal outcome because Pi can
substitute an abort response after a denial.

`outcome.outputBytes` counts UTF-8 bytes in final execution text content, not
image payloads. `outcome.preGuidanceBytes` measures text at this policy's result
hook before its own guidance. A missing result hook leaves that value unavailable.
Earlier and later extension changes remain separate observation boundaries.

Pi owns parallel tool execution. Sibling preflight is sequential, but execution
and completion order can differ. State follows completion order, not an invented
sequence of retries. Policy never serializes tool execution to simplify counters.

### Host boundaries

- Pi validates the outer tool schema before `tool_call`. Policy cannot repair a
  call rejected before this hook. Tool-owned argument preparation is a different
  public contract; policy does not replace tool registrations to acquire it.
- Pi does not validate arguments again after hook mutation. Policy validates its
  complete correction candidate without coercion, defaults, or property removal.
- Policy owns its internal sequence, not globally final transcript semantics.
  Later unrelated extensions can change results, and `message_end` permits a
  later same-role message replacement. Records describe final execution output.
- Extensions execute with host permissions. Policy is a workflow control, not an
  operating-system sandbox or protection against a hostile installed extension.

## Modes and guidance

`--policy-mode` overrides `PI_POLICY_MODE`. Values are `observe`, `notice`,
`annotate`, and `enforce`. Unset or blank environment configuration defaults to
`observe`; invalid configuration is reported rather than silently guessed.

| Mode | Applied behavior |
| --- | --- |
| `observe` | Record actual facts, matches, and candidate effects only |
| `notice` | Also show bounded operator notices in TUI mode |
| `annotate` | Also supply eligible model guidance; no denial or input/error correction |
| `enforce` | Also apply approved denials and corrections |

Every event phase obeys this matrix. Downstream live predicates use actual input
and result state, never a suppressed hypothetical correction. Preview is a
separately labeled simulation.

Projected guidance shares a 2048-byte UTF-8 bound, including its `[policy]`
prefix. Text is deduplicated and terminal-safe. Only guidance actually selected
for projection consumes its once/cooldown allowance. Current command rules guide
at most once per observation period and only after a successful result.

Stateful guidance enters the next actual `context` request. It does not queue a
steering message or create another model turn. A projection attempt does not
establish provider delivery, understanding, or compliance.

## Bounded observation state

Each rule owns an in-memory observation period with an explicit start time, reset
reason, revision, and generation. It can declare:

- an `observe` condition and optional `resetWhen` condition;
- an optional numeric `totalPath`;
- a window with `maxEvents` and `maxAgeMs`;
- `once:"period"` or `once:"turn"`;
- a cooldown and optional natural expiry.

Windows mean the last declared number of matching completions intersected with
the age bound. They do not claim an exhaustive time-window tally after the event
limit. Missing metrics and unavailable historical turn totals remain unknown,
not zero. Inspection renders unavailable values explicitly.

Session load, reload, new session, resume, fork, and tree navigation reset
observations. Disable, replacement, and explicit reset invalidate the affected
rule's prior pins. Old completions cannot restore explicitly reset state.
Compaction and ordinary continuation preserve observations.

Natural expiry and outcome-based reset are completion-time boundaries, not
changes of authority. A long call can enter the new completion period. Preview
projects expiry without changing live state. Expiry uses events rather than
background timers.

For example, this program produces limited guidance after repeated execution
errors. It does not count a policy denial as an executed-tool failure:

```json
{
  "phase": "context",
  "when": {"op":"gte","path":["state","windowCount"],"value":2},
  "state": {
    "observe": {"op":"eq","path":["outcome","kind"],"value":"execution-error"},
    "resetWhen": {"op":"eq","path":["outcome","kind"],"value":"success"},
    "window": {"maxEvents":64,"maxAgeMs":30000},
    "once": "turn",
    "cooldownMs": 30000
  },
  "action": {"kind":"guide","text":"Check the failed assumption before another tool attempt."},
  "onUnavailable": "skip"
}
```

There is no checkpoint persistence, ancestry replay, cross-session counter store,
or persistent admission quota. Retained telemetry does not silently restore
behavioral state.

## Named data and schema validation

Named data is operator-owned control state in the existing rule log, not a new
configuration-file loader. Rules refer to approved names, never arbitrary paths,
skill prose, credential files, or private sibling caches.

A binding contains a table or schema, source, revision, and capture time.
`maxAgeMs` is optional. Snapshots expose `ready`, `missing`, `stale`, or `invalid`
status. Lookup reports missing, unique, ambiguous, or unavailable. Repeated equal
destinations are still unique; conflicting destinations never select the first
row.

`/policy data set` fills omitted source with `operator` and capture time with its
operator audit timestamp. Explicit values are never replaced. Revisions describe
the complete normalized data contract. Replacement/removal checks the prior
revision.

A declined or unavailable dialog returns the complete exact-approval command.
The operator can repeat its normalized `{data,expectedRevision,approveRevision}`
artifact without a UI. The token binds all fields and the expected prior
revision. A changed artifact needs a new token. The complete approval command
must fit its output bound; it is never silently truncated. Terminal-control
characters are encoded as JSON Unicode escapes before measurement and display.
Reusing the displayed command preserves the original data and approval revision.

Direct-tool schemas come from `pi.getAllTools().parameters`. An explicit argument
codec can decode a JSON-string argument envelope and select an approved inner
schema through `selector.codec.schemaData`. The outer gateway schema does not
establish inner server schemas. Automatic gateway metadata discovery remains
unavailable without a supported source contract; private cache conventions are
not such a contract.

External schemas use Ajv and `ajv-formats`. Default dialect is draft-07; explicit
draft-2019-09 and draft-2020-12 are supported. Malformed schemas, unknown keywords
or formats, unsupported dialects, unresolved references, and asynchronous schemas
produce unavailable validation. No remote schema loader exists. The compiled
schema cache is bounded. TypeBox validates the engine's own closed rule grammar.

## Tools and operator controls

### `policy_propose`

- Current command additions use `operation:"add"`, `id`, `reason`, `note`,
  `match`, optional `suggestion`, and optional `scope`.
- Facts additions use `language:"facts/v1"` and `program` instead of `match`.
- `operation:"replace"` also requires the current definition's
  `expectedRevision` and a complete candidate.
- `retire` and `disable` retain only `id` and `reason`.

All proposals remain inert. Facts approval binds the exact proposal, including
conditions, scope, state, data bindings, and action parameters. Command
replacement binds the proposal revision and the operator-selected effect.
Agent-origin decision, override, data, or direct-retirement events cannot grant
authority. Retirement does not free an id.

### `policy_rules`

Views are `rules` (default), `capabilities`, `state`, `health`, `data`, `explain`,
and `preview`. Optional `id` narrows supported views. Explain accepts a rule id,
or `call:<call-id>` for bounded current-session recorded decisions, including
unmatched calls. Call explanations expose selected metadata, not arbitrary stored
payloads. Missing records may lie outside the read bound or await persistence;
absence does not prove that no decision occurred. Records remain untrusted
historical evidence, not current rule authority.

Preview requires `tool` and bounded `input`, with optional `result` containing
`isError` and `details`. Downstream preview conditions use the input and error
state that the current mode applies: valid input corrections first, then error
assertions, then guidance. Original-input facts remain unchanged.

Preview neither executes a simulated tool nor changes simulated policy state or
data. Its response deliberately shows the supplied candidate. That response can
remain in the host transcript. The actual inspection invocation retains ordinary
telemetry; it is not a promise that the complete invocation performs no writes.

### `/policy`

```text
/policy
/policy list
/policy show <rule-or-proposal-id>
/policy approve <command-add-proposal> <steer|block>
/policy approve <command-replacement> <steer|block> <proposal-revision>
/policy approve <facts-proposal> exact <proposal-revision>
/policy approve <retire-or-disable-proposal>
/policy reject <proposal-id>
/policy disable <id> <reason...>
/policy enable <id> <reason...>
/policy effect <command-rule-id> <steer|block> <reason...>
/policy retire <local-id> <reason...>
/policy mode
/policy capabilities
/policy state
/policy health
/policy explain <rule-id|call:call-id>
/policy preview <JSON>
/policy reset <rule-id|--all> <reason...>
/policy data list
/policy data show <name>
/policy data set <JSON>
/policy data remove <name> <current-revision> [exact]
/policy help
```

Set JSON contains `data`, `expectedRevision` (null for a new binding), and an
optional exact `approveRevision`. Reset immediately invalidates the selected
observation pins without stopping tools or changing rules, approvals, data, or
historical records. `--all` is distinct from every valid rule id.

The panel shares rule/proposal details and operator gates with the command. It
shows exact actions and revisions, presents complete approval artifacts, and
provides command hints for state, explain, reset, and data controls. TUI and RPC
command responses use notifications. JSON commands append non-context custom
entries. Print commands use the host-managed output path. The interactive panel
itself remains TUI-only.

## Command-shape rules

The shell parser does not expand aliases, variables, globs, generated words, or
shell data. It captures the command once and uses that same value for matching
and bounded best-effort redaction.

```text
match {
  command,
  flags?, absentFlags?,
  operands?: {min?, max?, any?, at?: {index: [allowed values]}},
  pipe?: {from?, to?, fromRedirect?, toRedirect?, next?, later?}
}
scope {modelProviders?, models?, cwdPrefixes?}
```

Every supplied command constraint must hold in one parsed stage. Command names
match basenames; flags match literally. Operands are arguments without a leading
hyphen. `next` selects the immediate next stage; `later` selects a later stage.
Nested substitutions are separate statements. Comments and variable values do
not become command names.

Scope selects session context, not a tool. Provider and provider/model values
match exactly and case-sensitively. Cwd prefixes use absolute string-prefix
matching. Missing dimensions are unconstrained.

Inactive, retired, unavailable, and out-of-scope rules never invoke their
predicate. Command package matches retain catalog order; local command matches
use id order. Facts correction stages use stable id order.

## Rule log, health, and privacy

The private log contains closed current-shape events:

- complete package `catalog` snapshots;
- inert `proposal` and operator `decision` events;
- complete `override` replacement/clear events;
- local definition retirement;
- operator-approved data set/remove events with expected revisions.

The latest catalog activates its installed definitions and retires removed
package definitions. Existing disabled overrides survive replacement and catalog
changes. A local id collision retains the local definition and reports the
collision. There is no old-format decoder, migration reader, second built-in
store, or parallel dispatch registry.

The store directory must be current-user-owned, non-symlink, and private (0700).
The registry must be a current-user-owned regular file with mode 0600. Reads and
writes use no-follow protections where available and checked append writes.

An exclusive private `.rules-lock` file serializes catalog writes and each
reload/validate/append transaction across sessions and processes. Conflicting
controls recheck the current revision or pending proposal before acknowledgment.
Lock acquisition uses bounded retries and never reports an unapplied change as
successful. Policy never removes a held lock based on its age. If a writer exits
before cleanup, stop all policy writers before removing the retained lock, then
restart affected sessions. Read-only snapshots do not acquire a transaction lock
after initialization. Reload existing policy sessions after an upgrade before
concurrent control writes so every writer uses the transaction boundary.
A cleanup error rejects acknowledgment even if the event already reached the log.
Inspect the current state before retrying that control.

A missing registry is healthy. An incomplete final line is reported as an append
in flight, skipped during reduction, and blocks writes until resolved. A malformed
complete line, invalid filesystem property, exceeded bound, or reduction invariant
latches degraded authority. Policy exposes the concrete repair, refuses control
writes, uses package defaults as advisory evidence, and caps mechanisms at notice.
Observe still applies no effect. A new session is required after repair.

Capacity and byte limits are independent. Package/local/active plan limits share
one definition in [program.ts](program.ts). Current event and registry byte bounds
are declared in [local-rules.ts](local-rules.ts); data and JSON bounds are declared
in [data.ts](data.ts). Actual serialized catalogs are checked before authority
changes. Oversized declarations are rejected rather than silently truncated.

Daily telemetry records tool/call identity, session context, duration, text output
size, truncation, reported tokens, observed outcome, mode, rule revisions,
metadata labels, changed field paths, and requested/applied effects. Named data
snapshots retain only names, revisions, status, and freshness metadata at call
admission, never table rows or schema payloads. Later phases can reassess freshness
while retaining that data revision. Each metadata group reports omissions.
Correlation
loss is explicit. Records do not invent a terminal result for an unfinished call.
New domains retain no raw argument or result payload by default. Shell capture
keeps its separately bounded best-effort secret redaction. Preview and explicit
control artifacts are not telemetry payload capture.

Telemetry failure stops persistence and reports health without stopping approved
rules, corrections, or counters. A successful policy decision does not prove its
record reached disk. Rule-authority health remains a separate boundary.

## Configuration and validation

| Setting | Purpose |
| --- | --- |
| `PI_POLICY_DIR` | Private rule/data/telemetry directory; default `<agentDir>/policy` |
| `--policy-mode` | Session mode; overrides the environment |
| `PI_POLICY_MODE` | `observe` by default, or `notice`, `annotate`, `enforce` |
| `PI_POLICY_TEST_PI_ROOT` | Test-only explicit Pi package root for `pi-hooks.test.mts` and `proposal-schema.test.mts`; runtime does not read it |

Focused checks:

```sh
node --test extensions/policy/*.test.mts
node scripts/extension-load-check.mts extensions/policy/index.ts
npm run lint
npm run typecheck
npm run check
npm test
```

The Pi hook tests drive the real extension runner and agent loop with controlled
tools. They cover correction delivery, result chaining, completion order,
preflight outcomes, and context projection without an extra request. Ordinary
callback fakes do not establish those host behaviors. Use
`PI_POLICY_TEST_PI_ROOT` to exercise a different installed Pi package rather than
assume the repository dependency snapshot represents it.
