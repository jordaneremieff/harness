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

Repeat `--participant`, `--case`, `--variant`, `--credential-env`, and `--grant-effect` where needed. Plan and run arguments must match. The run command recomputes the plan and requires its exact digest.

`--allow-home-credentials` explicitly exposes `HOME` to the controlled child. `--credential-env NAME` exposes only that named variable. The child receives no general copy of the parent environment. The approved digest covers the participant roster, repetition count, credential sources, granted effects, cases, variants, subject resolution, and limits.

## Limits and states

A plan records wall-time limits, execution limits, and an observed cost limit. Cost enforcement occurs after each execution. It is not a hard spend cap because one execution can cross the observed limit.

Operational terminal states are `completed`, `partial`, `blocked`, `cancelled`, `timed_out`, and `failed`. A run is `partial` only when its child outcome is not clean and its recorded evidence contains both an execution with no errors and an execution with errors. When every recorded execution errors, the existing cause classification remains `blocked`, `cancelled`, `timed_out`, or `failed`. A `partial` run is operationally incomplete, and `run` exits nonzero for it.

Quality states are `pass`, `fail`, `inconclusive`, and `not_assessed`. Operational success does not imply quality success. Human-required suites remain `not_assessed` until `adjudicate` records an immutable verdict. A `partial` run permits a human `pass` or `fail` only with `--scope usable-executions`; the adjudication records the exact usable execution identifiers covered by that verdict. An unscoped partial adjudication and any conclusive adjudication of a `blocked`, `cancelled`, `timed_out`, or `failed` run are rejected. Deterministic quality assignment remains limited to `completed` runs.

## Evidence and review

Each run writes private, ignored evidence under `.evals/<run-id>/`. Evidence includes the exact plan, state, generated Vitest config, bounded child logs, Vitest JSON, normalized executions, usage, errors, effective model data, and a review artifact. Terminal state and `review.json` both record coverage as `plannedExecutions`, `usableExecutions`, `excludedExecutions`, `usableExecutionIds`, and `exclusions`. Every exclusion carries its `executionId` and `errorTypes`; missing planned evidence is identified as `MissingExecutionEvidence`.

`review.json` uses blinded variant labels and includes full synthetic fixture context. Entries with errors remain visible as `excluded`, including their outputs, usage, errors, and exclusion reason, but omit `checks` so those results cannot be treated as scored evidence. `variant-map.json` remains separate and appears only through `inspect --reveal`.

Deterministic checks are lexical floors. Passing them does not establish semantic quality.

## Pi adapter

The Pi adapter uses public SDK services and `AgentSessionRuntime`. It creates an empty per-execution working directory and resource directory, disables discovered resources, and permits only explicit suite resources. It seeds an in-memory `SessionManager` before session creation, resolves the exact provider and model through `ModelRuntime`, checks approved authentication, binds explicit extensions, aborts on limits, and disposes the runtime.

The adapter supports prompt, skill, extension, and ad hoc subjects through JSON Pi configuration. It records the full normalized transcript, public run-entry usage, loader diagnostics, requested and effective provider/model/thinking values, response model, checks, and errors.

## Deterministic development checks

These commands do not call a model:

```bash
node --test "evals/*.test.mts" "evals/subjects/*.test.mts"
npm run typecheck
npm run lint
npm run check
npm test
```
