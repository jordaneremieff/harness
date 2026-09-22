# Author policy rules

Inspect `policy_rules` first. Its default view supplies current rules, pending
proposals, health, exact provider/model identities, and cwd. Use `capabilities`
for active tools and supported actions, `catalog` for installed examples, and
`data` for approved table status. Inspect the actual tool schema before a
correction. Never invent a tool's failure contract or a private identifier.

## Author, check, propose, approve

1. State the protected outcome and the smallest relevant scope.
2. Choose an existing authoring form and write an add/replace proposal.
3. Use `policy_rules` with `view:"check"`, `draft`, and bounded `cases`.
4. Check a positive case, a near miss, unavailable evidence, and excluded scope.
5. Submit the checked draft with `policy_propose` when the operator requests a rule
   change, or when automatic policy diagnostics identify a verified repeatable
   recovery that warrants a narrowly scoped candidate. Do not propose an
   unverified recovery.
6. The operator reviews and explicitly approves the complete proposal before
   activation. Checks and proposal submission grant no activation authority.

`check` does not save a proposal, change data, execute a tool, consume live
observation state, or approve anything. The actual inspection invocation still
has ordinary telemetry. Synthetic cases use the production runtime with copied
rules/data and an isolated clock, observation state, and guidance allowances.
They assume `enforce` for the simulation; the real session mode does not change.
A degraded copied registry still limits effects to notice, as in production.

Draft admission uses the same proposal schema, candidate validators, installed
predicate checks, and target/pending-proposal checks. It does not reserve capacity,
verify filesystem writability, or promise that later submission remains valid.
An existing pending proposal for the same rule prevents another draft admission.
A replacement preserves existing overrides, including disablement.

Admission diagnostics and case outcomes are different evidence. An admitted
rule is structurally valid, not necessarily useful or correct. Cases establish
only the supplied examples. A successful check does not establish remote
provider acceptance or the host's outer argument preflight. Missing tool schemas
remain unavailable; checks never fabricate them.

## Choose a form

- **`predicate`**: reuse a bounded installed command test from `catalog`.
  Reference its key; do not copy its implementation. Its purpose and authority
  remain yours to declare.
- **`match`**: use a command shape for literal command/flag/operand/pipe evidence.
  `flags` means all, `anyFlags` means any, and `absentFlags` means none. The Git
  profile supports only `git push`; it requires explicit top-level
  `onUnavailable`. Shell expansion, aliases, and unsupported syntax stay unknown.
- **`language:"facts/v1", program`**: use typed conditions for tool arguments,
  result contracts, corrections, or completed-observation state.

Every add/replace declares `id`, positive `purpose`, `authority`, `reason`, and
`note`. Replacement also declares the current `expectedRevision`. Exactly one
form is allowed. Use `authority:"exact"` for corrections and non-input actions.
Only input guidance/denial and command rules support `steer-or-block`.
For a selectable draft, check requires `effect:"steer"` or `effect:"block"`.
This is a simulated choice, not approval. Exact drafts reject that field.

## Scope, selector, applicability

- `scope` selects the session. Provider/model identities match exactly and
  case-sensitively. Cwd prefixes match absolute strings, not directory ancestry.
  `/project/app` also prefixes `/project/application`. Inspect the actual value.
- `program.selector` selects physical tools and optional logical operations.
  A context selector selects observations, not the later context request.
- `applicability` is the condition that permits evaluation and observation.
  False or unknown applicability always skips, even with unavailable denial.

Qualify gateways with a physical tool, logical operation, and outer server.
Put server qualification in applicability when missing server evidence must
leave the rule inactive. A codec reads inner arguments; it does not authorize
inner argument correction. Correction paths omit the `input` root.

## Facts and phase limits

Paths are safe own-property key arrays, never code. Tool-specific fields require
the tool's schema or documented result contract. This list describes engine facts.

| Root/field | Meaning and availability |
| --- | --- |
| `tool` | Physical tool name during input, result, and completion; absent at context projection |
| `operation` | Decoded logical operation when a declared codec supplies it; otherwise unavailable |
| `input`, `original` | Current and original argument objects; decoded by a codec if declared |
| `outer`, `originalOuter` | Current and original outer argument objects, including gateway routing fields |
| `schema.valid` | Boolean registered outer-tool schema check; unavailable for decoded inner arguments or missing schema |
| `result.tool`, `result.isError` | Physical tool and error flag in result/completion phases |
| `result.details`, `result.content`, `result.usage` | Only supplied result fields; usage is not accepted as synthetic check input |
| `outcome.kind` | Completion classification: success, execution-error, denied, or unexecuted on current completion paths |
| `outcome.executed`, `.denied`, `.abortRequested`, `.complete` | Completion evidence; abort request does not prove the error cause |
| `outcome.outputBytes`, `.preGuidanceBytes` | Final text bytes and bytes before this policy's guidance; missing measurements remain unavailable |
| `state.count`, `.total`, `.turns` | Period count, declared numeric sum, and observed turn count |
| `state.windowCount`, `.windowTotal`, `.windowTurns` | Last-N matching completions intersected with the declared age window |
| `state.turnCount`, `.turnTotal` | Current-turn aggregates; unavailable retained totals stay unknown |
| `state.projected`, `.eligible`, `.saturated` | Guidance projection count, allowance status, and aggregate saturation |
| `state.startedAt`, `.resetReason`, `.revision`, `.generation`, `.id` | Observation-period identity and reset metadata |
| `context.turn`, `.catalogAvailable` | Current turn and public catalog availability |
| `context.tools.<name>.active`, `.configured` | Public tool presence; an unavailable catalog is not proof of absence |
| `data.<name>` | Captured approved binding and status; use declared table lookups rather than private paths |

At context projection there is no current tool, arguments, result, or outcome.
Use state aggregates for context conditions. A completion guide evaluates final
outcomes after state observation and retains eligible guidance for the next
real context request. It does not force another request. Context and completion
guides require exact authority. Input guides appear only after a matched success.

Conditions support `all`, `any`, `not`, scalar equality/membership/type/presence,
numeric comparisons, bounded string comparisons, and declared table lookups.
Unknown remains unknown under negation and composition. A missing comparison
field is not false or zero; `exists` tests presence. Unknown conditions skip,
unless an applicable input rule explicitly permits unavailable denial. Selected
`steer` never denies. Arbitrary nested field names are not semantically proved
by syntax admission; test their actual evidence.

Actions are `deny` (input), `rename-key` and `substitute` (input), `assert-error`
(result), `observe` (completion), and `guide` (input/result/completion/context).
Named data requires separate operator approval. A check uses existing approved
data only. It never manufactures a missing mapping or selects an ambiguous row.

## Check examples

This complete request checks a direct-tool denial without executing `bash`.
Each case starts with fresh observation state. `at` is milliseconds after one
captured check time; `turn` is a synthetic turn counter. Both are nondecreasing.
The scope override belongs only to the example, not the draft or live session.

```json
{
  "view": "check",
  "draft": {
    "operation": "add",
    "id": "local.authoring-example",
    "purpose": "Refuse the explicitly disallowed timeout value.",
    "authority": "exact",
    "reason": "Apply the declared command restriction.",
    "note": "Use a permitted command.",
    "scope": {"cwdPrefixes": ["/project/app/"]},
    "language": "facts/v1",
    "program": {
      "phase": "input",
      "selector": {"tools": ["bash"]},
      "when": {"op": "eq", "path": ["input", "timeout"], "value": 1},
      "action": {"kind": "deny"},
      "onUnavailable": "skip"
    }
  },
  "cases": [
    {"name": "positive", "scope": {"cwd": "/project/app/"}, "steps": [
      {"kind": "call", "at": 0, "turn": 1, "tool": "bash", "input": {"command": "printf safe", "timeout": 1}, "expect": {"denied": true}}
    ]},
    {"name": "near-miss", "scope": {"cwd": "/project/app/"}, "steps": [
      {"kind": "call", "at": 0, "turn": 1, "tool": "bash", "input": {"command": "printf safe", "timeout": 2}, "result": {"isError": false}, "expect": {"denied": false}}
    ]},
    {"name": "unavailable", "scope": {"cwd": "/project/app/"}, "steps": [
      {"kind": "call", "at": 0, "turn": 1, "tool": "bash", "input": {"command": "printf safe"}, "expect": {"denied": false}}
    ]},
    {"name": "excluded-scope", "scope": {"cwd": "/elsewhere/"}, "steps": [
      {"kind": "call", "at": 0, "turn": 1, "tool": "bash", "input": {"command": "printf safe", "timeout": 1}, "expect": {"denied": false}}
    ]}
  ]
}
```

This sequence checks completion guidance after two errors and a later success.
The success resets the count but does not retract guidance already retained for
the next context request.

```json
{
  "view": "check",
  "draft": {
    "operation": "add",
    "id": "local.failure-example",
    "purpose": "Review repeated failed tool executions.",
    "authority": "exact",
    "reason": "Use the declared recovery threshold.",
    "note": "Review the completed errors.",
    "language": "facts/v1",
    "program": {
      "phase": "completion",
      "selector": {"tools": ["bash"]},
      "when": {"op": "gte", "path": ["state", "count"], "value": 2},
      "state": {
        "observe": {"op": "eq", "path": ["outcome", "kind"], "value": "execution-error"},
        "resetWhen": {"op": "eq", "path": ["outcome", "kind"], "value": "success"},
        "once": "period"
      },
      "action": {"kind": "guide", "text": "Review the errors before another attempt."},
      "onUnavailable": "skip"
    }
  },
  "cases": [{"name": "completed-errors", "steps": [
    {"kind": "call", "at": 0, "turn": 1, "tool": "bash", "input": {"command": "printf safe"}, "result": {"isError": true}},
    {"kind": "context", "at": 1, "turn": 1, "expect": {"guidance": false}},
    {"kind": "call", "at": 2, "turn": 1, "tool": "bash", "input": {"command": "printf safe"}, "result": {"isError": true}},
    {"kind": "call", "at": 3, "turn": 1, "tool": "bash", "input": {"command": "printf safe"}, "result": {"isError": false}},
    {"kind": "context", "at": 4, "turn": 1, "expect": {"guidance": true}},
    {"kind": "context", "at": 5, "turn": 1, "expect": {"guidance": false}}
  ]}]
}
```

Supply a result only when the synthetic call executes. Omitted results represent
unexecuted calls. Denied calls do not execute even if an example supplies a result.
A context step is `{"kind":"context","at":1,"turn":1,"expect":{"guidance":true}}`.
Put call and context steps in one case to check thresholds, reset, expiry, and
once/cooldown behavior. Use separate cases for independent sequences.

Optional expectations compare observed booleans: `denied`, `correctedInput`,
`resultError`, and `guidance`; context steps accept only `guidance`. A result's
literal text does not count as policy guidance. Inspect returned evaluations for
true/false/unknown evidence and mismatches for failed expectations. Cases without
expectations report evidence only. Existing approved rules also participate;
inspect their decisions before attributing an outcome to the draft alone.

The public schema supplies case, time, turn, and step bounds. The request also
has aggregate JSON bounds. Output omissions are explicit and do not constitute
successful case evidence. Split the requested examples if output exceeds its
bound. No public check reads external files, runs subprocesses, or invokes the
simulated tools.
