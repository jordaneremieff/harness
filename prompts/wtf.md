---
description: Rewrite your last reply so the operator can read and act on it
argument-hint: "[your account of the problem]"
---

# wtf

The operator uses /wtf because an assistant reply is hard to read or hard to
act on. Repair the answer or result they need to understand, not merely the
last message's wording. Use only the visible session context. Do not use tools
or continue the task the reply describes.

## Select the target

An assistant reply identified by the operator's account is the target.
Otherwise, start with the most recent assistant reply that contains text.
If it only acknowledges receipt, reports completion of administrative work,
or points back to an answer without explaining it, follow that reference to
the nearest visible assistant answer or result for the same task. Rewrite that
answer, carrying forward any later correction, changed state, or permission
limit from the same task. Do not return another notice that the answer exists.

Select by purpose, not length: a short answer, refusal, blocker, or decision is
still a target. If it is already clear, return it unchanged rather than expand
it into a tutorial or a new action. Do not skip it for an older, longer reply. Do not cross an
intervening change of subject or combine independent answers. If the operator
explicitly selects an administrative notice, rewrite that notice.

If the target answer is not visible or the reference does not identify one,
state that boundary without inventing a replacement. Do not treat the operator's command, a tool result, or quoted
third-party text as the assistant reply. Use other messages only to identify the
target, apply operator corrections, or recover necessary session context. Do
not merge unrelated text from other replies into the replacement.

If the target reply is already a /wtf rewrite, keep every successful repair.
Use the original failed reply only to recover meaning the rewrite lost. Fix the
remaining faults without adding repetition or dropping content.

## The operator's account

$ARGUMENTS

If text appears above, use it as the primary account of the problem and a
constraint on the rewrite. Then inspect the full target reply and the visible
session context it depends on.

## The reader

Judge the needed context from the operator's account and visible session
evidence.

In the return case, the operator was away. They know why the session exists and
roughly what it was doing. They do not know what changed or what that change
means for their next move. Restore only those missing facts.

In the caught-up case, the operator watched the reply land and holds the full
context. Add no recap.

If the evidence does not settle the case, do not guess what the operator
remembers. Include only the context needed to understand the current state and
next move.

## Examine the reply

Read the target reply and its visible session context before you write.
Identify the causes that make this reply hard to absorb or use. The examples
below are only starting points:

- terms the reply uses without definition;
- references to steps, decisions, or evidence the operator never saw;
- repetition or length that forces scrolling or a copy elsewhere;
- questions at the end that assume context the operator does not hold;
- invented labels or needless abstractions where ordinary words work;
- clause chains that hide the actual claim or action;
- headings, lists, or paragraph breaks that add no useful order.

Find any other cause that blocks comprehension or action. Do not inventory
every surface form. Keep the diagnosis out of the delivered message.

For a proposal, lead with the recommended change, not a definition of its
abstract concept. Explain its job, what happens in use, what existing parts
already do, and what the proposal adds. Retain its concrete proposed interfaces,
placement, evidence, limits, and requested decision. Use only what the selected
answer and necessary same-task context establish; do not design missing parts.

## Preserve the meaning

Apply corrections from the operator's account. Preserve the target reply's other
facts, decisions, instructions, conditions, permissions, comparisons, warnings,
limitations, and uncertainty. Keep each claim's speaker, strength, scope, and
time. Keep every qualifier that limits permission, scope, certainty, or safety.
An approval request must remain an approval request for the same action, not
an instruction to execute that action. Do not substitute an inferred state for
an explicit one, even if they seem equivalent.
Keep explicit negative facts, including work not done and state left unchanged;
do not drop them because another sentence seems to imply them.
Keep an instruction or prohibition as one. Do not replace it with a
report about what happened. Preserve the answer or result and the evidence
needed to understand it.

Keep commands, paths, URLs, citations, code, identifiers, error text, names,
quotations, and data exact when their wording matters. Keep text the operator
must copy or search as one unchanged span. Do not add formatting inside it. Do
not keep an invented label only because the old reply used it. Follow the
original request and every other instruction that applies, including a required
output or report format.

Add no fact, cause, conclusion, recommendation, plan, or action. Do not turn a
limitation, missing test, or unknown into a prerequisite or new action. The only
exceptions are an operator correction, the same-task context required by target
selection, and session context needed for the return case. If session evidence requires another factual correction, state it and its
basis instead of changing the claim silently.

## Write the replacement

When the target is visible, your next message contains the replacement and
nothing else. Do not add a preface, diagnosis, fault list, or commentary about
the old reply.

Rebuild a sentence whose shape caused the fault. Merge repeated claims. State
each fact, warning, and action once. Delete sentences that only announce
importance, summarize structure, or repeat a conclusion. Use ordinary words,
direct verbs, and concrete relationships. Do not preserve the
old sentence count, clause structure, rhetorical framing, or emphasis merely
because it was there.

Let the content and the operator's requested format select the structure. Break
paragraphs at real changes in thought. Use headings, bold labels, bullets, or
numbered steps only when the request or content needs them.

Use vocabulary already established in the session, and preserve exact technical
names. Replace invented labels with ordinary names. Define a necessary term at
first use only when the session has not established it. Do not carry any cause
of the original failure into the replacement.

Before sending, compare the replacement with the selected answer and its later
constraints. Restore any lost negative fact, permission limit, uncertainty, or
evidence needed to support the result. Remove added claims and task
continuation. A promise in the old reply to start work is not permission to
start it now or to renew that promise in the replacement.

End with the operator's actual next step, pending decision, or blocker when one
exists. Otherwise, end with the answer or result. Do not invent a question or
next step.

Fit the message on one ordinary terminal screen when all required content still
fits. Otherwise, keep the shortest complete version. Never cut a required
claim, caveat, warning, command, citation, or requested format to meet the
screen target.
