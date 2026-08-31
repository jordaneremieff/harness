# policy

Records what every tool call did and what it cost, against declarative rules.

The slice observes. It returns no handler result, so it blocks no call and
changes no input, and it emits no model-visible text, so it adds no context and
costs no tokens. Its output is a private JSONL record set that answers one
question: which command classes actually cost time, output, and failures, in
which kind of session.

## What it records

One record per completed tool call:

| Field | Meaning |
|---|---|
| `at` | ISO 8601 timestamp of the call |
| `session`, `mode`, `cwd` | Session identity and run mode |
| `projectContext` | The effective system prompt carries project context files |
| `tool`, `callId` | Tool name and call id |
| `durationMs` | Milliseconds between the call and its result, measured by this slice |
| `outputBytes` | Bytes of text content returned |
| `truncated` | The tool reported truncation |
| `error` | The tool reported failure |
| `errorKind` | `timeout`, `aborted`, `other`, or `null`; inferred from error text |
| `tokens` | Tokens the tool itself reported, or `null` |
| `classes` | Matched rule ids, empty when the call matched no rule |
| `command` | Redacted input, present only for a tool whose rules declare a capture |

`durationMs` and `errorKind` are derived, not read. No Pi event carries a
duration, an exit code, or a timeout flag: the bash result details carry
truncation and a full-output path only. The slice stamps `tool_call` and
`tool_result` on arrival and pairs them by call id, and it infers `errorKind`
from the error text.

`projectContext` is the generic signal that separates session kinds. Pi writes a
`<project_context>` section into the system prompt when it loads context files,
and a clean-context session has none. The record stores the fact; it names no
session kind and reads no other extension's state.

## Rules

A rule is a code-level entry in `rules.ts`: an id, a class group, the tool it
reads, and a predicate over that tool's call. A call carries every class it
matches. Matches are not collapsed by priority, because co-occurrence is the
part analysis needs.

Class groups follow the harness command-line rules:

- **routing** — the shell runs work that a bounded tool or a narrower request
  owns: `routing.cat-read`, `routing.cat-pipe`, `routing.sed-slice`,
  `routing.inline-script-read`, `routing.grep-pipe`.
- **form** — a dispreferred command where a preferred one exists:
  `form.grep-file`, `form.find-discovery`, `form.ls-recursive`,
  `form.env-grep`.
- **bounds** — traversal or output not stopped at the producer:
  `bounds.find-unbounded`, `bounds.grep-recursive-uncapped`,
  `bounds.false-cap`.

`bounds.false-cap` records a specific mistake: a downstream `head` stops a
streaming producer through the pipe, but it stops nothing once a stage between
them consumes the whole stream first, and `tail` never stops a producer at all.
`find … | head` is capped; `find … | sort | head` and `find … | tail` are not.

### Deliberate limits

- Rules read command shape through a small shell reader that resolves quoting,
  escapes, heredocs, and substitution bodies. It expands no variables, globs, or
  aliases.
- Composition as such is not classified. Shape cannot establish that a
  purpose-built command exists for an operation, so a loop, `xargs`, or a
  substitution is flagged only when a rule identifies the specific work a
  bounded tool owns. A call that matches no rule carries no class.
- Classification is a measurement instrument, not a verdict. A rule id in a
  record names the shape that matched, and analysis can revisit any rule.

## Secrets

Command text is the only tool input stored, and only because the shell rules
declare that capture. Every other tool contributes outcome fields alone. Command
text passes through eager redaction before any write: credential-named
assignments and flags, authorization headers, bearer tokens, URL credentials,
vendor key shapes, and long opaque runs are replaced. Stored text is bounded.

## Configuration

| Variable | Purpose |
|---|---|
| `PI_POLICY_DIR` | Record store directory; default `<agentDir>/policy` |

Records append to `<dir>/YYYY-MM-DD.jsonl`. The directory is created `0700` and
each file `0600`.

## Failure isolation

The slice sits in the path of every tool call, so a defect in it must never
reach that call. Every handler body runs inside a boundary that reports the
first failure once on `console.warn` and then stops recording for the rest of
the session. A store failure is returned, never thrown. Unresolved calls are
capped in memory and the oldest is evicted, so a run that ends without results
cannot grow the map.

## What it does not do

- No block, rewrite, warn, or model-visible text.
- No rule language, configuration schema, or predicate engine.
- No rules outside the shell domain.
