---
name: auto
description: >
  Carry a task that the operator hands over to a delivered, verified result
  without the operator's approval or guidance: decide open questions, do every
  part, use any tool and other agents, verify, deliver, and report once. Use
  when the operator invokes auto or asks for a task to be done on auto,
  autonomously, unattended, or end to end without checking back, or when a
  brief carries such a hand-over from the operator. Hold an act only for a true
  blocker or a true risk, and finish everything else. Do not use when the
  operator asks to approve a plan or see a proposal before work proceeds. A
  task whose deliverable is itself a proposal can still run on auto.
compatibility: Pi. Delegation and self-compaction use the agent tools, and questions to the operator use the rex extension's rex_ask, when the session offers them.
---

# Auto

The operator has handed over a task and the decisions in it. Deliver the
finished, verified result in this run, and bring the operator only what truly
needs the operator.

## The hand-over

The operator's request to work on auto is the grant. It covers every decision
that the task needs, and every act that the task names or that its outcome
cannot exist without: the approach and design, the tools, other agents and
their models within the machine's delegation preferences, and delivery as the
destination's own rules define it. When those rules, such as a project's
contributing guide, ask for more than the task names, for example a push after
the commit that the task names, delivery includes it unless the operator ruled
it out. An act that the task does not name still passes the true-risk test
below. A covered act needs no question, and for the machine's rule about
asking first it is inside the request.

The task is the text after `/skill:auto`. When nothing follows, it is the
request that the conversation has already set. When the deliverable is itself
a proposal, plan, or review, produce it on auto and stop there. Loading this
skill without such a hand-over from the operator grants nothing beyond the
request in hand.

The grant leaves in force the operator's explicit restrictions, the repository
and machine instructions, and policy rules that hold an act for the operator's
approval. Where an instruction or a recorded preference asks for the
operator's approval of an act that the hand-over covers, the hand-over is that
approval, and the report names the act and its basis. A policy rule's hold still needs the operator's own answer.
Messages from the operator during the run are direction, and the newest one
governs.

## True blockers and true risks

These are the only reasons to hold an act.

A true blocker is a fact, access, capability, or resource that the task needs
and that no available source, tool, agent, or other route can supply: an
unconfigured credential, a service or account that refuses, every model that
the machine's delegation preferences allow for the work at its limit, an act
that only another person can take. Ambiguity, a choice between reasonable
designs, a failing check, an unfamiliar codebase, and a missing tool that a
script or another tool can replace are work, not blockers.

A true risk is an act that the task does not name and whose effect is hard to
undo or reaches people, systems, or work outside the task. The common cases
are:

- deleting or overwriting data or work that you did not create, when no
  backup, copy, or version history can restore it;
- messages, posts, comments, or mail to other people;
- publication beyond this machine that neither the task, the destination's
  rules, nor a standing operator direction for that destination makes part of
  delivery;
- spending money, or using credentials beyond their configured use;
- changes to production or shared external systems;
- exposure of secrets or private data.

An act that the operator's policy rules hold for approval is a true risk by
the operator's declaration. Reversible changes, model and tool use under the
machine preferences, and acts that the task names are not risks.

Before you hold an act, look for a route that removes the risk: take a backup,
a copy, or a branch so that the act can be undone, or reach the outcome
another way. Before you call something a blocker, name the exact gap and try
the proportionate paths that could close it.

Do not drop a step that the task or the destination's rules call for. Do it,
or hold it as a true blocker or a true risk.

When an act stays held, finish all other work and prepare the held act
completely, as the exact command, payload, or draft. If the operator handed
the task to you directly and the session has `rex_ask`, ask about each held
act with it: show the prepared act in the question's matter, put the choice
that changes nothing first, and mark your recommendation. Carry out the answer
and its note in the same run. When an agent's brief carried the task to you,
bring held acts to that agent instead. A held act without an answer goes into
the final report.

## Work the task through

1. **Fix the outcome.** Decide what the finished result is and which checks
   will show that it works. Read the memory, instructions, and sources that
   bear on it, and load the skills that the task calls for. Do not ask for
   approval of a plan.
2. **Decide.** Settle open questions from evidence, the operator's recorded
   preferences, the Pillars, and the repository's rules. Where you would
   otherwise ask the operator to settle a close, consequential judgement, have
   another agent challenge it, preferably one from another model family. Take
   the reversible option when the evidence is balanced. Keep each
   consequential decision and its reason for the report.
3. **Do all of it.** Complete every part of the task in this run, with no
   later phase, follow-up, or placeholder for work inside the task. Fix what
   the task depends on where the rules of that place allow the change, and
   otherwise work around it or report it as a blocker. Report a defect outside
   the task in one line instead of widening the task.
4. **Use everything available.** Use any of the session's tools that serve the
   outcome, including deferred tools that tool search finds. Bring in other
   agents where parallel progress, a specialism, or an independent check
   serves the outcome. The arrangement is yours to choose and revise. Give
   each agent the purpose, the facts it needs, and the grant for its part of
   the task with its source, say which delivery acts you keep, and ask a Pi
   agent to load this skill. Answer its questions yourself. Test each item
   that it reports as needing the operator against this grant and the
   true-risk test before you treat it so. Check its results before you build
   on them.
5. **Keep it recoverable.** Take a restore point, such as a commit, a branch,
   or a copy, before a risky phase such as a bulk rewrite or concurrent
   writers. Leave the work in progress of other sessions and agents alone
   unless the task names it.
6. **Keep moving.** When an approach fails or your reasoning circles, change
   the approach or get advice from another agent. When the context fills,
   compact with a continuity summary and continue. Save a handover only when
   the run itself must end.
7. **Verify the outcome.** Run the checks from step 1 where each claim lives:
   run the result, test it, and use it as the operator would. Do not weaken,
   skip, or delete a check to get a pass; when a check itself is wrong, fix it
   and name the fix in the report. You own the quality judgement. Get an
   independent review where uncertainty is material, fix what it confirms,
   and stop reviewing when the evidence supports the result. The task is done
   when every part of the outcome passes its check.
8. **Deliver.** Land, activate, and publish where the task, the destination's
   rules, or a standing operator direction for that destination make these
   part of delivery, and confirm each resulting state.

## Report once

End with one message that stands alone, because the operator might read only
that one.

- Lead with the result: what now works, how you know, where it is, and its
  delivery state. Name the outcome you worked toward when your reading of the
  request differs from its plain reading.
- List each choice that the request left open and that you settled, even a
  small one such as a name or a format, and each delivery step that you took
  or held, each with its reason, so that the operator can reverse any of them.
- For each act still held, give the prepared act and one direct question. For
  each blocker, say what it holds and what you tried.

Leave out plans for approval, option menus, requests to judge quality, and
offers of further work.
