# Clean-room evaluations

The `evals/` application plans and records maintained evaluations without coupling suite definitions to a model runtime. Suites declare a neutral adapter identifier, subject kind and configuration, JSON cases, checks, limits, requested effects, and adjudication policy. Adapter-specific resource configuration stays in its adapter.

`vitest-evals.mts` is the repository facade for maintained suites. The facade loads Vitest only inside an approved child run. The child uses one explicitly included suite file and the repository's Pi SDK adapter. The CLI never discovers `*.eval.mts` files.

## Commands

Run all commands from the repository root:

```bash
npm run evals -- validate prompts/wtf.eval.mts

npm run evals -- plan prompts/wtf.eval.mts \
  --participant anthropic/claude-model:high \
  --repetitions 1 \
  --allow-home-credentials \
  --grant-effect paid-model-inference \
  --grant-effect credential-command-execution \
  --grant-effect credential-refresh \
  --grant-effect read-approved-model-credentials \
  --grant-effect credential-resolution

npm run evals -- run prompts/wtf.eval.mts \
  --participant anthropic/claude-model:high \
  --repetitions 1 \
  --allow-home-credentials \
  --grant-effect paid-model-inference \
  --grant-effect credential-command-execution \
  --grant-effect credential-refresh \
  --grant-effect read-approved-model-credentials \
  --grant-effect credential-resolution \
  --approve sha256:<exact-plan-digest>

npm run evals -- inspect <run-id>
npm run evals -- inspect <run-id> --reveal
npm run evals -- adjudicate <run-id> --verdict pass --preferred A --notes "Human review notes"
npm run evals -- adjudicate <partial-run-id> --verdict pass --scope usable-executions --notes "Scoped human review notes"
npm run evals -- delete <run-id> --approve <run-id>
```

Repeat `--participant`, `--case`, `--variant`, `--credential-env`, and `--grant-effect` where needed. Suite paths and run IDs are positional arguments; there are no `--suite` or `--run` aliases. Plan and run arguments must match. The run command recomputes the plan and requires its exact digest.

`validate` resolves declared resources and runs the subject adapter's case and check parsing without creating a model runtime or performing inference. Plan creation repeats adapter validation across the complete suite before producing an approval digest, including cases omitted by a selection.

`--allow-home-credentials` explicitly exposes `HOME` to the controlled child. `--credential-env NAME` exposes only that named variable. The child receives no general copy of the parent environment. The approved digest covers the participant roster, repetition count, credential sources, granted effects, cases, selected variants and their complete configuration, subject resolution, and limits. This includes extension flag values declared by a variant.

## Limits and states

A plan records wall-time limits, execution limits, and an observed cost limit. For each execution, the Pi adapter gives the session a shallow copy of the resolved model whose `maxTokens` is the lower of the model ceiling and `maxOutputTokensEach`. Provider-reported output usage is still checked after execution as a backstop, and a provider `length` stop is recorded as limit exhaustion. Cost enforcement occurs after each execution. It is not a hard spend cap because one execution can cross the observed limit.

Operational terminal states are `completed`, `partial`, `blocked`, `cancelled`, `timed_out`, and `failed`. A run is `partial` only when its child outcome is not clean and its recorded evidence contains both an execution with no errors and an execution with errors. When every recorded execution errors, the existing cause classification remains `blocked`, `cancelled`, `timed_out`, or `failed`. A `partial` run is operationally incomplete, and `run` exits nonzero for it.

Quality states are `pass`, `fail`, `inconclusive`, and `not_assessed`. Operational success does not imply quality success. Human-required suites remain `not_assessed` until `adjudicate` records an immutable verdict. A `partial` run permits a human `pass` or `fail` only with `--scope usable-executions`; the adjudication records the exact usable execution identifiers covered by that verdict. An unscoped partial adjudication and any conclusive adjudication of a `blocked`, `cancelled`, `timed_out`, or `failed` run are rejected. Deterministic quality assignment remains limited to `completed` runs.

## Evidence and review

Each run writes private, ignored evidence under `.evals/<run-id>/`. Evidence includes the exact plan, state, generated Vitest config, bounded child logs, Vitest JSON, normalized executions, usage, errors, effective model data, and a review artifact. Terminal state and `review.json` both record coverage as `plannedExecutions`, `usableExecutions`, `excludedExecutions`, `usableExecutionIds`, and `exclusions`. Every exclusion carries its `executionId` and `errorTypes`; missing planned evidence is identified as `MissingExecutionEvidence`.

`review.json` uses blinded variant labels and includes full synthetic fixture context. Entries with errors remain visible as `excluded`, including their outputs, normalized transcript events, usage, errors, and exclusion reason, but omit `checks` so those results cannot be treated as scored evidence. `variant-map.json` remains separate and appears only through `inspect --reveal`.

Deterministic checks are structural or lexical floors. Passing them does not establish semantic quality.

## Pi adapter

The Pi adapter uses public SDK services and `AgentSessionRuntime`. It creates an empty per-execution working directory and resource directory, disables discovered resources, and permits only explicit suite resources. It seeds an in-memory `SessionManager` before session creation, resolves the exact provider and model through `ModelRuntime`, checks approved authentication, binds explicit extensions, aborts on limits, and disposes the runtime.

The adapter supports prompt, skill, extension, and ad hoc subjects through JSON Pi configuration. Its preflight parser requires each case to have valid user or assistant seed messages and a non-empty prompt. Check configuration accepts only the fields documented below; unsupported check types, misspelled fields, and malformed values are rejected with the case and check identifiers before planning. Variant configuration may include `extensionFlags`, an object whose values are booleans or strings. The adapter passes those entries to Pi as `extensionFlagValues` when constructing session services; omitted flags preserve Pi's defaults. It records the full normalized transcript, public run-entry usage, loader diagnostics, requested and effective provider/model/thinking values, response model, checks, and errors. Persisted and review events retain the full transcript, including seeded fixtures. Deterministic transcript checks observe only post-seed events from the current execution.

### Transcript check types

A `tool-call` check has config `{ name: string, argumentsContain?: string[], present?: boolean }`. It matches the exact tool name and requires every `argumentsContain` substring in the JSON-serialized call arguments. `present` defaults to `true`; set it to `false` to assert that no matching call occurred.

```ts
{ id: "read-live", type: "tool-call", config: { name: "read", argumentsContain: ['"path":"input.md"'] } }
{ id: "no-shell", type: "tool-call", config: { name: "bash", present: false } }
```

A `tool-result` check has config `{ name: string, isError?: boolean, contentContains?: string[], contentOmits?: string[] }`. It requires a matching result, optionally constrains whether the result has a normalized error, requires every `contentContains` substring, and rejects content containing any `contentOmits` substring. When the transcript contains the originating call, the check resolves `toolCallId` and matches that call's name instead of trusting the result name alone.

```ts
{
  id: "policy-blocked",
  type: "tool-result",
  config: { name: "read", isError: true, contentContains: ["Blocked"], contentOmits: ["approved"] },
}
```

## Deterministic development checks

These commands do not call a model:

```bash
node --test "evals/*.test.mts" "evals/subjects/*.test.mts"
npm run typecheck
npm run lint
npm run check
npm test
```
