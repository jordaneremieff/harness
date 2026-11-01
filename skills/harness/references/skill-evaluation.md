# Evaluation and Verification

Evaluate separate claims:

1. Activation: relevant tasks consult the skill; plausible near misses do not.
2. Output: the skill produces its intended result.
3. Comparative benefit: the skill improves a task, cost or reliability against a
   meaningful baseline when that benefit is claimed.

An instruction edit is not automatically a paid evaluation campaign. Select
cases and repetition for the changed boundary, unresolved material question and
consequence of error. Reuse applicable evidence. No fixed prompt, task or run
quota applies.

## Select the evaluation

Inspect the edit and existing evidence first. Identify whether activation,
instructions, scripts, output, discovery or packaging changed. Select realistic
cases that discriminate the intended behaviour from plausible errors: changed
activation branches, adjacent near misses, intended outputs and relevant failure
or authority boundaries. Do not rerun unaffected cases solely for a new version.

For a mechanical correction, direct source, path or structural checks may establish
the claim without live model runs. An observed example of the actual defect can
support a fixed repair. For a broader behavioural or benefit claim, obtain evidence
at that boundary rather than treat structural validity as behavioural success.

Choose deliberate repeated samples when consequential model variation affects
acceptance. Vary the conditions that matter; same-condition repetition measures
stability, not independent truth. State the observed scope and reliability limits.
One success does not establish general reliability; neither does a fixed quota.

## Activation

Write realistic positive and adjacent near-miss cases for the changed selection
boundary. Use varied phrasing or fresh validation cases where overfitting is a
material risk. A read of `SKILL.md` is observable activation in Pi; a direct
`/skill:name` invocation is an override, not autonomous-trigger evidence.

Use clean sessions where prior exposure would confound selection. Use the
intended model or a justified proxy. Select additional prompts or repetitions
when their possible outcomes change the decision, not to fill a sample target.
Bind any reported rate to the tested prompts, model and setup.

## Output and meaningful comparisons

Check intended output with observable criteria derived from the real task and
contract. Inspect assertions and graders as fallible instruments. Correct mistaken
criteria without excusing a genuine failure. Use human or capable independent
judgment for usefulness and tone when those claims need it; do not add a grader
merely because an evaluation occurred.

When comparative benefit decides acceptance, compare the candidate with no skill,
the prior version or the existing workflow, as appropriate. Applicable prior
observations can supply evidence; a new paired run is not mandatory for every
instruction edit. Use matched tasks, facts, authority and relevant execution
conditions. Keep candidate-only method, checklist and artifact demands out of the
plain baseline request. Include time, token, context and operating cost when they
bear on the claimed benefit. An assertion passing in both arms does not prove
added value. If the baseline already meets the outcome, retain a benefit claim
only when evidence supports its stated cost or reliability advantage.

Do not manufacture a failure with a weak model or distorted request. Do not
retrofit the acceptance rationale to a benefit noticed only after comparison.
A useful new observation can motivate a different proposal, not prove the original
claim. An explicit operator choice or waiver governs its named proof requirement;
do not restore it under a pilot or renamed gate. Keep unsupported benefits explicit.

## Structure, scripts and delivery

Check the required portable shape, frontmatter limits and affected relative links.
Use the bundled validator when required by repository or promotion policy:

`node skills/harness/scripts/validate-skill.mts <skill-directory> --format json`

For a new or changed script, select successful, failing and workflow invocations
that establish its changed contract. Reuse applicable results for unchanged scripts.
Preserve non-interactive operation, bounded output, documented dependencies and
`--help` where required. Inspect embedded network, destructive and credential
behaviour; use isolated roots and synthetic data for execution.

Discovery claims require discovery from the intended source. Packaging claims
require the relevant archive and installed-copy boundary, not every skill edit.
Keep activation separate from discovery and structure. Follow the repository's
single final-acceptance and promotion policy instead of duplicating its resource
checks for each milestone.

## Iterate and stop

Use failures, outputs, cost and human feedback to revise the defective part.
Generalise stable task boundaries rather than paste failed prompts into the
skill. Remove instructions that cause waste. Retain scripts or fixtures only
when their continuing value warrants their lifecycle cost.

After an edit, recheck cases whose evidence it invalidates and select new cases
for newly exposed risks. Do not automatically rerun the full set. Continue
sampling or investigation while material uncertainty warrants its cost. Stop
when evidence supports the bounded decision, a necessary unavailable layer blocks
it, or further inquiry has sharply diminishing decision value. State necessary
unknowns and narrow the claim; stopping does not justify guessing or unsupported
completion. Reject or redesign a candidate when the evidence defeats its benefit.

## Report and placement

Keep temporary outputs, transcripts, graders and reproductions outside tracked
paths. Use existing results; add only a concise evidence summary when useful.
For a placement decision, state the intended location and invocation mode,
inspected sources, applicable structural and behavioural evidence, comparative
evidence when relevant, delivery evidence when in scope, and material limits.
Do not recreate placement approval when the operator already selected it. A
proposal-only instruction does not authorise live evaluation or placement.
