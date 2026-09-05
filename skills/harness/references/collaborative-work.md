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
read every resource. If a source layer is unavailable, keep the affected claim
inside the evidence boundary rather than substituting another layer's success.

Inspection does not grant mutation authority. Use the main workflow's existing
surface and authority rules for any resulting change.

## Choose the work method

Select the method for the actual dependencies and uncertainty. Complete a
self-contained repair locally when coordination adds no value. Use parallel
work for independent source checks or owned changes. Use shared exploration or
staged exchanges when one result changes another task's question. Honor an
explicit request for independent verification.

Give each split task an integration destination and acceptance criteria. Assign
composition and verification to the session best placed to do them; the session
that owes the operator the outcome remains accountable for delivery. Revisit
the split when evidence changes the problem. A list of completed worker tasks
is not an outcome if their combined result misses the request.

## Delegate with enough context

Use the available tools' current definitions for dispatch fields, lifecycle,
steering, result delivery, and limits. Do not reproduce those runtime contracts
in a second workflow. Keep ordinary-session capabilities available unless an
explicit boundary requires restriction; a narrow task does not imply a reduced
tool or resource environment. Report a capability failure as a defect, not as
permission to silently substitute a less capable worker.

Each task states its objective, required output, starting sources, and
boundaries. Preserve the governing context needed to judge and combine its
result. Use a shared snapshot when the tool provides one and the tasks share
that context. Supply source pointers with qualifications; distinguish operator
directions from interpretations that workers are free to challenge.

Ask workers to return decisive evidence and limitations in a self-contained
result. Use interim exchanges for discoveries that change ongoing work, not
periodic status. If a correction affects active work, verify its application
before accepting the dependent result. A send acknowledgement alone does not
establish that the correction changed the work.

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
the workers. Apply supported changes within the granted scope and run the
owning repository's completion gates. If inspected evidence defeats a proposed
change, show that evidence instead of creating work to satisfy the plan.

Report the actual effect and any discovery that changes the operator's next
choice. Keep blocked actions separate from completed work. A useful candidate
that remains unactivated is a candidate, not a change to the active harness.
