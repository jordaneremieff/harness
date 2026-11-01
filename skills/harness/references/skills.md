# Agent Skill lane

Use this lane when the selected harness surface is an Agent Skill or when an existing skill's activation, workflow, resources, scripts, placement, or behavior changes.

## Boundary

Agent Skills provide on-demand procedural knowledge, references, scripts, and assets. They do not intercept Pi events, register tools or commands, own live UI, or enforce deterministic behavior. Route those outcomes back through [surface-selection.md](surface-selection.md).

This lane does not apply when the task merely invokes, installs, removes, or distributes an otherwise unchanged skill.

## Procedure

### 1. Define the skill contract

Identify the reusable behavior, audience, target clients and locations, realistic success examples, near misses, expected outputs, failure modes, and environment constraints. Extract these from the current conversation and inspected artifacts before asking the operator to repeat them.

**Complete when:** the skill's subject and trigger boundary are concrete enough to write realistic positive and negative prompts.

### 2. Research before substantial design

For a new skill, substantial redesign, consolidation, or description overhaul, read [skill-research.md](skill-research.md). Check the current Agent Skills specification, the target client's current behavior, local overlap, directly inspected public skills, and the domain's primary truth sources. Classify the result as adopt, extend, compose, or create.

Skip broad research for a tiny mechanical correction whose intent and compatibility are settled.

**Complete when:** the design decision rests on inspected sources and a bounded search record rather than model memory.

### 3. Establish the skill warrant

Under "Establish the warrant when required" in [the main harness skill](../SKILL.md), a new skill's evidence warrant needs no observed failure — a usefulness rationale (the capability it provides and why it is worth having) is sufficient on its own. Creation still follows "New surfaces require authority" there. A skill that is activated frequently, injects substantial context on activation, or becomes a standing dependency of the workflow follows the caliber rule — "Caliber for repeated or hard-to-remove mechanisms", within "Establish the warrant when required" — for recurring or hard-to-remove mechanisms.

A baseline (observing the task without the candidate, or citing an already-observed failure) strengthens the case and gives later evaluation something to measure against, but its absence never blocks a new skill.

For a behaviour-shaping change, select evidence for its changed activation or
output boundary under [skill evaluation](skill-evaluation.md). Compare with the
previous version when the claimed benefit needs a comparison; reuse applicable
observations. An instruction edit alone requires neither a new baseline nor a
paid trial. Read the evaluation reference before constructing new checks.

An explicit operator decision can waive a comparative baseline, trial, or replacement proof. Record the override and its reason in the session, then continue. Do not preserve the waived gate through a pilot, compatibility wrapper, hidden blocker, or renamed requirement.

**Complete when:** the skill carries its required warrant, and the selected evidence or material unresolved boundary matches the actual change and claimed benefit.

### 4. Design the smallest coherent skill

Read [skill-design.md](skill-design.md). Confirm the name, invocation mode, description boundary, directory shape, client compatibility, and progressive-disclosure plan. Keep the root `SKILL.md` as the procedure needed on every activation. Put conditional depth in focused, one-level references.

Add scripts only for repeated deterministic work or checks. Add assets only when output construction requires stable source material. Do not create auxiliary documentation that the skill does not use.

**Complete when:** each file has one runtime retrieval or execution purpose.

### 5. Draft for another agent

Write a reusable method rather than a narrative of the originating task. Put activation knowledge in the description because the body loads only after selection. Give each fragile step an observable completion condition. Prefer a clear default and a bounded escape over a menu of equal options.

Keep environment-specific gotchas that prevent likely errors. Remove generic explanations that a capable agent already knows.

**Complete when:** a fresh agent can execute the procedure without the originating conversation.

### 6. Validate structure and scripts

Establish the required portable shape and affected link correctness. Use direct
source/link inspection during drafting and follow resource-validator requirements
under the repository's final-verification owner. When selected or required, run:

`node skills/harness/scripts/validate-skill.mts <candidate-skill> --format json`

Resolve failures and justify warnings against the governing contract. Select
checks for new or changed scripts and reuse applicable evidence for unchanged
scripts. Preserve non-interactive operation, safe defaults, bounded output,
documented dependencies and `--help`. Discovery evidence must reach the intended
package, global, project, settings or CLI source when that claim is in scope.
Do not duplicate validator or discovery checks solely for a new milestone.

**Complete when:** the required shape and changed script contracts have sufficient
applicable evidence, and discovery claims reach the intended client boundary.

### 7. Evaluate proportionately

Separate activation, intended output and comparative benefit. Relevant tasks
consult the skill; plausible near misses do not. Output evidence establishes the
intended result. Comparative evidence establishes improved task, cost or reliability
when that benefit decides acceptance.

Select cases for the changed activation boundary, plausible near misses and
intended output. Use the intended model or a justified proxy. Compare only where
the claimed benefit requires it; deliberately sample consequential variation and
state reliability limits. Reuse evidence that remains applicable and recheck
invalidated cases, not a fixed quota or the whole set after every edit. Keep
temporary evaluation material outside tracked paths. Follow
[skill evaluation](skill-evaluation.md) and the repository's completion policy.

**Complete when:** evidence supports the bounded activation, output and benefit
claims that matter, or the necessary unavailable layer is explicit. An operator
choice or waiver retains its stated scope.

### 8. Place and close

If the operator already selected the destination, do not request placement approval again. Otherwise, present the completed skill, inspected sources, validation evidence, behavior evidence, and open trade-offs before writing to a shared or global location.

Update package indexes and current documentation in the same change. Report a deliberate non-creation when adoption or composition removed the need for a new skill.

**Complete when:** the approved location contains one coherent skill with no stale predecessor references or temporary evaluation residue.

## Authoring rules

- Match the directory name and frontmatter `name` for portable clients.
- Keep the description within the Agent Skills limit and state both capability and boundary.
- Use relative links from the skill root and keep references one level deep.
- Use client-specific fields only after the active client documents them.
- Keep prescriptive detail proportional to fragility.
- Preserve one subject per skill; use references for variants inside that subject.
- Revisit the surface choice when executable interception or host state enters the requirement.
