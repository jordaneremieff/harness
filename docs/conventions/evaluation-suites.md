# Harness evaluation suites

The package-level `evals/` application owns evaluation planning, execution,
checks, and review state. Each extension, skill, or prompt owns its task cases
and synthetic fixtures. Evaluation definitions do not become runtime dependencies
of the evaluated surface.

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

For an extension import example, see the [registry discovery
suite](../../extensions/registry/registry.eval.mts) and its [deterministic
tests](../../extensions/registry/registry-evals.test.mts).

Prompt and skill suites also use the package evaluation facade outside the
extension slice boundary. Skill suites use `*.eval.mts` within their skill
directory; deterministic tests live in `scripts/*.test.mts` so the normal test
command includes them. These suites import `evals/vitest-evals.mts`, and their
tests use `evals/subjects/pi-sdk.mts` for resource validation and deterministic
checks. Use explicit relative imports. This does not broaden the extension
import allowance or add runtime dependencies to skills.

The Audit skill owns its [trigger](../../skills/audit/audit-trigger.eval.mts),
[direct-output](../../skills/audit/audit-output.eval.mts), and
[plain-request baseline](../../skills/audit/audit-baseline.eval.mts) suites.
Validate them with `npm run evals -- validate <suite-path>` and run their
structural tests with `node --test skills/audit/scripts/audit-evaluation.test.mts`.
They use synthetic evidence and selected read-only resources. They do not prove
complete collection from real session stores or refusal of available mutation
tools. Trigger evidence is a candidate skill read, not a direct slash invocation.
Output quality and comparative usefulness remain semantic review questions.

## Execution and evidence

Run suites through the existing evaluation CLI, with explicit participants,
effects, and the exact plan digest. Keep generated results in its ignored output
store. A suite definition, a deterministic check, a model-backed execution, and
a human quality verdict establish different facts. Preserve the runner's
human-required state until the operator supplies that verdict.

See [the evaluation application](../../evals/README.md) for the executable
contract and [verification by claim](../../skills/harness/references/verification.md)
for evidence boundaries.
