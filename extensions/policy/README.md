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

Structured result correction requires an approved facts program. Select the
intended tool and test its declared failure fields with ordinary conditions.
For example, this program recognizes only the hypothetical `sample_request`
tool's `details.ok:false` result:

```json
{
  "phase": "result",
  "selector": {"tools": ["sample_request"]},
  "when": {"op": "eq", "path": ["result", "details", "ok"], "value": false},
  "action": {"kind": "assert-error"},
  "onUnavailable": "skip"
}
```

No starter rule guesses an application's failure contract.

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
Both descriptions use the same condition and program shape builders. The proposal
schema also exposes all authoring fields at its object root, so provider adapters
that project object properties retain the complete vocabulary. Its closed union
branches still enforce operation-specific admission before execution. Policy does
not request strict constrained sampling for this grammar. Stored rules and their
validation contract do not change.

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
comparisons, bounded string comparisons, and exact table lookup status. Paths are
arrays of safe own-property keys, not executable expressions. Unknown evidence
stays unknown under negation and composition. Missing comparison values are not
zero or false; `exists` tests actual property presence separately.

Fact roots include `tool`, `operation`, `input`, `original`, `outer`,
`originalOuter`, `result`, `outcome`, `state`, `schema`, `data`, and `context`.
`result.tool` identifies the actual physical tool independently of arbitrary
result details. Corrections use paths relative to their argument object, rather
than condition paths prefixed with `input`.

With a codec, `input` and `original` contain decoded inner arguments. `outer`
and `originalOuter` retain the corresponding raw argument objects, including
server and operation fields. Without a codec, these roots expose the same
objects as `input` and `original`. Each correction stage reads one fixed outer
snapshot. Later stages see earlier logical-target corrections; original roots
retain the input before those corrections. Missing or malformed inner arguments
remain unknown without hiding available outer fields.

Qualify gateway conditions with an exact physical tool selector, operation selector,
and an outer-server condition. Put server qualification in `applicability` when
missing server evidence must leave the rule inactive even with
`onUnavailable:"deny"`. For a hypothetical gateway with a `server` field, use
`{"op":"eq","path":["outer","server"],"value":"alpha"}`. Policy does not discover
private gateway metadata or supply vendor-specific selectors. Codecs supply
read-only inner facts, not inner correction authority. A codec permits only
outer `logical-target` substitution, not decoded key or value corrections.

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
rule's approved conditions and lookup tables supply that meaning. Error
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
4. Validate the complete candidate against the registered tool schema.
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

- Policy governs model tool calls, not operator `!` or `!!` commands. It registers
  no `user_bash` handler. Pi owns that separate route and aborts it if an installed
  handler throws or returns an invalid defined result; `undefined` continues
  propagation. That host behavior does not extend policy rules to operator commands.
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

A binding contains a table, source, revision, and capture time.
`maxAgeMs` is optional. Snapshots expose `ready`, `missing`, `stale`, or `invalid`
status. Lookup reports missing, unique, ambiguous, or unavailable. Repeated equal
destinations are still unique; conflicting destinations never select the first
row.

Tables accept optional `collation:"exact"` or
`collation:"ascii-case-insensitive"`. Exact comparison is the default. The
insensitive mode folds only ASCII letters in string keys and lookup queries.
Stored rows remain unchanged. Values, scalar types, and non-ASCII characters
remain exact. All matching rows contribute to the result, including when one
key has the query's exact case. Conflicting destinations therefore remain
ambiguous; no exact-case row takes priority.

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

### Complete data files

Use `/policy data set-file {"path":"table.json"}` for a complete local table. Relative paths resolve against the command's working directory. The file
contains only `data` and `expectedRevision`, with explicit `data.source` and
`data.capturedAt` metadata. `data.revision` is optional: policy computes a
content revision and rejects a supplied revision that differs.

```json
{
  "expectedRevision": null,
  "data": {
    "name": "rooms",
    "kind": "table",
    "collation": "ascii-case-insensitive",
    "source": "operator-table",
    "capturedAt": 1789387200000,
    "rows": [{"key": "Lobby", "value": "room-17"}]
  }
}
```

The command captures a bounded regular file without following a final symlink.
It rejects URLs, invalid UTF-8, malformed JSON, and changing or oversized files.
It never executes source content, watches a file, or uses the file as live table
storage. The complete normalized data enters one approved log event.

The TUI shows every normalized field and each table row in a complete paged
review. Approval requires the final page. Without that reviewer, the response
identifies the source artifact and its exact approval command, not a claim of
complete review. Review the complete source file, then repeat the command with
`approveRevision`. The repeated command rereads and validates the file; a changed
normalized artifact requires a new approval. The approval binds the full data
and expected prior revision. No pending artifact store exists.

Source files are bounded to 512 KiB, serialized normalized data to 256 KiB, and
complete review text to 1 MiB. Tables retain the independent row and structural
bounds in [data.ts](data.ts). Data events permit 512 KiB including audit fields
and newline; ordinary rule events retain their smaller bound. The whole registry
remains bounded to 4 MiB. Capacity is checked before review and again inside the
append transaction. There are no chunks, external blobs, compression, or
automatic compaction. Calls already admitted retain their captured data revision;
the next call receives the replacement.

Direct-tool schemas come from `pi.getAllTools().parameters`. Policy checks the
complete bounded candidate with TypeBox's public `Compile().Check()` operation.
It does not convert values, insert defaults, or remove properties. Missing
schemas, unsafe copies, and thrown validation errors produce unavailable
validation. The compiled schema cache is bounded.

Registered tool schemas use the host's TypeBox contract. Policy does not provide
arbitrary schema imports, dialect selection, strict schema-document admission,
`matches-schema`, or `schemaData`. Unsupported rule and data shapes are rejected
by authoring and replay validation, without migration or normalization. Existing
private logs are not rewritten; rejected entries appear in registry health.

A codec decodes a JSON-string envelope for conditions only. Its `schema.valid`
fact is unavailable because the outer schema does not describe inner arguments.
Decoded key and value correction rules are rejected. Direct outer-field
corrections and outer `logical-target` substitutions remain supported, with a
complete final check against the registered outer tool schema.

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
it does not make them active or replace the stored catalog. Active command-shape
rules retain their complete matcher in rule inspection and `/policy show`,
including CLI selection, flag clauses, and unavailable behavior.
Optional `id` narrows supported views. Explain accepts a rule id,
or `call:<call-id>` for bounded current-session recorded decisions, including
unmatched calls. Call explanations expose selected metadata, not arbitrary stored
payloads. Evaluation metadata includes phase and input view, so original and
final checks retain distinct evidence even when they share a rule id. Unavailable
command evidence also carries bounded reason codes without raw command text.
Missing records may lie outside the read bound or await persistence;
absence does not prove that no decision occurred. Records remain untrusted
historical evidence, not current rule authority.

Preview requires `tool` and bounded `input`, with optional `result` containing
`isError`, `details`, and text `content` blocks. Binary/image content and `usage`
are not accepted. Preview and execution share result fact projection and the
error-correction-before-guidance sequence. The tool and `/policy preview` command
apply the same bounded inspection validation, including result types, allowed
fields, text-only content, and total JSON size. Invalid result flags are rejected,
not converted to successful results.

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
/policy data set-file <JSON>
/policy data remove <name> <current-revision> [exact]
/policy help
```

Set JSON contains `data`, `expectedRevision` (null for a new binding), and an
optional exact `approveRevision`. Reset immediately invalidates the selected
observation pins without stopping tools or changing rules, approvals, data, or
historical records. `--all` is distinct from every valid rule id. Command completion
includes `reset --all`, data actions, stored data names, and the current revision
for removal. Completion supplies syntax, not approval; the command still validates
authority and the current revision.

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
  flags?, anyFlags?, absentFlags?,
  cli?: {profile: "git", subcommand: ["push"]},
  operands?: {min?, max?, any?, at?: {index: [allowed values]}},
  pipe?: {from?, to?, fromRedirect?, toRedirect?, next?, later?}
}
scope {modelProviders?, models?, cwdPrefixes?}
```

Every supplied command constraint must hold in one parsed stage. Command names
match basenames. `flags` requires all spellings, `anyFlags` requires at least one,
and `absentFlags` requires none. Without `cli`, the current literal mode matches
flags literally and treats arguments without a leading hyphen as operands.
`next` selects the immediate next stage; `later` selects a later stage. Nested
substitutions are separate statements. Comments and variable values do not
become command names.

### Git option evidence

`match.cli:{"profile":"git","subcommand":["push"]}` selects the closed Git
profile in [cli.ts](cli.ts). It distinguishes Git global options, the push
subcommand, option occurrences, option values, and operands after the subcommand.
The profile does not execute Git, scrape help, resolve aliases/configuration, or
expand shell data. It is not a general command grammar.

For both add and replace proposals, `subcommand` accepts exactly `["push"]`.
The tool schema uses a single literal `items` schema with `minItems:1` and
`maxItems:1`, not tuple-array notation. Provider-specific acceptance still
requires a check against the selected provider; local admission alone does not
establish it.

CLI flags select option spellings, not values or the command's final effective
state. For example, `-o --force` consumes `--force` as a push-option value, and
`-ofool` does not contain the `-f` option. `--` ends push options.
`--force-with-lease=ref` is the lease option with a value, not plain force. The
profile retains occurrence order, canonical identity, values, and polarity.
Git global `-C` and `-c` require separate values in this profile; attached forms
and global clusters are unavailable evidence.

CLI proposals must explicitly declare top-level `onUnavailable:"skip"` or
`"deny"`. That choice is stored with the matcher and included in the approved
revision. Unknown expansion, malformed syntax, unsupported grammar, and exhausted
parse bounds stay unknown rather than proving a flag absent. A selected `steer`
effect never denies. False scope or false/unavailable applicability never acquires
unknown-denial authority. Literal proposals retain `skip` when omitted.

This example refuses plain-force option occurrences. Git `--force` disables
lease checks, so a lease option is not an exception to this rule.

```json
{
  "operation": "add",
  "id": "local.push-force",
  "purpose": "Refuse explicitly forced Git pushes.",
  "authority": "steer-or-block",
  "reason": "Use the approved force-option restriction.",
  "note": "Remove the plain force option before this push.",
  "match": {
    "command": "git",
    "cli": {"profile": "git", "subcommand": ["push"]},
    "anyFlags": ["--force", "-f"]
  },
  "onUnavailable": "deny"
}
```

This spelling-based rule does not claim to prohibit every Git force mechanism,
such as a plus-prefixed refspec. Approve the behavior your rule actually selects.

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
Existing rule and telemetry paths open without waiting for pipe peers. Nonregular
files are rejected before reads or writes; panel reads report partial evidence
instead of treating an unreadable source as an empty history.

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
changes. Add approval rechecks total catalog capacity inside the write transaction,
including disabled and retired definitions. Competing pending additions never
reserve capacity; a refused approval remains pending and leaves the log unchanged.
Oversized declarations are rejected rather than silently truncated.

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
value correction, logical-target operation correction, structured error assertion, final-candidate refusal, collisions, missing/stale
bindings, ambiguous lookups, unknown conditions, proposals, previews, unrelated
tasks, and adaptive retry/output-volume guidance. The existing
[shell enforcement suite](../../prompts/policy-enforce.eval.mts) covers the built-in
bash route separately.

Authoring cases request policy inspection before the inert proposal, as the
production tool guidelines require. Mechanism cases require the same original
arguments in both variants. Their positive outcome checks deliberately fail in observe mode; those failures are
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
inert tools and seeds no data or rules, never replacement policy definitions.
Cases cover known-invalid final arguments, the absence of automatic result
assertions, repeated execution errors, output volume, and near misses. Controlled tests check package
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
| `PI_POLICY_TEST_PI_ROOT` | Test-only explicit Pi package root for `pi-hooks.test.mts`, `proposal-schema.test.mts`, and the package schema test in `scripts/extension-load-check.test.mts`; runtime does not read it |

Focused checks:

```sh
node --test extensions/policy/*.test.mts scripts/extension-load-check.test.mts
node scripts/extension-load-check.mts extensions/policy/index.ts
npm run lint
npm run typecheck
npm run check
npm test
```

The proposal schema tests also capture the real Anthropic adapter's request payload
before network dispatch. They prove field preservation through that adapter, not
acceptance by a remote endpoint.

The Pi hook tests drive the real extension runner and agent loop with controlled
tools. They cover correction delivery, result chaining, completion order,
preflight outcomes, and context projection without an extra request. Ordinary
callback fakes do not establish those host behaviors. Use
`PI_POLICY_TEST_PI_ROOT` to exercise a different installed Pi package rather than
assume the repository dependency snapshot represents it.
