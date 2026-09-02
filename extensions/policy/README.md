# policy

Records paired, completed tool calls and their outcomes against declarative
rules, and runs the one mechanism the active mode selects.

The records support comparison of command classes by duration, output size,
truncation, and failure. Built-in classes are fixed in code; agent-authored
classes use a closed shell-stage vocabulary, an optional structured suggested
form, and an explicit per-rule posture. No mode changes a tool input.

## Modes

The string extension flag `--policy-mode` selects the session mechanism. Its
accepted values are `observe`, `notice`, `annotate`, and `enforce`. When the flag
is omitted, `PI_POLICY_MODE` selects the mechanism; when both are set, the flag
takes precedence. An omitted or blank environment value defaults to `observe`.
Every mode records. Rule posture and scope refine enforce mode: built-in classes
and in-scope promoted agent rules block, while in-scope active agent rules steer
by annotation instead. Scoped-out agent classes still record.

| Mode | Mechanism | Model-visible | Operator-visible |
|---|---|---|---|
| `observe` (default) | none | no | no |
| `notice` | a terminal flag on each flagged call | no | yes, in TUI mode |
| `annotate` | one guidance line on a successful flagged call with remaining ids | yes | no |
| `enforce` | block built-ins and in-scope promoted agent classes; annotate successful calls with in-scope active agent guidance when no class blocks | yes | no |

## Operator command

`/policy` opens an operator-only overlay in TUI mode. The overlay starts in the
Rules view and toggles between Rules and Activity with `v`. It reads policy
state and telemetry; it does not sit inside the per-call recording boundary, so
a browser or command failure cannot stop recording or enforcement.

### Rules view

Agent rules appear first. Their columns show origin, slug, registry state,
effective posture (`steer`, `block`, or `off`), scope summary, total fires,
author model, and age. Selecting one shows its complete note, structured match,
optional suggested form, optional scope, author attribution, total fires, and a
fire breakdown by recorded model. The breakdown comes from the `model` field on
each bounded-store record carrying the class id; a missing model has its own
bucket.

Built-ins appear as collapsed `routing`, `form`, and `bounds` summary rows. A
summary shows its live rule count from `shell-rules.ts` and the sum of its
members' fire counts. `g` expands or collapses the selected group in place.
Expanded members show id, note, and individual fires; their detail pane includes
the same per-model evidence as agent rules. With no agent rules, the group rows
still render and a short hint points to Activity's draft action.

Rules-view keys:

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `b` / `space` | Page the detail pane backward / forward |
| `v` | Toggle Rules and Activity |
| `g` | Expand or collapse the selected built-in group |
| `/` | Enter the text filter; `Enter` or `Escape` leaves filter entry |
| `p` | Promote the selected agent rule |
| `m` | Demote the selected agent rule to active |
| `x` | Disable the selected agent rule |
| `a` | Enable the selected agent rule as active |
| `d` | Discard the selected agent rule |
| `c` | Copy the complete selected agent rule as formatted JSON |
| `Escape` | Close the overlay |

Demotion and discard ask for operator confirmation. Any other action that lowers
a promoted rule retains the registry's existing lowering confirmation gate.
Every accepted change calls `AgentRules.setState`; the panel never appends or
rewrites the registry itself. Discard remains terminal. A state key on an
expanded built-in member stays visible but reports that built-ins are code and
change by commit.

The totals and per-model breakdown reuse the registry fire scan and its
`MAX_FIRE_SCAN_BYTES` bound (32 MiB across daily store data). A partial scan is
marked in the title and detail pane rather than presented as complete.

### Activity view

Activity shows recent records with non-empty `classes`, newest by `at`. Columns
show time, recorded model, rule ids, blocked status, and the stored redacted
command. The extension never rereads or reconstructs the original command for
this view.

The Activity reader examines daily JSONL tails newest-first. It reads at most
4 MiB and returns at most 200 matching records. Reaching either limit is marked
as partial in the view. Press `d` on a record to close the panel and send a user
message asking the active model to author a focused rule with `policy_rule_add`.
That message includes the stored redacted command as a JSON string, the matched
rule ids, and the recorded model, and warns against reconstructing redacted
values. It uses `sendUserMessage` immediately when idle or as a `followUp` when
a turn is active.

### Text verbs

The text surface works without a TUI:

- `/policy list` prints agent columns plus every built-in group and member.
- `/policy show <slug-or-id>` prints complete agent or built-in detail, including
  the per-model fire breakdown and any partial marker. Agent class ids with the
  `agent.` prefix are accepted as well as bare slugs.
- `/policy history <slug>` prints the append-only state-transition audit history
  for an agent rule, newest first.
- `/policy state <slug> <active|promoted|disabled|discarded>` uses the same
  confirmation and `AgentRules.setState` path as panel actions. A transition
  requiring confirmation is refused when no dialog-capable UI exists.
- `/policy capture <hint...>` records an in-session rule-authoring request and
  starts the capture orchestration described below.
- `/policy criteria` prints the versioned promotion criteria source and its
  implemented checks.
- `/policy mode` prints the active policy and promotion modes, their flag,
  environment, or default sources, the policy mode's one-line behavior, and a
  reminder that a session keeps the modes it resolved at startup.
- `/policy help` prints command usage.

Bare `/policy` outside TUI mode reports that the interactive panel is
unavailable and names the text verbs. RPC receives command text through its UI
notification channel, JSON mode receives a non-context custom entry, and print
mode writes text to standard output.

An unrecognized flag or environment value is a configuration error. The
extension reports it once, names the accepted set and invalid source, and stops
recording for the session.

### Capture

The operator invokes `/policy capture <hint>` at the moment behavior should
become a candidate rule. The command records the hint, session, and timestamp in
the append-only registry and appends a visible in-session entry. The operator's
invocation is the approval; there is no later approval gate.

The current agent's only job is orchestration. It packages a bounded, redacted
excerpt of session context at the invocation point, dispatches authoring to a
separate clean-context worker using the worker model required by the delegation
contract, applies the returned rule through `policy_rule_add`, and reports the
applied rule. The authoring agent is never the current session agent: the agent
whose behavior is regulated cannot author the rule about itself.

The authoring worker interprets the hint and supplied context into an agent rule
within the current registry vocabulary: the closed shell-match schema documented
in Agent rules. It keeps the plain-language source with the rule as its `note`
and returns the proposed rule. If the hint targets a surface outside the shell
vocabulary, the worker reports it as out-of-vocabulary and names that surface;
it never stretches the hint into a rule that means something else. A candidate
lands in `active` state through the existing add path. Promotion then follows
the warrant mechanism.

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

Every built-in class blocks. A promoted agent class blocks only when its scope
allows the current model. An active agent class always records and, when its
scope allows the model, steers: if no blocking class co-occurs, a successful
call receives the normal capped annotation. A scoped-out class neither blocks
nor contributes guidance. No class rewrites in place, because Pi performs no
re-validation after a handler mutates `event.input`, and no rewrite of a
flagged form is provably semantics-preserving:

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
| `agent.<slug>` | block only when promoted and in scope | active rules annotate only in scope; scoped-out classes still record, disabled rules do not classify, and discarded rules are also hidden from listings |

A rule id records a predicate match, not a final verdict, so enforcement
inherits the classifier's command-shape model. A scoped `du -sh node_modules`
still matches `form.du-traversal` and blocks; the block reason states the
preferred form, and the model's reissued command is what the telemetry
compares.

The block reason is unconditional per attempt for blocking classes: each such
call is blocked with the capped, note-deduped `[policy]` line for those classes,
with no per-session filter. Scoped-out agent notes are always omitted, and
active in-scope agent notes are omitted when a co-occurring built-in or
promoted class blocks. A block is returned only after the writer
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
order at extension registration. Every rule record carries the rule-schema
version that wrote it. Schema transitions are declared additive or breaking in
source. Current-version records load directly; older records load only when
every intervening transition is additive. The transition from version 1 to 2 is
additive because it added only the optional `suggest` field. Loading preserves
the record's version and leaves the append-only file byte-stable. A missing
version, a version newer than this build, or an older version crossing a
breaking transition is skipped with one warning; a newer-version warning names
both the record and build versions. Every version after the first requires a
transition declaration, and breaking transitions require an explicit migration
before older records can load. State records carry no schema version.

Every newly written state line records its origin: `tool` for
`policy_rule_set_state`, and `command` for `/policy state` and panel actions.
Lines written before origin tracking existed remain valid on replay and display
as `unknown`; replay does not invent attribution. Legacy promoted lines without
a warrant also keep replaying, and history leaves their warrant absent.
`/policy history <slug>` is the audit surface for these transitions. It shows
origin, model, session, timestamp, and any promotion warrant and verdict.

Promotion requires a recorded warrant. The plain-language source lives in
`PROMOTION_CRITERIA_SOURCE` at criteria version 1 and is:

> Promote a rule only when the recorded history of its matching calls shows the pattern the rule blocks actually fails. The history must hold enough matching calls to rule out chance, and failures must outnumber successes among those calls. A rule whose matching calls mostly succeed must not promote. A promotion without recorded evidence must be refused. Record the measured evidence, the criteria version, and the judgment with every promotion.

The implemented evidence check requires at least 5 matching calls, failures to
strictly outnumber successes, and a complete bounded scan. Exactly half failures
does not pass, and a partial scan refuses. A warrant records fires, failures by
error kind, truncation, scan completeness, the criteria version, and the
judgment. In promotion mode `agent`, the agent state tool requires a passing
warrant and refuses with the measured facts and failed checks. In promotion mode
`operator`, that tool directs promotion to `/policy state`. The operator command
and panel always measure and record the warrant and its verdict but never block
promotion on the verdict. The registry's suggested-form collision check still
applies to every promotion path.

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

The optional `suggest` object names one machine-checkable preferred shell form.
Its required `command` is one exact, slash-free command name. Its only optional
field is a non-empty `flags` list of exact normalized short or long flag names,
without leading hyphens or attached values. The form is a standalone stage
containing that command and those flags, with no operands,
redirects, or pipeline. Required flags are included because both agent matches
and built-in predicates distinguish forms such as `ls` from `ls -R`; operands,
patterns, regex, and free-form shell text are deliberately not accepted.

At add time, a declared form is evaluated with the same built-in predicates and
agent match evaluator used for calls. The prospective active rule participates
in that check, so a rule cannot suggest a form it flags itself. Every other
currently active or promoted agent rule participates, as do all built-in shell
rules. Disabled and discarded rules do not. Before any transition to
`promoted`, the target's form is checked against the full prospective registry,
and every form declared by another currently active or promoted rule is checked
against the target's prospective match. This catches both a target whose
suggestion became flagged after authoring and a target that would newly block
another rule's suggestion, without making unrelated conflicts reject the
transition. A match refuses the append and names every class conflicting with
the target's form, or names the target when it conflicts with another form; the
in-memory posture therefore stays unchanged. These checks are independent of
scope:
scope still gates only what a model hears, not classification or registry-wide
form safety. A rule may omit `suggest` for guidance outside this deliberately
small shell vocabulary; its prose `note` is never parsed to infer a form.

Scope is also closed, but it never participates in classification. Every
matching active or promoted rule classifies and records against every model.
Scope gates only what the model hears: whether the rule supplies a note,
contributes an annotation, or blocks. A scoped-out class therefore remains in
the record as evidence without nagging or blocking that model.

Omitting scope makes those model-visible mechanisms available everywhere. An
`exclude` list denies either a provider or an exact `provider/id`.
Alternatively, `providers` is an allow-list and optional `models` refines it to
exact `provider/id` values. Provider allow-list scope survives a model bump, so
new models inherit the rule's mechanisms by default; only an exact model
exclusion or `models` refinement drops them for a specific model. A call
without a model records every matching class but hears only from unscoped
rules.

Each rule has one posture:

- `active` always records, can raise the operator-visible notice, and when in
  scope can annotate, but never blocks.
- `promoted` always records, can raise the notice, and blocks in enforce mode
  only when in scope.
- `disabled` stays listed but does not classify.
- `discarded` stays in the append-only file but neither classifies nor appears
  in listings; it cannot return to another posture.

Lowering a promoted rule to any other posture requires operator confirmation.
The state tool refuses that transition when `ctx.hasUI` is false, including
print and JSON runs, and records no state change when the operator declines.
Other allowed transitions do not prompt.

The model-facing management surface is:

- `policy_rule_add` validates the match, optional suggested form, and scope,
  refuses a suggested form matched by an enabled or built-in class, and appends
  a model-attributed active rule.
- `policy_rule_list` returns bounded text for every non-discarded rule,
  including its optional suggested form and firing count from the daily record
  store. If the bounded store scan cannot finish, the output ends with `firing
  counts partial: store scan exceeded the byte bound`.
- `policy_rule_set_state` requires a passing measured warrant for promotion in
  `agent` promotion mode, refuses tool promotion in `operator` promotion mode,
  rechecks declared suggested forms, and records tool origin on accepted state
  transitions. The promoted-rule lowering confirmation gate still applies.

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

| Setting | Purpose |
|---|---|
| `PI_POLICY_DIR` | Record directory override; default `<agentDir>/policy` |
| `--policy-mode` | Session mechanism flag; overrides `PI_POLICY_MODE` |
| `PI_POLICY_MODE` | Active mechanism: `observe` (default), `notice`, `annotate`, or `enforce` |
| `--policy-promotion-mode` | Session promotion flag; overrides `PI_POLICY_PROMOTION_MODE` |
| `PI_POLICY_PROMOTION_MODE` | Promotion authority: `agent` (default) or `operator` |

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
agent match, suggested-form, and scope schemas. Agent-rule notes remain prose
and are never parsed; only an explicitly declared `suggest` form is checked
against built-in and enabled agent rules. Agent rules apply only to the existing
shell domain and use the same parser, flag reader, and operand reader as
built-ins.
`annotate` mode and active-only matches in `enforce` mode can append guidance to
a successful tool result. `enforce` is the only mode that returns model-visible
text as a block reason. A successful flagged call receives at most one capped
line, and only for rule ids this session has not already annotated. No mode
changes a tool input: blocking classes block rather than rewrite, because no
rewrite is provably semantics-preserving and Pi does not re-validate a mutated
input.
