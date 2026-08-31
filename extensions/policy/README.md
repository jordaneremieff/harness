# policy

Records paired, completed tool calls and their outcomes against declarative
rules while observation remains active.

The extension observes. Its handlers return no result object, mutate no input,
and emit no model-visible text. The records support comparison of command
classes by duration, output size, truncation, and failure.

## Records

Each paired `tool_call` and `tool_result` builds one record for the active
writer:

| Field | Meaning |
|---|---|
| `at` | ISO 8601 timestamp of the call |
| `session`, `mode`, `cwd` | Session identity and run mode |
| `projectContext` | The effective system prompt contains project context |
| `tool`, `callId` | Tool name and call id |
| `durationMs` | Milliseconds between call and result arrival |
| `outputBytes` | Bytes of returned text content |
| `truncated` | The tool reported truncation |
| `error` | The tool reported failure |
| `errorKind` | `timeout`, `aborted`, `other`, or `null`; inferred from error text |
| `tokens` | Tokens the tool reported, or `null` |
| `classes` | Matched rule ids, empty when no rule matched |
| `command` | Redacted input, present only when rules declare input capture |

Pi does not provide a duration, exit code, or timeout flag in these events. The
extension measures duration on event arrival and infers the error kind from
result text. The bash result details provide truncation and a full-output path;
the extension stores the truncation fact only.

`projectContext` detects the `<project_context>` section that Pi adds to an
effective system prompt when context files load. It is a generic fact and does
not depend on another extension's session labels or state. Mutable session,
mode, directory, and context facts bind to `tool_call`, so a later session
change cannot relabel a pending call.

A blocked call lacks `tool_result`, so `tool_execution_end` supplies its fallback
outcome. Any call that receives neither event expires and also has a fixed
memory bound. Concurrent calls can append in
completion order rather than call order; use `at` and `callId`, not JSONL line
position, for correlation.

## Rules

A rule in `rules.ts` has an id, class group, tool, and code-level predicate. A
call carries every matched id. No priority collapses co-occurring observations.

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
- Streaming behavior is a maintained command-shape model in `rules.ts`, not a
  runtime trace. A rule id records a predicate match, not a final verdict.
- Composition alone is not a class. A loop or `xargs` call matches only when a
  rule identifies a specific routed, dispreferred, or unbounded operation.

## Input privacy

Only `bash` declares input capture, and it captures `input.command`. Every other
tool contributes outcome facts without its input. Result content contributes a
byte count and error classification, never stored text.

Command redaction is best effort. It removes recognized credential assignments,
JSON fields, headers, long and known short flags, URL credentials, private-key
blocks, bearer values, signed parameters, vendor key shapes, JWTs, and long
opaque base64 shapes. It preserves ordinary similarly named values and commit
hashes. The command is bounded before pattern work and before persistence. An arbitrary
unlabelled short secret has no reliable shape and cannot be identified from
command text alone. Ambiguous short flags use a closed list of known tools;
other tools need a named flag, assignment, or recognized value shape.

## Configuration

| Variable | Purpose |
|---|---|
| `PI_POLICY_DIR` | Record directory override; default `<agentDir>/policy` |

The override must name a trusted private directory. The extension creates its
own directory with mode `0700`, or accepts an existing directory only when
group or other users have no access. On platforms with numeric user IDs, the
current user must also own it. The extension refuses a symbolic-link directory.
Each daily `<dir>/YYYY-MM-DD.jsonl` file uses mode `0600` and refuses a
symbolic-link final path where the platform provides `O_NOFOLLOW`. Each record
uses one checked `O_APPEND` write so concurrent session processes cannot share a
file offset or silently accept a partial record.

## Failure and latency contract

Every handler body catches its own failures. Failure reporting also catches
hostile thrown values and a failing console. The first internal failure stops
recording for the session and attempts one `console.warn`; it does not escape
the handler. Store failures return data to this boundary instead of throwing.

Pi awaits `tool_result` handlers. The handler derives and enqueues the record,
then returns without waiting for filesystem work. A bounded serial writer owns
the append order and catches every background rejection. A full queue stops
new recording and preserves records already accepted. A store failure discards
remaining queued records because the destination is unavailable.
`session_shutdown` first closes queue admission and then waits for the final
accepted write; an active tool result and the next model turn do not.

## No action layer

The extension has no block, rewrite, model warning, input mutation, rule
language, configuration schema, or predicate engine. It defines no rules outside
the shell domain.
