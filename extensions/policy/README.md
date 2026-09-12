# policy

`policy` governs tool choice, argument validity, result interpretation, failure
recovery, and resource use. Each rule declares its purpose, applicability,
evidence, action, and authority. One extension owns decisions, corrections,
observations, operator controls, and records.

The operator's stored catalog is one `RuleRecord` aggregate reduced from a
private, append-only `rules.jsonl` log. Bundled defaults supply initial data,
not continuing authority over stored rules. [compiler.ts](compiler.ts)
normalizes authoring syntax into the same execution steps. Command parsing is an
internal evidence source, not a second policy pipeline. There is no script
language, dynamic plugin loader, background service, or sibling protocol.

## Starter policies

[catalog.ts](catalog.ts) supplies the bundled starter catalog independently of
evidence extraction. A missing registry receives a fully written seed through
atomic, non-overwriting publication. An existing registry never receives an
automatic seed, including an intentionally empty file.

After initialization, every stored rule uses the same operator controls. Reloads
and package updates preserve edits, disablement, and retirement. Removing a rule
from the bundled catalog does not remove it from an existing catalog. Updated
starter definitions require an explicit import.

Default selection follows the protected outcome and available evidence, not the
rule's syntax. Command requirements use precise declared
shapes; schema refusal needs known invalid arguments; outcome guidance observes
completed work and never infers a retry's cause.

| Policy | Purpose and activation evidence |
| --- | --- |
| `routing.*`, `form.*` | Use appropriate readers, direct command inputs, purpose-built commands, and explicit scope. Their installed predicates select the calls. |
| `bounds.*` | Require explicit discovery/output limits and identify caps that do not stop the producer. |
| `arguments.schema` | Refuse a final argument object that violates the available tool schema. This includes mutations from earlier hooks. Unavailable schemas remain unknown. |
| `results.declared-error` | Assert failure only when the result matches the approved `policy.result-errors` schema. Missing, stale, or invalid bindings produce unknown evidence and no mutation. |
| `recovery.repeated-errors` | Guide after three execution errors within a five-minute observation period/window. A successful execution resets the period; policy denials do not count as execution errors. |
| `resources.output-volume` | Guide after 65,536 measured UTF-8 text bytes across at most sixteen executed results within a five-minute period/window. The measurement precedes this extension's guidance. |

Both context guides project at most once per period, before a real model request.
They never force another turn. These are conservative intervention bounds, not
measured optimal thresholds or claims of cost savings. Observe mode applies no
effects. The operator can replace, retire, or disable any seeded rule. Command
defaults also declare an
explicit `steer-or-block` choice; the other defaults declare exact actions.

A schema specifies accepted fields, not which unknown key or identifier the
caller intended. Key/value correction therefore requires an explicitly approved
mapping and rule. No package default guesses spelling, invents identifiers, or
imports an environment's private conventions.

For structured result correction, set `policy.result-errors` through `/policy
data set`. Its schema matches the policy result facts, including `tool`, `content`,
`details`, and `isError`. Require the intended tool name and all failure fields;
a loose schema grants a broader assertion than a tool-specific contract. For
example, the schema below recognizes only the hypothetical `sample_request`
tool's declared failure result:

```json
{
  "type": "object",
  "required": ["tool", "details"],
  "properties": {
    "tool": {"const": "sample_request"},
    "details": {
      "type": "object",
      "required": ["ok"],
      "properties": {"ok": {"const": false}}
    }
  }
}
```

The operator approves that schema as data. The package supplies the error rule;
no fixture or separate guard supplies its behavior.

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
     "purpose": "Resolve an approved room identity before the call executes.",
     "authority": "exact",
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

A record contains its id, source, authoring matcher, and definition. The
definition contains purpose, declared authority, revision, lifecycle state,
action effect, note, and optional scope. Purpose is a positive outcome, bounded
to 400 characters. Availability and stale-override status are derived. One
complete operator override slot controls disablement and permitted effect choice.
Optional `applicability` uses the same bounded condition grammar. Only true
applicability permits evaluation or state observation. False and unknown
applicability never grant fallback denial authority. Reader replacements require
an active `read` tool, so unavailable alternatives do not prohibit shell fallback.

Matchers use installed predicates, compact command shapes, or `facts/v1`
programs. A predicate is a built-in test for a command pattern. An ordinary rule
can reference an installed predicate without copying its implementation; its
rule id need not equal the predicate key. A reference never supplies executable
code, imports a module, or grants rule-initiated I/O. A predicate reference reuses
only the evidence test, not another rule's purpose, applicability, or authority.

Origin metadata records an initial package seed, an approved proposal, or an
explicit import. Origin grants no control, capacity, or execution-order priority.
All additions and replacements after initialization require operator approval.
An effect override never authorizes correction.

Stored definitions do not pin implementation binaries. An engine update still
updates its installed primitives. Unsupported predicates or obsolete formats do
not invoke compatibility readers or fallback implementations.

Definition effect families describe actual behavior:

- `block`: denial;
- `steer`: guidance;
- `correct`: input or result correction;
- `observe`: metadata observation.

Authority is independent of authoring syntax:

- `exact` binds the declared action and complete proposal revision. An effect
  override never changes its action.
- `steer-or-block` permits the operator's guidance/denial choice only where the
  action and phase support that choice. Selected `steer` never denies, including
  when evidence is unavailable. It never grants correction authority.

Both compact shapes and eligible facts programs support selectable authority.
Result/context guidance and corrections require exact authority. Every stored
rule supports complete replacement proposals, regardless of origin. Engine
invariants, including bounded grammar, approval checks, and all-or-nothing
corrections, remain mandatory code rather than optional catalog entries.

### Facts programs

The closed grammar is defined by [program.ts](program.ts). The provider-facing
proposal schema describes one condition level and identifies child objects as
conditions of that same grammar. It contains no recursive schema references.
This finite description applies to applicability, `when`, `state.observe`, and
`state.resetWhen`; it does not limit valid nesting or grant admission. Before a
proposal reaches storage, the local recursive validator checks every condition,
the shared node/depth limits, field types, declared data, and action authority.
Both descriptions use the same condition and program shape builders. Stored
rules and their validation contract do not change.

A program declares:

| Field | Contract |
| --- | --- |
| `phase` | `input`, `result`, `completion`, or `context` |
| `selector` | Optional exact physical tools, logical operations, and a declared argument codec |
| `when` | A bounded three-valued condition |
| `action` | One typed action with complete parameters |
| `onUnavailable` | `skip`, or `deny` for an input rule |
| `inputView` | Optional `original` or `effective` for input denials or matched-success guidance |
| `data` | Approved named data dependencies |
| `state` | Optional observation condition, reset condition, aggregates, and guidance limits |

Conditions support `all`, `any`, `not`, `eq`, `in`, `exists`, `type`, numeric
comparisons, bounded string comparisons, exact table lookup status, and
`matches-schema`. The schema condition declares `path` and `schemaData`; the
schema name must appear in the program's `data` bindings. It never loads a file or
remote reference. Paths are
arrays of safe own-property keys, not executable expressions. Unknown evidence
stays unknown under negation and composition. Missing comparison values are not
zero or false; `exists` tests actual property presence separately.

Fact roots include `tool`, `operation`, `input`, `original`, `result`, `outcome`,
`state`, `schema`, `data`, and `context`. `result.tool` identifies the actual
physical tool independently of arbitrary result details. Corrections use paths relative to their
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
| `guide` | input, result, or context | Supply bounded policy guidance; an input condition admits guidance after a successful result |
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
5. Evaluate effective-input prohibitions through the same plan before one
   synchronous input commit.

Command rules compile to ordinary original/final denial steps or result guidance.
Every captured eligible final-input prohibition participates in candidate
validation, including rules whose evidence was false on the original input. The runtime contains no
second command-specific gate.

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

An operator-authored program can use different limits. This example does not
count a policy denial as an executed-tool failure:

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

- Additions require `operation:"add"`, `id`, `reason`, `purpose`, `authority`,
  and `note`.
- Compact shapes use `match`, with optional `suggestion` and `scope`.
- Facts programs use `language:"facts/v1"` and `program` instead of `match`.
- Installed predicate references use `predicate:"routing.cat-read"` instead of
  either form. The key must resolve to a predicate in this extension.
- `operation:"replace"` also requires the current definition's
  `expectedRevision` and a complete candidate.
- `retire` and `disable` retain only `id` and `reason`.

All proposals remain inert. Exact approval binds the complete proposal, including
purpose, authority, conditions, scope, state, data bindings, and action parameters.
Selectable replacement binds both the proposal revision and chosen effect.
Agent-origin decision, override, data, or direct-retirement events cannot grant
authority. Retirement does not free an id.

For example, this ordinary proposal references a reader predicate and explicitly
requires the alternative reader:

```json
{
  "operation": "add",
  "id": "local.file-reader",
  "purpose": "Use the available file reader for plain file contents.",
  "authority": "steer-or-block",
  "reason": "Apply the declared reader preference.",
  "note": "Use the read tool for file contents.",
  "predicate": "routing.cat-read",
  "applicability": {
    "op": "eq",
    "path": ["context", "tools", "read", "active"],
    "value": true
  }
}
```

### `policy_rules`

Views are `rules` (default), `catalog`, `capabilities`, `state`, `health`, `data`,
`explain`, and `preview`. The catalog view shows bundled starter definitions;
it does not make them active or replace the stored catalog. Optional `id` narrows supported views. Explain accepts a rule id,
or `call:<call-id>` for bounded current-session recorded decisions, including
unmatched calls. Call explanations expose selected metadata, not arbitrary stored
payloads. Evaluation metadata includes phase and input view, so original and
final checks retain distinct evidence even when they share a rule id.
Missing records may lie outside the read bound or await persistence;
absence does not prove that no decision occurred. Records remain untrusted
historical evidence, not current rule authority.

Preview requires `tool` and bounded `input`, with optional `result` containing
`isError`, `details`, and text `content` blocks. Binary/image content and `usage`
are not accepted. Preview and execution share result fact projection and the
error-correction-before-guidance sequence.

Preview neither executes a simulated tool nor changes simulated policy state or
data. Its response deliberately shows the supplied candidate. That response can
remain in the host transcript. The actual inspection invocation retains ordinary
telemetry; it is not a promise that the complete invocation performs no writes.

### `/policy`

```text
/policy
/policy list
/policy catalog [rule-id]
/policy import <rule-id|--all> [exact <import-revision>]
/policy show <rule-or-proposal-id>
/policy approve <selectable-add-proposal> <steer|block>
/policy approve <selectable-replacement> <steer|block> <proposal-revision>
/policy approve <exact-proposal> exact <proposal-revision>
/policy approve <retire-or-disable-proposal>
/policy reject <proposal-id>
/policy disable <id> <reason...>
/policy enable <id> <reason...>
/policy effect <selectable-rule-id> <steer|block> <reason...>
/policy retire <rule-id> <reason...>
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

### Explicit catalog import

`/policy catalog` inspects the bundled definitions without applying them.
`/policy import` presents the complete selected definitions, current targets,
and resulting state/effect for operator confirmation. TUI approvals use an
immutable paged review instead of a clipped native confirmation dialog. Approval
requires an explicit action on the final visible page; tiny viewports refuse it.
Without that reviewer, the command returns an exact revision-bound command. The revision binds the complete source rows and
current target identities, including lifecycle, origin, and override state.
A changed source or target requires a new approval.

Import commits one bounded event. It replaces only selected definitions and
preserves operator overrides; an exact action still ignores effect overrides.
It restores a selected retired definition, but an existing disable override
still applies. Unselected rules and named data remain unchanged. Missing or
conflicting capacity, stale targets, and agent-origin authority never grant a
partial import. There is no automatic reimport, external catalog-file loader,
or update daemon. Large imports require smaller explicit selections rather than
truncated approval artifacts.

The panel shares rule/proposal details and operator gates with the command. It
shows exact actions and revisions, presents complete approval artifacts, and
provides command hints for disable/enable, effect, retire, reset, explain, and
data/state controls. TUI proposal and data approvals use the same paged artifact reviewer.
A result from that reviewer still passes the normal revision and authority checks
before any mutation. TUI and RPC
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
predicate. Evidence extraction preserves supplied record order without origin
priority. The common execution plan uses stable id order for correction stages.

## Rule log, health, and privacy

The private log contains closed current-shape events:

- one initial package `catalog` event, valid only at the start of a new log;
- explicit operator `import` events with source rows and target identities;
- inert `proposal` and operator `decision` events;
- complete `override` replacement/clear events;
- definition retirement for any origin;
- operator-approved data set/remove events with expected revisions.

The log defines the stored catalog. Bundled definitions never overlay it during
reads or reloads. Existing disabled overrides survive replacement and explicit
import. Import target identities prevent stale changes; concurrent capacity
conflicts do not corrupt the catalog or partially apply an import. There is no
old-format decoder, migration reader, second built-in store, or parallel dispatch
registry.

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

A missing registry receives the starter seed. An existing empty registry is a
healthy empty catalog. An incomplete final line is reported as an append
in flight, skipped during reduction, and blocks writes until resolved. A malformed
complete line, invalid filesystem property, exceeded bound, or reduction invariant
latches degraded authority. Policy exposes the concrete repair, refuses control
writes, exposes no fallback rules, and caps mechanisms at notice. An unavailable
catalog is not an intentionally empty one. Observe still applies no effect.
A new session is required after repair.

Capacity and byte limits are independent. All stored rules share one catalog
capacity regardless of origin; an edit never transfers a rule into a smaller
quota. Catalog and active-plan bounds live in [program.ts](program.ts). Current event and registry byte bounds
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
Ordinary records retain no raw argument or result payload by default. Command capture
keeps its separately bounded best-effort secret redaction. Preview and explicit
control artifacts are not telemetry payload capture.

Telemetry failure stops persistence and reports health without stopping approved
rules, corrections, or counters. A successful policy decision does not prove its
record reached disk. Rule-authority health remains a separate boundary.

## Maintained evaluations

[policy.eval.mts](policy.eval.mts) uses the existing
[package evaluation runner](../../evals/README.md). It compares `enforce` with
`observe` under identical synthetic rules, data, tools, and prompts. The fixture
wraps this extension's real entrypoint, isolates its policy store, and removes
that store after shutdown. It never exposes real business tools or the operator's
rule store. This restricted fixture is not active-session resource parity.

This is the `policy-engine` suite. Its recipe-driven cases cover denial, key and
value correction, composed JSON argument correction, structured error assertion, final-candidate refusal, collisions, missing/stale
bindings, ambiguous lookups, unknown conditions, proposals, previews, unrelated
tasks, and adaptive retry/output-volume guidance. The existing
[shell enforcement suite](../../prompts/policy-enforce.eval.mts) covers the built-in
bash route separately.

Mechanism cases require the same original arguments in both variants. Their
positive outcome checks deliberately fail in observe mode; those failures are
negative-control evidence, not a reason to weaken the checks. Near misses and
inert-authority cases must succeed in both variants. Adaptive cases permit either
variant to succeed and require comparison of actual recovery, extra calls,
tokens, and latency. Human review also checks exact arguments, ordering, extra
calls, and unsupported success claims, which the lexical checks do not establish.

```sh
npm run evals -- validate extensions/policy/policy.eval.mts
node --test extensions/policy/evaluation.test.mts
```

These commands make no model calls. The colocated test drives production hooks
and inert tools, proves the expected negative-control misses, and checks fixture
cleanup. This establishes deterministic checks, not model behavior or operational
savings. Model-backed execution requires explicit participants, credential
sources, the runner's effect grants (including `synthetic-policy-filesystem`),
and the exact plan digest. Follow the runner's plan/run/adjudicate procedure.
Quality remains `not_assessed` until human adjudication; results belong in the
runner's ignored output store, not in this slice.

The `policy-product` suite in [product.eval.mts](product.eval.mts) evaluates the
starter catalog through the production entrypoint in isolated fresh stores. Its fixture supplies only
inert tools and approved schema data, never replacement policy definitions.
Cases cover known-invalid final arguments, declared result errors, repeated
execution errors, output volume, and near misses. Controlled tests check package
provenance, exact intervention thresholds, mode effects, duplicate completion,
reset/expiry, data absence, and cleanup. Catalog lifecycle tests preserve
operator edits and retirement across reloads and changed starter definitions;
explicit import and intentional emptiness use the same production controls.

```sh
npm run evals -- validate extensions/policy/product.eval.mts
node --test extensions/policy/product-evaluation.test.mts
```

These tests establish supplied behavior under controlled conditions. They do not
establish live workload benefits or human quality. Model-backed runs and human
adjudication remain distinct from deterministic validation.

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
