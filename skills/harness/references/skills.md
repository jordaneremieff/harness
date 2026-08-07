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

### 3. Establish the baseline or explicit override

For a new or behavior-shaping skill, observe the task without the candidate, compare with the previous version, or cite an already-observed failure. Classify the baseline as failure, partial success, or success. Read [skill-evaluation.md](skill-evaluation.md) before constructing trigger or output checks.

An explicit operator decision can waive a comparative baseline, trial, or replacement proof. Record the override and its reason in the session, then continue. Do not preserve the waived gate through a pilot, compatibility wrapper, hidden blocker, or renamed requirement.

**Complete when:** the candidate targets an observed gap, measured benefit, fixed operator choice, or explicit override.

### 4. Design the smallest coherent skill

Read [skill-design.md](skill-design.md). Confirm the name, invocation mode, description boundary, directory shape, client compatibility, and progressive-disclosure plan. Keep the root `SKILL.md` as the procedure needed on every activation. Put conditional depth in focused, one-level references.

Add scripts only for repeated deterministic work or checks. Add assets only when output construction requires stable source material. Do not create auxiliary documentation that the skill does not use.

**Complete when:** each file has one runtime retrieval or execution purpose.

### 5. Draft for another agent

Write a reusable method rather than a narrative of the originating task. Put activation knowledge in the description because the body loads only after selection. Give each fragile step an observable completion condition. Prefer a clear default and a bounded escape over a menu of equal options.

Keep environment-specific gotchas that prevent likely errors. Remove generic explanations that a capable agent already knows.

**Complete when:** a fresh agent can execute the procedure without the originating conversation.

### 6. Validate structure and scripts

Run the bundled validator from the `harness` skill directory or use its repository-relative path:

```bash
node scripts/validate-skill.mjs <candidate-skill> --format json
```

Resolve failures and justify warnings. Test every bundled script directly with successful and failing inputs. Scripts must be non-interactive, safe by default, bounded in output, documented with `--help`, and explicit about dependencies.

In Pi, also verify discovery from the intended package, global, project, settings, or CLI source.

**Complete when:** the skill has a valid portable shape, its relative links resolve, its scripts behave as documented, and the intended client discovers it.

### 7. Evaluate proportionately

Separate two claims:

- **Trigger quality:** relevant prompts consult the skill and genuine near misses do not.
- **Output quality:** the skill improves the completed task, cost, or reliability against the selected baseline.

Use realistic prompts and the intended model or a close proxy. Start with a small operator-reviewed set. Expand only when early results expose uncertainty that matters. Keep temporary outputs, transcripts, graders, and evaluation workspaces outside tracked repository paths.

Follow the owning repository's manual-review sequence. Do not let broad automated runs delay a complete reviewable draft.

**Complete when:** the evidence reaches the activation and output claims that justify placement, or an explicit operator override names the waived proof.

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
