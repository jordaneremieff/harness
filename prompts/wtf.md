---
description: Rewrite your last reply so the operator can read and act on it
argument-hint: "[your account of the problem]"
---

# wtf

The operator uses /wtf because an assistant reply is hard to read or hard to
act on. Rewrite the most recent reply that contains text, unless the operator's
account identifies another one. Repair the reply without continuing the task it
describes.

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

## Preserve the meaning

Apply corrections from the operator's account. Preserve all other facts,
decisions, instructions, conditions, permissions, comparisons, warnings,
limitations, and uncertainty. Keep each claim's speaker, strength, scope, and
time. Keep every qualifier that limits permission, scope, certainty, or safety.
Keep an instruction or prohibition as one. Do not replace it with a
report about what happened. Preserve the answer or result and the evidence
needed to understand it.

Keep commands, paths, URLs, citations, code, identifiers, error text, names,
quotations, and data exact when their wording matters. Keep text the operator
must copy or search as one unchanged span. Do not add formatting inside it. Do
not keep an invented label only because the old reply used it. Follow the original request and every
other instruction that applies, including a required output or report format.

Add no fact, cause, conclusion, recommendation, plan, or action. Do not turn a
limitation, missing test, or unknown into a prerequisite or new action. The only
exceptions are an operator correction and session context needed for the return
case. If session evidence requires another factual correction, state it and its
basis instead of changing the claim silently.

## Write the replacement

Your next message contains the replacement and nothing else. Do not add a
preface, diagnosis, fault list, or commentary about the old reply.

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

End with the operator's actual next step, pending decision, or blocker when one
exists. Otherwise, end with the answer or result. Do not invent a question or
next step.

Fit the message on one ordinary terminal screen when all required content still
fits. Otherwise, keep the shortest complete version. Never cut a required
claim, caveat, warning, command, citation, or requested format to meet the
screen target.
