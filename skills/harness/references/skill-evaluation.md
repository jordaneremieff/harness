# Evaluation and Verification

Use this reference to prove two different claims:

1. **Trigger quality:** the skill is consulted for tasks it should help with
   and ignored for near misses.
2. **Output quality:** using the skill improves the completed work compared
   with a baseline.

Both matter. A skill that never triggers has no value; a skill that triggers
but does not improve output spends context for nothing.

## Contents

- [Baseline first](#baseline-first)
- [Trigger evaluation](#trigger-evaluation)
- [Output evaluation](#output-evaluation)
- [Structural and client verification](#structural-and-client-verification)
- [Bounded live checks](#bounded-live-checks)
- [Iterate](#iterate)
- [Approval evidence](#approval-evidence)

## Baseline first

For a new skill or behavior-shaping edit, observe the task without the
candidate skill, or with the previous skill version as the baseline. Record
what happened, including wrong choices, omitted checks, rationalizations, and
time or token cost when available.

Classify the baseline:

- **Failure:** the skill should target the observed failure.
- **Partial success:** the skill should close a specific gap.
- **Success:** the skill may be unnecessary unless it reduces cost or makes
  success more reliable.

An explicit operator decision can waive comparative baseline or replacement
proof. Record the override and its reason, then remove that proof from the
blocking path rather than recreating it as a pilot or compatibility gate.

Do not manufacture a failure by asking a weak model to perform a poorly
specified task. Use a realistic operator prompt and the intended model or a
close proxy. For a no-op correction such as fixing one stale path, a normal
validation check may be enough; record why deeper evaluation is not
proportionate.

## Trigger evaluation

Write realistic positive and near-miss prompts before changing the
description. Start with 8–10 prompts that should trigger and 8–10 that
should not. Make positives varied in phrasing, explicitness, detail, and
complexity. Make negatives genuinely adjacent: shared vocabulary, adjacent
workflow, wrong artifact type, or a case better served by another skill.

For Pi, a triggered skill is observable when the agent reads the skill's
`SKILL.md`; a direct `/skill:name` invocation is an explicit override, not
evidence of autonomous triggering. Run candidates in clean sessions where
possible. If the harness offers subagents or parallel sessions, use them;
otherwise run prompts serially and keep the results separate.

Track a trigger rate over repeated runs, because activation is
nondeterministic. A practical early gate is three runs per prompt: positives
should trigger more often than not, and near misses should usually not.
Treat one success or failure as a signal, not proof.

Avoid overfitting. Optimize against a training subset, then check fresh
validation prompts. Do not paste exact failed phrasing into the description
unless it represents a stable user-language branch. Keep the final
description under the standard's 1024-character limit.

## Output evaluation

Use 2–3 realistic tasks first, then expand. Run each task with the candidate
skill and against the chosen baseline:

- new skill: no skill;
- improved skill: previous version;
- candidate replacement: existing skill or composed workflow.

Save outputs and transcripts by iteration. Write assertions only after seeing
what good and bad outputs look like. Good assertions are observable:
"validates without errors," "uses relative paths," "contains a researched
adopt/extend/compose/create recommendation," or "does not write before
approval." Weak assertions merely restate taste.

Use scripts for mechanical checks and an independent grader for judgment
checks. Require evidence for every pass. Human review remains necessary for
tone, usefulness, and whether the result solves the real task.

Compare time and token cost as well as pass rate. A skill that buys a small
quality gain for a large repeated cost may need pruning or hidden/user-only
invocation. Look for non-discriminating assertions that pass in both arms;
they do not prove the skill helps.

## Structural and client verification

Before behavior evals, verify the artifact mechanically:

- `SKILL.md` exists in the skill directory.
- frontmatter parses and required fields are present;
- `name` matches the directory and naming rules;
- `description` is 1–1024 characters;
- optional fields are standard for portability or explicitly client-specific;
- relative resource paths resolve from the skill directory;
- bundled scripts have `--help`, reject missing input clearly, avoid
  interactive prompts, and bound output;
- no secrets, credentials, private absolute paths, or surprising network or
  destructive behavior are embedded.

Run the bundled structural validator from the skill directory:

```bash
node scripts/validate-skill.mjs <skill-directory> --format json
```

In Pi, also verify discovery from the intended source: package `pi.skills`,
global/project skill directory, settings path, or explicit `--skill`. Confirm
`/skill:<name>` command availability when skill commands are relevant.

## Bounded live checks

Scale live verification to the claim:

- **Metadata claim:** discovery and frontmatter checks suffice.
- **Instruction claim:** at least one real task with the skill and a
  comparable baseline.
- **Activation claim:** repeated positive and near-miss trigger runs.
- **Packaging claim:** inspect the archive, install or unpack it separately,
  and verify discovery from the installed copy.
- **Script claim:** direct successful and failing invocations, plus at least
  one invocation through the skill workflow.

Do not let a live agent make uncontrolled network calls, use real secrets, or
write to a shared location during verification. Use temporary directories,
dry runs, and operator-approved credentials.

## Iterate

Use failed assertions, transcripts, timing, and human feedback together.
Generalize fixes instead of bolting on prompt-specific patches. Remove
instructions that cause wasted work; add scripts when every run reinvents
the same deterministic helper; strengthen completion criteria when the agent
stops early.

Rerun the full affected eval set after each substantive change. Stop when
the operator accepts the result, feedback is empty, or further iterations no
longer produce meaningful improvement. If evaluation shows the baseline is
already better, abandon or redesign the skill instead of forcing it into the
catalog.

## Approval evidence

When the operator has not already selected placement, the final request should
state:

- research recommendation and inspected sources;
- target directory and invocation mode;
- structural validation results;
- trigger eval positives, near misses, runs, and limitations;
- output eval baseline, assertions, pass/fail evidence, cost, and human
  feedback;
- packaging/discovery result when applicable;
- remaining risks and what was intentionally not tested.
