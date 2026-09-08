# Extension evaluation suites

The package-level `evals/` application owns evaluation planning, execution,
checks, and review state. An extension owns its task cases and synthetic
fixtures. Evaluation definitions do not become extension runtime dependencies.

## Import contract

Colocated files directly under `extensions/<name>/` may use these exact
package-level interfaces:

| Consumer | Producer | Supported use |
|---|---|---|
| `*.eval.mts` | `evals/vitest-evals.mts` | `defineSuite`, `EvaluationSuite`, and `EvaluationCheck` define a maintained suite. |
| `*.test.mts` | `evals/subjects/pi-sdk.mts` | `piSdkAdapter.validate`, `piSdkAdapter.resolve`, and `runDeterministicChecks` validate suite resources and deterministic checks without model execution. |

Use explicit relative imports. The slice checker resolves the destination and
allows only these consumer kinds and exact producer paths. Runtime modules,
fixture factories, other evaluation internals, and sibling extensions remain
outside this allowance. No test uses this contract to execute paid inference.

Current extension consumers include the registry discovery suite
(`registry/registry.eval.mts`, `registry/registry-evals.test.mts`) and the Pillars
command suite (`pillars/commands.eval.mts`, `pillars/evaluation.test.mts`).
Prompt suites also use the package evaluation facade outside the extension
slice boundary.

## Execution and evidence

Run suites through the existing evaluation CLI, with explicit participants,
effects, and the exact plan digest. Keep generated results in its ignored output
store. A suite definition, a deterministic check, a model-backed execution, and
a human quality verdict establish different facts. Preserve the runner's
human-required state until the operator supplies that verdict.

See [the evaluation application](../../evals/README.md) for the executable
contract and [verification by claim](../../skills/harness/references/verification.md)
for evidence boundaries.
