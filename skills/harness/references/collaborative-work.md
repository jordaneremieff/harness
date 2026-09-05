# Collaborative harness work

Use this reference when the request opens harness inspection or improvement
without fixing the change in advance, or when any part of the work is delegated
to other workers or a later session. It owns intent derivation, delegation,
correction, integration, and the effort brief. The lane references own their
surface procedures.

No command or separate entrypoint activates this method. An ordinary harness
task that asks what to inspect, what to improve, or that needs more than one
session is enough.

## Contents

- [Inspection scope](#inspection-scope)
- [1. Derive the intent](#1-derive-the-intent)
- [2. Separate direction from interpretation](#2-separate-direction-from-interpretation)
- [3. Delegate real work](#3-delegate-real-work)
- [4. Correct active work and verify receipt](#4-correct-active-work-and-verify-receipt)
- [5. Integrate and complete](#5-integrate-and-complete)
- [6. Report the result](#6-report-the-result)
- [Independent checks](#independent-checks)
- [The effort brief](#the-effort-brief)

## Inspection scope

Inspection covers the installed Pi package (documentation, declarations,
source, shipped examples), relevant upstream work, this repository's resources,
other local resources the session can already read, and the workspace
conventions that govern them.

Inspection scope is not mutation authority. Reading a resource authorizes
nothing about changing, activating, installing, publishing, or removing it. The
approval, authority, and repository rules in [the main harness
skill](../SKILL.md) keep their force through every step below.

## 1. Derive the intent

State the outcome, the acceptance criteria, and the granted permissions from
the request and the established sources: operator instructions, loaded
instruction files, repository rules, prior decisions in the session, and the
artifacts the request points at.

Do not ask for a decision those sources already settle, and do not ask the
operator to restate an instruction already given. Ask only for a decision that
no available source and no granted authority can supply, and ask it as one
narrow question.

**Complete when:** the outcome, acceptance criteria, and permissions are
written from named sources, and no open question remains that a readable source
answers.

## 2. Separate direction from interpretation

Label each element of the working model as an operator direction (stated by the
operator or by a binding instruction file) or an agent interpretation (derived,
inferred, or chosen by you). Keep the labels through delegation, reporting, and
handover, because a worker or a later session cannot recover them from the
result text.

Interpretations are yours to revise as evidence arrives. Directions are not:
change one only on a new operator statement, and say what changed when you do.

When a correction changes one factual premise, restate the correction at its
supported scope, name the invalidated premise, and recompute every conclusion
that used it. When a correction rejects the governing interpretation itself,
stop editing the previous artifact and rebuild the model from the corrected
understanding.

**Complete when:** every load-bearing element carries its label, and no
superseded premise remains in the plan, the dispatches, or the pending report.

## 3. Delegate real work

Delegate work another session can complete on its own: verification,
investigation, review, research, drafting, and bounded implementation inside
one owned surface. Keep composition, source verification, acceptance, and
closure with the primary session. Dispatch independent units in one batch
rather than in sequence.

Each contract states four things: the objective and what done means, the exact
output the result must contain, the sources and paths to start from, and the
boundaries the worker must not cross.

Give every worker the same governing context in addition to its own contract:

- the outcome and why the work is wanted;
- the direction and interpretation labels from step 2;
- the decisive facts already established, with their qualifications intact;
- the surfaces, permissions, and destinations that stay closed;
- how the result will be judged and what consumes it;
- which sibling work exists and what depends on it.

The primary must receive every fact it needs inside the returned result. Do not
assume the primary can read a worker's private context, transcript, or
intermediate reasoning, and require each contract to name the facts the
submission must carry.

Use the session's public delegation tools; in this harness they are `subagent`,
`subagent_status`, `subagent_inspect`, `subagent_steer`, and
`subagent_collect`. Read the installed tool definitions before dispatch: they
are the exact runtime contract for fields, limits, and delivery behavior.

When the dispatch tool exposes a shared-context field, send the governing
context as one exact snapshot for the whole batch through that field, and keep
each task's four-part contract separate. The snapshot never replaces a task's
objective, output contract, sources, or boundaries, and it grants no authority,
tools, or cwd context of its own. Oversize text fails the dispatch before any
worker starts, so keep the snapshot small enough to send. When the field is
absent, carry the same governing context in each task's text; the method does
not change.

When workers can send interim reports, use a report for a consequential
finding, a blocking question, or a fact that changes the primary's plan. Do not
use reports as periodic progress. A returned send means the report was sent
unconfirmed, not received, read, or acted on. A report neither ends its worker
nor grants it authority, and it never replaces the final result: every
submission stays self-contained and remains the accepted record.

Keep no second ledger. Worker records, submitted results, and the effort brief
already hold this state.

When no delegation tool is available, do the work in the primary session under
the same rules.

**Complete when:** each dispatched contract carries its objective, output
contract, sources, boundaries, and the shared governing context; a fresh reader
of one contract could judge its own result; and the contract states the facts
the submission must return.

## 4. Correct active work and verify receipt

When a fact, a boundary, or the outcome changes while workers are running, send
the correction to every affected worker before their results are accepted.
`subagent_steer` delivers to a live worker after its current tool call and
before its next model call; on an idle interrupted worker it resumes the run
with the message.

A returned steer call means the message was accepted for delivery. It is not
evidence that the worker received or applied it. Confirm receipt in the
worker's own record with `subagent_inspect`, or in its submitted result, before
you accept any result that depends on the corrected fact. If the worker already
finished under the old fact, re-dispatch or redo that part; do not repair it by
reinterpreting the result.

**Complete when:** every affected worker shows the correction in its transcript
or its result, and no accepted result rests on a superseded fact.

## 5. Integrate and complete

Verify each decisive worker claim against its primary source before it enters
the integrated result. Preserve every qualification a worker attached; uncertain
support never becomes categorical absence, and an unchecked claim never becomes
an established one.

Apply the integrated change in the surfaces the task authorizes, each in its
own slice, and run that repository's closure gates. Complete all authorized and
answerable work in one pass.

Stop only the actions that depend on a disputed fact or on authority you were
not granted. Name that exact boundary and continue the rest of the authorized
work; a single blocked action does not suspend the effort.

**Complete when:** the authorized outcome exists in its owned surfaces, its
gates ran, and each unfinished item names the disputed fact or the missing
authority that stopped it.

## 6. Report the result

Lead with the resulting state and what it now does for the operator. Give the
evidence that decides the conclusion, not a transcript of the work or a list of
worker activity.

Report any discovery that changes the operator's available choices: a source
that contradicts the request's premise, a cheaper or safer route, a cost the
request did not anticipate, or an authority the outcome will need next. Report
a limitation when it blocks the conclusion, reduces confidence in it, or needs
operator action.

**Complete when:** the report states the effect, its decisive evidence, and
every choice-changing discovery, without a menu for decisions already settled.

## Independent checks

Vary the evidence facet when a check must be independent: a different source, a
different fact base, a different framing or role, a different method, or direct
reproduction of the behavior. Workers that share one briefing, one source set,
and one model family sample one posterior. Their agreement measures stability
under that briefing, not truth.

A different model family reduces shared reasoning tendencies, and it is worth
using when the question turns on judgment or on a blind spot one family may
share. It is not proof by itself, and worker count never becomes evidence.
Before treating convergence as corroboration, state what every worker shared
(brief, sources, tools, decomposition) and ask what single missing fact or
framing error could make all of them wrong at once.

Choose the diversity the current question needs. Keep no standing squad,
reviewer roster, or fixed count; dispatch the checks the question requires and
stop when the claim is reached.

## The effort brief

Keep one private effort brief when the work is substantial and either has
dependent parts across workers or continues past this session. Short
self-contained work needs no brief.

The primary session owns the brief and maintains it. The operator never
maintains it and is never asked to.

The brief records the outcome, the direction sources, the interpretations, the
permissions, the decisive facts with their qualifications, the dependencies
between parts, the accepted results, and the next action. It does not duplicate
worker lifecycle records, transcripts, or exact submitted results.

Memory, handover stashes, Pi session records, Git, and worker results keep
their existing responsibilities. The brief adds no shared store and replaces
none of them. Keep it outside tracked repository paths.

Write the brief where a fresh session can read it, and write it so that session
can continue the work without an operator restatement of the intent.

The session's loaded context-capacity instruction remains the operative rule
for when to preserve, hand over, or stop. This reference sets no threshold of
its own and adds no monitor.
