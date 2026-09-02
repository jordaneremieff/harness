# policy

Records paired, completed tool calls and their outcomes against declarative
built-in rules, and runs the one mechanism the active mode selects.

The records support comparison of command classes by duration, output size,
truncation, and failure. Built-in classes are fixed in code. No mode changes a
tool input.

## Modes

The string extension flag `--policy-mode` selects the session mechanism. Its
accepted values are `observe`, `notice`, `annotate`, and `enforce`. When the flag
is omitted, `PI_POLICY_MODE` selects the mechanism. The flag takes precedence
when both are set. An omitted or blank environment value defaults to `observe`.
Every mode records.

| Mode | Mechanism | Model-visible | Operator-visible |
|---|---|---|---|
| `observe` (default) | none | no | no |
| `notice` | a terminal flag on each flagged call | no | yes, in TUI mode |
| `annotate` | one guidance line on a successful flagged call with remaining ids | yes | no |
| `enforce` | block every call matched by a built-in rule | yes | no |

An unrecognized flag or environment value is a configuration error. The
extension reports it once, names the accepted set and invalid source, and stops
recording for the session.

### notice

The extension calls `ui.notify` once per flagged call with the matched rule ids.
It shows nothing when no rule matched, and nothing outside TUI mode. It never
patches the tool result.

### annotate

The extension appends one line to the result content of a successful flagged
call. The line carries the guidance the matched rules declare, prefixed with
`[policy]` so the model does not read it as tool output.

Bounds on the line:

- One rule id reaches the model at most once per session.
- Rules that share wording contribute one line.
- The line has a fixed byte cap. Ids outside the cap remain available later.
- A failed call receives no line because its error text already carries signal.

### enforce

The extension blocks a flagged call at the `tool_call` boundary. The block
result carries the same capped `[policy]` guidance line used by annotation. The
model receives the reason as the call's error result and can issue the preferred
form.

No class rewrites in place. Pi performs no re-validation after a handler mutates
`event.input`, and no rewrite of a flagged form is provably
semantics-preserving:

| Class | Why no rewrite |
|---|---|
| `routing.cat-read`, `routing.sed-slice`, `routing.inline-script-read` | The preferred form is the read tool, not a bash command. |
| `routing.head-slice`, `routing.tail-slice` | Only slices the read tool supports block; other slice forms remain permitted. |
| `routing.cat-pipe` | The downstream command decides semantics. |
| `routing.grep-pipe`, `form.grep-file` | grep and rg differ in regex dialect, binary handling, hidden-file rules, and defaults. |
| `form.find-discovery`, `form.ls-recursive` | find, rg, fd, and ls differ in ignore rules, hidden entries, depth, and output shape. |
| `form.du-traversal` | No preferred-form bash rewrite exists. |
| `form.env-grep` | A safe replacement depends on whether the filter names one variable. |
| `bounds.*` | Adding or moving a cap changes the command output. |

A rule id records a predicate match, not a final verdict. Enforcement therefore
inherits the classifier's command-shape model.

A block is returned only after the writer reserves its record slot. A full or
closed writer stops the slice and lets the call run unblocked. A block returned
before a later store failure can still lose its record.

Pi runs `tool_call` handlers in extension load order and lets a later handler
mutate `event.input` without re-validation. This slice classifies the input once
at its own handler position. Load it after every extension that mutates a tool
input.

## Operator command

`/policy` opens an operator-only overlay in TUI mode. The overlay starts in the
Rules view and toggles between Rules and Activity with `v`. It reads built-in
policy definitions and telemetry. Browser failures do not stop recording or
enforcement.

### Rules view

Built-ins appear as collapsed `routing`, `form`, and `bounds` summary rows. A
summary shows its live rule count and the sum of its members' fire counts. `g`
expands or collapses the selected group. Expanded members show id, note, and
individual fires. The detail pane includes the per-model fire evidence.

The fire scan reads at most 4 MiB across daily store data. A partial scan is
marked in the title and detail pane.

Rules-view keys:

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `b` / `space` | Page the detail pane backward / forward |
| `v` | Toggle Rules and Activity |
| `g` | Expand or collapse the selected built-in group |
| `/` | Enter the text filter; `Enter` or `Escape` leaves filter entry |
| `Escape` | Close the overlay |

### Activity view

Activity shows recent records with non-empty `classes`, newest by `at`. Columns
show time, recorded model, rule ids, blocked status, and the stored redacted
command. The extension never reconstructs the original command.

The Activity reader examines daily JSONL tails newest-first. It reads at most
4 MiB and returns at most 200 matching records. Reaching either limit marks the
view as partial.

### Text verbs

The text surface works without a TUI:

- `/policy list` prints every built-in group and member.
- `/policy show <id>` prints complete built-in detail and per-model fires.
- `/policy mode` prints the active mode, its source, and its behavior.
- `/policy help` prints command usage.

Bare `/policy` outside TUI mode reports that the panel is unavailable and names
the text verbs. RPC receives command text through its UI notification channel.
JSON mode receives a non-context custom entry. Print mode writes text to
standard output.

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
| `outputBytes` | Bytes of returned text content, excluding appended guidance |
| `truncated` | The tool reported truncation |
| `error` | The tool reported failure |
| `errorKind` | `timeout`, `aborted`, `other`, or `null` |
| `tokens` | Tokens the tool reported, or `null` |
| `policyMode` | Mechanism active for this call |
| `classes` | Matched built-in rule ids |
| `captured` | Redacted input text when the domain declares a capture |
| `notified` | Present when the operator saw a notice |
| `annotated`, `annotationBytes` | Present when guidance reached the model |
| `blocked` | Present when this extension blocked the call |

Pi does not provide a duration, exit code, or timeout flag in these events. The
extension measures duration on event arrival and infers the error kind from
result text. It stores the bash truncation fact, not the full-output path.

`projectContext` detects the `<project_context>` section in the effective system
prompt. Mutable session, mode, directory, model, thinking level, and context
facts bind to `tool_call`, so a later context change cannot relabel a call.

A blocked call lacks `tool_result`, so `tool_execution_end` supplies its
fallback outcome. The `blocked` flag is recorded only when Pi applied the exact
returned reason. An abort that pre-empted the block records an error without the
flag. A call blocked by an earlier extension leaves no record here.

A call whose result never arrives is dropped at a fixed age bound. The pending
map also has a fixed size bound. Concurrent calls can append in completion
order. Use `at` and `callId`, not JSONL line position, for correlation.

## Domains and rules

A domain owns one tool. It declares the text it reads, the context shape its
rules inspect, its rules, and each rule's guidance. `rule.ts` states that
contract. `classify.ts` names the active domains. `shell-rules.ts` owns the shell
domain.

A rule has an id, a class group, a predicate, and one guidance line. A call
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
streaming `head` stops a producer through streaming stages. An `awk` stage also
stops it when the script exits early. A sort, normal tail, or range-only awk
stage consumes all input first and does not cap the producer. A traversal-depth
flag does not clear an output-bound class.

`fd --max-results N` and `fd -N` stop traversal at the count and clear the fd
bound class. `rg --files` has no equivalent result flag. `rg --max-count` bounds
matches per file and does not bound file discovery.

An unscoped `rg` or `git grep` search joins its search-bound class unless a
result cap bounds it. A search scoped to a named path operand remains clean.

`routing.inline-script-read` names a short inline script that only reads a file.
A script longer than 200 bytes or two lines remains permitted. A script with a
loop, definition, context manager, error handler, or import also remains
permitted.

A stage that requests its own usage or version carries no traversal, read, or
search. `--help`, `--version`, and `-V` leave that stage unclassified. Later
stages of the same pipeline still classify normally.

### Classification limits

- The shell reader resolves top-level statements, pipelines, quotes, escapes,
  redirects, heredocs, and nested command or process substitutions.
- Nested command bodies classify separately to a fixed depth.
- The reader expands no variables, globs, aliases, or generated command words.
- Streaming behavior is a maintained command-shape model, not a runtime trace.
- Composition alone is not a class.

Because a rule id is an observation rather than a verdict, `annotate` guidance
states the preferred form. It does not assert that the call was wrong.

The `[policy]` prefix marks harness guidance. It is not an authenticity proof.
The fixed built-in sentence list is the authenticity defense.

## Input privacy

Only the shell domain declares input capture, and it captures `input.command`.
Every other tool contributes outcome facts without its input. Result content
contributes a byte count and error classification, never stored text.

Command redaction is best effort. It removes recognized credentials, headers,
secret flags, URL credentials, private keys, bearer values, signed parameters,
known key shapes, JWTs, and long opaque base64 shapes. It preserves ordinary
similarly named values and commit hashes. The extension bounds commands before
pattern work and persistence.

Built-in guidance text is fixed in the rule that declares it. No captured
command, path, or result content reaches the model through annotation.

## Configuration

| Setting | Purpose |
|---|---|
| `PI_POLICY_DIR` | Record directory override; default `<agentDir>/policy` |
| `--policy-mode` | Session mechanism flag; overrides `PI_POLICY_MODE` |
| `PI_POLICY_MODE` | Active mechanism: `observe` (default), `notice`, `annotate`, or `enforce` |

The directory override must name a trusted private directory. The extension
creates its directory with mode `0700`, or accepts an existing directory only
when group and other users have no access. The current user must own it on
platforms with numeric user IDs. The extension refuses a symbolic-link
directory.

Each daily `<dir>/YYYY-MM-DD.jsonl` file uses mode `0600` and refuses a
symbolic-link final path where `O_NOFOLLOW` exists. Each record uses one checked
`O_APPEND` write so concurrent sessions cannot share a file offset or silently
accept a partial record.

## Failure and latency contract

Every event-handler body catches its own failures. Failure reporting also
catches hostile thrown values and a failing console. The first recording or
mechanism failure stops the slice for the session, including enforcement, and
attempts one `console.warn`. It does not escape the handler. The extension fails
open, and the warning signals that enforcement is off.

Pi awaits `tool_result` handlers. The handler derives the record, decides the
mechanism effect, admits the record, and returns without waiting for filesystem
work. A bounded serial writer owns append order and catches every background
rejection.

Admission is synchronous. When the queue is full or closed, the record is not
accepted, and the notice or annotation is withheld. A block reserves its slot
before return. `session_shutdown` closes queue admission and waits for the final
accepted write.

## Boundaries

The extension accepts no runtime policy definitions. All predicates and
guidance are fixed in the built-in shell domain. `annotate` is the only mode
that appends guidance to a successful tool result. `enforce` is the only mode
that returns a block reason. No mode changes a tool input.
