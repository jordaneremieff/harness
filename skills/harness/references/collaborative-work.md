# Collaborative harness work

Use this reference for open-ended harness improvement or work across workers
or sessions. The [main workflow](../SKILL.md) owns intent, authority,
implementation, verification, and closure. This reference helps select the
source scope and work method; it adds no separate approval or reporting gate.

## Ground the decision across the harness

Start from the operator's outcome, not an inherited component list. Identify
which source layers decide the next action:

- The active installation and its resource configuration establish what the
  operator currently uses. Installed Pi documentation, declarations, source,
  and examples establish the available host contracts.
- The repository, owning worktrees, and other relevant local resources expose
  candidate changes, reuse opportunities, and constraints. A candidate in a
  worktree is not evidence that the active installation uses it.
- Current upstream Pi sources and the repository's durable-harness guidance
  establish whether the host already owns, replaces, or plans the capability.
  Planned behavior is not an available runtime contract.

Read the layers that can change the decision. Name the unresolved question
before broadening inspection; whole-harness grounding is not an instruction to
read every resource. When the operator explicitly requests a comprehensive
review, inventory the requested resources first. Distinguish shipped, active,
provisional, and orphaned work; listing a path is not reviewing its content.
Assign each part a source boundary, owner, and final disposition so gaps and
duplicate work remain visible. If a source layer is unavailable, keep the
affected claim inside the evidence boundary rather than substituting another
layer's success.

Inspection does not grant mutation authority. Use the main workflow's existing
surface and authority rules for any resulting change.

## Choose the work method

Use the delegate skill (`skills/delegate/SKILL.md` under the package root) for the
work split, briefs, collaboration and result handling. For harness changes,
keep ownership of concurrent edits disjoint and give each split task a clear
integration destination. The shared-acts workflow (`docs/agent-delivery.md`, “Coordinate with related efforts”)
owns coordination for integration, activation and publication. A worker's
local commit does not establish integration or release. A narrow harness task
does not imply a reduced tool or resource environment.

Apply the Pillars consultation procedure to the actual judgment:

- **Governing Context** determines what a split or handover must preserve.
  Use existing session state or a reachable handover when it already suffices;
  this method requires no separate effort brief or ledger.
- **Corrected-Assumption Leakage** and **Frame Abandonment** determine which
  dependent work changes after a correction.
- **Verification Reach** determines whether returned evidence establishes the
  claim. Inspect the defining source or reproduce the behavior where needed.
- **Redundant Corroboration** determines what agreement between workers adds.
  A shared briefing supports integration, not independence of evidence.

## Finish the requested work

Return to the main workflow with the integrated result, not just a review of
the workers. Apply supported changes within the granted scope. Follow the owning
repository's single completion policy and final-verification owner; reuse applicable
evidence and check uncovered interactions rather than repeat each worker's commands.
If inspected evidence defeats a proposed change, show that evidence instead of
creating work to satisfy the plan.

Report the actual effect and any discovery that changes the operator's next
choice. Keep blocked actions separate from completed work. A useful candidate
that remains unactivated is a candidate, not a change to the active harness.

For delegated status reports, follow the repository reporting rule in `AGENTS.md`.

When the operator requests review of several outcomes, reconcile current source
and final dispositions before delivery. Lead with what changed and what remains
held. Separate settled authority from open choices. For each decision, show the
complete proposal, its effect, the no-action default, and material contrary
evidence. Make any prepared request self-contained and explicit about its
permitted effects. Let the reader choose the depth of supporting evidence. Link
sources without making the operator reconstruct the decision. Keep raw reports
and control details outside the human-facing account. Do not create a recurring
log or require operator curation.
