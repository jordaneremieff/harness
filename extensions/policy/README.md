# policy

Records paired, completed tool calls and their outcomes against declarative
rules, and runs the one mechanism the active mode selects.

The records support comparison of command classes by duration, output size,
truncation, and failure. Built-in classes are fixed in code; agent-authored
classes use a closed shell-stage vocabulary and an explicit per-rule posture.
No mode changes a tool input.

## Modes

`PI_POLICY_MODE` selects the session mechanism and every mode records. Rule
posture refines enforce mode: built-in classes and promoted agent rules block,
while active agent rules steer by annotation instead.

| Mode | Mechanism | Model-visible | Operator-visible |
|---|---|---|---|
| `observe` (default) | none | no | no |
| `notice` | a terminal flag on each flagged call | no | yes, in TUI mode |
| `annotate` | one guidance line on a successful flagged call with remaining ids | yes | no |
| `enforce` | block built-in and promoted agent classes; annotate successful calls that match only active agent rules | yes | no |

An unrecognized value is a configuration error. The extension reports it once
and stops recording for the session.

### notice

The extension calls `ui.notify` once per flagged call with the matched rule ids.
It shows nothing when no rule matched, and nothing outside TUI mode, where the
notice reaches nobody. It never patches the tool result.

### annotate

The extension appends one line to the result content of a flagged call. The line
carries the guidance the matched rules declare, prefixed with `[policy]` so the
model does not read it as tool output.

Bounds on the line:

- One rule id reaches the model at most once per session, so a repeated command
  class costs nothing after its first flag.
- Rules that share wording contribute one line.
- The line has a fixed byte cap. Ids left outside the cap stay unannotated and
  remain available to a later call.
- A failed call receives no line, because its error text already carries signal.

### enforce

The extension blocks a call with a blocking class at the `tool_call` boundary.
The block result carries a reason that names the preferred form: the same `[policy]`
guidance line the annotation uses, so both mechanisms say the same thing. The
model receives the reason as the call's error result and can reissue the
command in the preferred form.

Every built-in class and every promoted agent class blocks. An active agent
class records and steers: when no blocking class co-occurs, a successful call
receives the normal capped annotation. No class rewrites in place, because Pi
performs no re-validation after a handler mutates `event.input`, and no rewrite
of a flagged form is provably semantics-preserving:

| Class | Disposition | Why no rewrite |
|---|---|---|
| `routing.cat-read`, `routing.sed-slice`, `routing.inline-script-read` | block | the preferred form is the read tool; no bash form exists, and an inline script may do arbitrary work beyond the read |
| `routing.head-slice` | block | only line slices the read tool covers block; byte and all-but-last forms are slices the read tool cannot give, so the command-line rules permit them |
| `routing.tail-slice` | block | only from-start line slices block; a from-end or byte slice is one the read tool cannot give, so the command-line rules permit it |
| `routing.cat-pipe` | block | the downstream command decides semantics; `cmd a b` differs from `cat a b \| cmd` for whole-input tools such as `wc` |
| `routing.grep-pipe`, `form.grep-file` | block | grep and rg differ in regex dialect, binary handling, hidden-file rules, and defaults |
| `form.find-discovery`, `form.ls-recursive` | block | find and rg/fd differ on ignore files, hidden entries, and depth semantics; `ls -R` output shape has no equivalent |
| `form.du-traversal` | block | no preferred-form bash rewrite; the class fires on every `du`, scoped or not |
| `form.env-grep` | block | an `env` dump is steerable to `printenv`; a `printenv` dump blocks only when the filter names one variable, which `printenv NAME` covers; a bounded pattern over `printenv` output has no preferred-form equivalent, so the command-line rules permit it |
| `bounds.find-output-uncapped`, `bounds.grep-recursive-uncapped`, `bounds.ls-recursive-uncapped`, `bounds.du-uncapped`, `bounds.rg-files-uncapped`, `bounds.fd-uncapped`, `bounds.false-cap` | block | adding or moving a cap changes the command's output, which is not semantics-preserving |
| `bounds.rg-search-uncapped`, `bounds.git-grep-uncapped` | block | an unscoped search's result set is unbounded; a scoped root or a result cap changes that set, which is not semantics-preserving |
| `agent.<slug>` | block only when promoted | active rules annotate, disabled rules do not classify, and discarded rules are also hidden from listings |

A rule id records a predicate match, not a final verdict, so enforcement
inherits the classifier's command-shape model. A scoped `du -sh node_modules`
still matches `form.du-traversal` and blocks; the block reason states the
preferred form, and the model's reissued command is what the telemetry
compares.

The block reason is unconditional per attempt for blocking classes: each such
call is blocked with the capped, note-deduped `[policy]` line for those classes,
with no per-session filter. Active agent notes are omitted when a co-occurring
built-in or promoted class blocks. A block is returned only after the writer
reserves the record slot for it, so a queue that fills in the meantime cannot
refuse the block's record; a full or closed writer makes the slice stop and lets
the call run unblocked instead. A blocked call's execution-end event arrives in the
same preflight iteration as the block, so its pending entry cannot age or size
out before the record is admitted. Session teardown and store failure follow
the failure contract: a block returned before such a failure can still lose
its record.

Pi runs `tool_call` handlers in extension load order and lets a later handler
mutate `event.input` without re-validation. This slice classifies the input
once, at its own handler position, so it must load after every extension that
mutates a tool input.

## Records

Each paired `tool_call` and `tool_result` builds one record for the active
writer:

| Field | Meaning |
|---|---|
| `at` | ISO 8601 timestamp of the call |
| `session`, `mode`, `cwd` | Session identity and Pi run mode |
| `model` | Active `provider/id`, or `null` when no model is available |
| `thinkingLevel` | Active thinking level, or `null` when none is available |
| `projectContext` | The effective system prompt contains project context |
| `tool`, `callId` | Tool name and call id |
| `durationMs` | Milliseconds between call and result arrival |
| `outputBytes` | Bytes of returned text content, excluding any appended line |
| `truncated` | The tool reported truncation |
| `error` | The tool reported failure |
| `errorKind` | `timeout`, `aborted`, `other`, or `null`; inferred from error text |
| `tokens` | Tokens the tool reported, or `null` |
| `policyMode` | Mechanism active for this call |
| `classes` | Matched rule ids, empty when no rule matched |
| `captured` | Redacted input text, present only when a domain declares a capture |
| `notified` | Present when the operator saw a notice for this call |
| `annotated`, `annotationBytes` | Present when guidance reached the model |
| `blocked` | Present when the call was blocked at the tool boundary |

`mode` holds the Pi run mode and separates the session kinds: a worker records
`print`, an interactive session records `tui`. `policyMode` holds the mechanism.
The two together separate the arms and the regimes in one store.

Pi does not provide a duration, exit code, or timeout flag in these events. The
extension measures duration on event arrival and infers the error kind from
result text. The bash result details provide truncation and a full-output path;
the extension stores the truncation fact only.

`projectContext` detects the `<project_context>` section that Pi adds to an
effective system prompt when context files load. It is a generic fact and does
not depend on another extension's session labels or state. Mutable session,
mode, directory, model, thinking level, and context facts bind to `tool_call`,
so a later context change cannot relabel a call in flight.

A blocked call lacks `tool_result`, so `tool_execution_end` supplies its fallback
outcome. That path runs no mechanism: the tool did not run, and the result
patch surface does not exist there. The `blocked` flag is recorded only when
Pi applied the exact returned reason; an abort that pre-empted the block is
recorded as an error without the flag. A blocked call records `errorKind`
`other` with `error` true, and the flag disambiguates it from a tool failure.
A call blocked by an extension loaded before this slice never reaches this
slice's handler and leaves no record.

A call whose result never arrives is dropped at a fixed age bound, and the
pending map itself has a fixed size bound, so a run with many concurrent calls
cannot hold unbounded memory. A call dropped this way leaves no record even if
its result arrives later: the bound trades completeness for a fixed memory
ceiling. Concurrent calls can append in completion order rather than call
order; use `at` and `callId`, not JSONL line position, for correlation.

## Domains and rules

A domain owns one tool. It declares the text it reads from that tool's input,
the context shape its rules inspect, its rules, and the guidance each rule
carries. `rule.ts` states that contract, `classify.ts` names the active domains
and dispatches by tool, and `shell-rules.ts` is the first domain. The classifier
holds no domain knowledge, so a second domain changes only the domain list.

A rule has an id, a class group, a predicate, and one line of guidance. A call
carries every matched id. No priority collapses co-occurring observations.

Class groups follow the harness command-line rules:

- **routing**: `routing.cat-read`, `routing.cat-pipe`,
  `routing.sed-slice`, `routing.head-slice`, `routing.tail-slice`,
  `routing.inline-script-read`, `routing.grep-pipe`.
- **form**: `form.grep-file`, `form.find-discovery`,
  `form.ls-recursive`, `form.du-traversal`, `form.env-grep`.
- **bounds**: `bounds.find-output-uncapped`,
  `bounds.grep-recursive-uncapped`, `bounds.ls-recursive-uncapped`,
  `bounds.du-uncapped`, `bounds.rg-files-uncapped`, `bounds.fd-uncapped`,
  `bounds.rg-search-uncapped`, `bounds.git-grep-uncapped`,
  `bounds.false-cap`.

`bounds.false-cap` identifies a downstream cap that cannot stop its producer. A
streaming `head` stops a producer through streaming stages. It does not stop a
producer after a stage that consumes all input first. A normal `tail` also does
not stop its producer. Thus, `find … | head` is capped, while
`find … | sort | head` and `find … | tail` are not. A traversal-depth flag does
not clear an output-bound class because traversal and output have separate
bounds.

`rg --files` and `fd` traverse like `find`, so they join the same classes
without a scope exemption. `rg` and `git grep` search the tree recursively; an
unscoped search joins the classes unless a result cap bounds it, while a search
scoped to a named path operand stays clean, because scoping is the output bound
the harness command-line rules prescribe.

## Agent rules

Agent-authored rules live in the append-only `agent-rules.jsonl` file beside
the daily record store: `<dir>/agent-rules.jsonl`, where `<dir>` follows
`PI_POLICY_DIR` or the default agent policy directory. The file does not rotate.
It uses the same private-directory, no-follow, `0600`, checked-append discipline
as records and has a fixed file byte cap. Rule and state records replay in line
order at extension registration.

The match shape is closed and applies only to `bash` stages:

- `tool` is required and is exactly `bash`; `command` is a required exact
  command or an any-of list of exact commands.
- `flags` requires every named short or long flag; `absentFlags` requires every
  named flag to be absent. Combined short flags use the built-in shell reader's
  interpretation.
- `operands.min` and `operands.max` bound operand count, `operands.any` matches
  any exact operand, and numeric keys in `operands.at` constrain exact
  positions. Operand extraction is the same extraction used by built-ins.
- `pipe.from`, `pipe.to`, `pipe.fromRedirect`, and `pipe.toRedirect` constrain
  stream shape. `pipe.next` names the immediately downstream command and
  `pipe.later` names any later command in the same pipeline.

Every present field is conjoined; a matching stage in any statement fires the
rule. Values and lists compare exact strings. There is no regex, glob, arbitrary
negation, or free-form composition. Unknown keys and wrong types are rejected
at every level. Everything outside this vocabulary is a code change with a
test, not data accepted by the registry.

Scope is also closed. Omitting scope applies a rule everywhere. An `exclude`
list denies either a provider or an exact `provider/id`. Alternatively,
`providers` is an allow-list and optional `models` refines it to exact
`provider/id` values. Provider allow-list scope survives a model bump, so new
models inherit a rule by default; only an exact model exclusion or `models`
refinement drops a specific model. A call without a model can use only an
unscoped rule.

Each rule has one posture:

- `active` records and steers through notice or annotation, but never blocks.
- `promoted` blocks in enforce mode.
- `disabled` stays listed but does not classify.
- `discarded` stays in the append-only file but neither classifies nor appears
  in listings; it cannot return to another posture.

Lowering a promoted rule to any other posture requires operator confirmation.
The state tool refuses that transition when `ctx.hasUI` is false, including
print and JSON runs, and records no state change when the operator declines.
Other allowed transitions do not prompt.

The model-facing management surface is:

- `policy_rule_add` validates and appends a model-attributed active rule.
- `policy_rule_list` returns bounded text for every non-discarded rule.
- `policy_rule_set_state` appends an attributed posture transition and applies
  the promoted-rule confirmation gate.

A missing rules file is an empty registry. An unreadable or unparseable file
warns once and leaves built-in classification and recording untouched.
Structurally invalid records are skipped during replay. Agent-rule data
failures never stop recording or change built-in classification. Tool failures
return explanatory text to the model, never call the slice's stop boundary, and
leave the in-memory registry unchanged when an append fails.

### Classification limits

- The shell reader resolves top-level statements, pipelines, quotes, escapes,
  redirects, heredocs, and nested command or process substitutions.
- Nested command bodies are classified separately to a fixed nesting depth and
  remain opaque in their parent stages, so an inner pipeline cannot alter its
  parent's pipeline shape.
- The reader expands no variables, globs, aliases, or generated command words.
- Streaming behavior is a maintained command-shape model in `shell-rules.ts`,
  not a runtime trace. A rule id records a predicate match, not a final verdict.
- Composition alone is not a class. A loop or `xargs` call matches only when a
  rule identifies a specific routed, dispreferred, or unbounded operation.

Because a rule id is an observation rather than a verdict, `annotate` guidance
is advice attached to a shape match. It states the preferred form; it does not
assert that the flagged call was wrong.

The `[policy]` prefix marks the line as harness guidance. It is not an
authenticity proof: tool output can forge the same prefix. The fixed sentence
list remains the authenticity defense for built-in guidance. Agent notes are
validated, model-visible registry text outside that fixed list, so their
provenance cannot be inferred from wording or prefix alone.

## Input privacy

Only the shell domain declares input capture, and it captures `input.command`.
Every other tool contributes outcome facts without its input. Result content
contributes a byte count and error classification, never stored text.

Command redaction is best effort. It removes recognized credential assignments,
JSON fields, headers, long and known short flags, URL credentials, private-key
blocks, bearer values, signed parameters, vendor key shapes, JWTs, and long
opaque base64 shapes. It preserves ordinary similarly named values and commit
hashes. The command is bounded before pattern work and before persistence. An
arbitrary unlabelled short secret has no reliable shape and cannot be identified
from command text alone. Ambiguous short flags use a closed list of known tools;
other tools need a named flag, assignment, or recognized value shape.

Built-in guidance text is fixed in the rule that declares it. Agent guidance is
the bounded, newline-free note stored with its rule. No captured command text,
path, or result content reaches the model through an annotation.

## Configuration

| Variable | Purpose |
|---|---|
| `PI_POLICY_DIR` | Record directory override; default `<agentDir>/policy` |
| `PI_POLICY_MODE` | Active mechanism: `observe` (default), `notice`, `annotate`, or `enforce` |

The directory override must name a trusted private directory. The extension
creates its own directory with mode `0700`, or accepts an existing directory
only when group or other users have no access. On platforms with numeric user
IDs, the current user must also own it. The extension refuses a symbolic-link
directory. Each daily `<dir>/YYYY-MM-DD.jsonl` file uses mode `0600` and refuses
a symbolic-link final path where the platform provides `O_NOFOLLOW`. Each record
uses one checked `O_APPEND` write so concurrent session processes cannot share a
file offset or silently accept a partial record.

## Failure and latency contract

Every event-handler body catches its own failures. Failure reporting also
catches hostile thrown values and a failing console. The first recording or
mechanism failure stops those mechanisms for the session, enforcement included,
and attempts one `console.warn`; it does not escape the handler. A failed slice
therefore lets calls through unblocked: the extension fails open, and the single
recording warning is the signal that enforcement is off. Store failures return
data to this boundary instead of throwing. A failure inside a mechanism
therefore stops the slice and leaves the tool result unchanged; it never reaches
the tool call. Agent-rule load and tool failures follow their separate,
built-ins-only degradation contract and never invoke this stop path.

Pi awaits `tool_result` handlers. The handler derives the record, decides the
mechanism effect, admits the record, and returns without waiting for
filesystem work. A bounded serial writer owns the append order and catches every
background rejection. Admission is synchronous: when the queue is full or closed,
the record is not accepted, and the notice and annotation for that call are
withheld with it. A block reserves its record slot before the block is
returned, so the reserved call's admission cannot be refused by a queue that
filled in the meantime. A store failure that surfaces during a background write
discards remaining queued records because the destination is unavailable; a
decision already returned before that failure keeps its record's fate tied to
the writer's. `session_shutdown` first closes queue admission and
then waits for the final accepted write; an active tool result and the next
model turn do not.

## Boundaries

The extension has no input mutation and accepts no predicates beyond the closed
agent match and scope schemas. Agent rules apply only to the existing shell
domain and use the same parser, flag reader, and operand reader as built-ins.
`annotate` mode and active-only matches in `enforce` mode can append guidance to
a successful tool result. `enforce` is the only mode that returns model-visible
text as a block reason. A successful flagged call receives at most one capped
line, and only for rule ids this session has not already annotated. No mode
changes a tool input: blocking classes block rather than rewrite, because no
rewrite is provably semantics-preserving and Pi does not re-validate a mutated
input.
