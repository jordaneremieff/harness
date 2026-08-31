# policy

Records paired, completed tool calls and their outcomes against declarative
rules, and runs the one mechanism the active mode selects.

The records support comparison of command classes by duration, output size,
truncation, and failure. No mode changes a tool input or adds a rule language;
only `enforce` blocks a flagged call.

## Modes

`PI_POLICY_MODE` selects one mechanism. Every mode records. The modes are
exclusive, so a recorded effect belongs to one mechanism.

| Mode | Mechanism | Model-visible | Operator-visible |
|---|---|---|---|
| `observe` (default) | none | no | no |
| `notice` | a terminal flag on each flagged call | no | yes, in TUI mode |
| `annotate` | one guidance line on a successful flagged call with remaining ids | yes | no |
| `enforce` | block the flagged call with a reason that names the preferred form | yes, as the block result | no |

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

The extension blocks a flagged call at the `tool_call` boundary. The block
result carries a reason that names the preferred form: the same `[policy]`
guidance line the annotation uses, so both mechanisms say the same thing. The
model receives the reason as the call's error result and can reissue the
command in the preferred form.

Every flagged class blocks. No class rewrites in place, because Pi performs no
re-validation after a handler mutates `event.input`, and no rewrite of a
flagged form is provably semantics-preserving:

| Class | Disposition | Why no rewrite |
|---|---|---|
| `routing.cat-read`, `routing.sed-slice`, `routing.head-slice`, `routing.tail-slice`, `routing.inline-script-read` | block | the preferred form is the read tool; no bash form exists, and an inline script may do arbitrary work beyond the read |
| `routing.cat-pipe` | block | the downstream command decides semantics; `cmd a b` differs from `cat a b \| cmd` for whole-input tools such as `wc` |
| `routing.grep-pipe`, `form.grep-file` | block | grep and rg differ in regex dialect, binary handling, hidden-file rules, and defaults |
| `form.find-discovery`, `form.ls-recursive` | block | find and rg/fd differ on ignore files, hidden entries, and depth semantics; `ls -R` output shape has no equivalent |
| `form.du-traversal` | block | no preferred-form bash rewrite; the class fires on every `du`, scoped or not |
| `form.env-grep` | block | a pattern can match several variables (`PATH`, `MANPATH`); `printenv` prints one |
| `bounds.find-output-uncapped`, `bounds.grep-recursive-uncapped`, `bounds.ls-recursive-uncapped`, `bounds.du-uncapped`, `bounds.false-cap` | block | adding or moving a cap changes the command's output, which is not semantics-preserving |

A rule id records a predicate match, not a final verdict, so enforcement
inherits the classifier's command-shape model. A scoped `du -sh node_modules`
still matches `form.du-traversal` and blocks; the block reason states the
preferred form, and the model's reissued command is what the telemetry
compares.

The block reason is unconditional per attempt: every flagged call is blocked
with the capped, note-deduped `[policy]` line for that call's classes, with no
per-session filter. A block is returned only after the writer reserves the
record slot for it, so a block never exists without its record; a full or
closed writer makes the slice stop and lets the call run unblocked instead.

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
mode, directory, and context facts bind to `tool_call`, so a later session
change cannot relabel a call in flight.

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
  `bounds.du-uncapped`, `bounds.false-cap`.

`bounds.false-cap` identifies a downstream cap that cannot stop its producer. A
streaming `head` stops a producer through streaming stages. It does not stop a
producer after a stage that consumes all input first. A normal `tail` also does
not stop its producer. Thus, `find … | head` is capped, while
`find … | sort | head` and `find … | tail` are not. A traversal-depth flag does
not clear an output-bound class because traversal and output have separate
bounds.

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
list is the defense, so a line outside that list is not genuine policy
guidance.

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

Guidance text is fixed in the rule that declares it. No captured command text,
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

Every handler body catches its own failures. Failure reporting also catches
hostile thrown values and a failing console. The first internal failure stops
every mechanism for the session, enforcement included, and attempts one
`console.warn`; it does not escape the handler. A failed slice therefore lets
calls through unblocked: the extension fails open, and the single warning is
the signal that enforcement is off. Store failures return data to this boundary instead of throwing. A
failure inside a mechanism therefore stops the slice and leaves the tool result
unchanged; it never reaches the tool call.

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

The extension has no input mutation, no rule language, no configuration
schema, and no predicate engine. It defines no rules outside the shell domain.
`annotate` is the only path that appends text to a tool result. `enforce` is
the only path that returns model-visible text as a block reason. A successful
flagged call receives at most one capped line, and only for rule ids this
session has not already annotated. `enforce` blocks only in enforce mode. No
mode changes a tool input: every flagged form blocks rather than rewrites,
because no rewrite is provably semantics-preserving and Pi does not
re-validate a mutated input.
