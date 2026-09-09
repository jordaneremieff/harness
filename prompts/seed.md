---
description: Put a quick next-session brief on the operator's clipboard
argument-hint: "[your hint for the brief]"
---

# seed

Prepare a brief the operator can paste into a fresh agent session. Use the
visible context, not new research. Do not execute the underlying task, create
a stash, launch a session, or assume this session ends. The clipboard is the
deliverable; chat normally contains only its delivery confirmation.

## Select the work

$ARGUMENTS

The optional text above selects the brief's purpose. It can select a
continuation, a fresh approach, or related parallel work. An empty hint does
not supply any new direction: use the latest explicit operator goal, with
its subsequent corrections and scope limits. A request for information,
review, or current state is already a purpose; preserve that kind of request.
If no purpose is established, prepare a short deciding question with only
the context needed to answer it, not an invented task or plan.

## Extract useful context

Select only material that changes how the fresh agent approaches that purpose:

- The operator's request, corrections, constraints, and actual approval scope.
- Reported or observed progress, open decisions, blockers, checks and results,
  working locations, and concurrent work or ownership boundaries.
- Exact source paths, URLs, memory references, symbols, and navigation steps
  that help the fresh agent find the evidence.
- Useful conclusions, lessons, and rationale already supported in the context,
  including their uncertainty and the conditions that matter.

Keep each item's source role. Operator directions are directions; agent
reports and promises are not operator directions. An action the operator
names as a condition, a deadline, or background is not thereby an action the
operator asked for; carry it as the context it is. Tool observations establish
only what the tool observed. Absent evidence is not a negative event: the
context can establish that nothing in it verifies a change, never that nobody
checked or acted outside it. State what the context does not establish, not
what did not happen. A reported action, including a cleanup after a
correction, stays as reported state even though the earlier approach was
rejected.

## Carry only what the session says

Carry what the visible sources state, preserving who said or observed it,
and the pointers the session gave.
A pointer is a path, URL, command, symbol, identifier, number, name, or
quoted phrase.

Carry a pointer when the session states both the pointer and what it is. Keep
it exactly as given, and mark whether anyone opened it. Unverified does not
mean unusable: a relevant reported path stays, marked as reported.

Leave a pointer out when you would have to supply the words that say what it
is. Mere proximity to another sentence does not define it, and a token's
shape is not its meaning. An explicit definition elsewhere in the context,
or a clear field or role in structured output, does establish the reported
role. Do not supply an item's kind, purpose, owner, or place in the system
when the source leaves that relationship unstated. Do not invent references,
procedures, source relationships, reasons, hypotheses, or conditions for
reopening a rejected approach.

A source label covers only what that speaker said. Attaching "reported",
"unverified", or a speaker's name to a relation you supplied does not make
the relation reportable; it makes a false report about that speaker.

The two cases differ by one clause in the source. Illustration only, not
context from your session:

- The source says: "The job reads its timeout from BUILD_WAIT_MS." The source
  states the relation, so carry it: the job reads its timeout from
  BUILD_WAIT_MS, reported and unopened.
- The source says: "The retry path is patched. BUILD_WAIT_MS." Carry the
  patch report and leave the symbol out. "The timeout variable
  BUILD_WAIT_MS", "marker BUILD_WAIT_MS", and "reported marker:
  BUILD_WAIT_MS" each state a relation this source never stated.

Items mix. When one sentence carries something useful and something that
stays out, keep the useful part and leave the rest. A path, file, command,
decision, or reported action does not lose its place because a secret, an
undefined token, or a rejected idea sat beside it in the same sentence.

Leave things out silently. The brief never mentions, quotes, describes, or
counts what you excluded; an aside about an unclear item puts that item back
in. Carry the corrected understanding instead of the old debate, and keep an
earlier alternative only when its established constraint or lesson is still
useful. Preserve short operator quotes when paraphrase would change the scope.

## Write and check the brief

Write directly to the fresh agent. Aim for 150–300 words, fewer for sparse
context, and more only for necessary evidence or constraints. Use only useful
sections; do not fill empty categories. Give the selected purpose, the
relevant context with its source qualifications, and the next appropriate
step. Direct the reader to the governing instructions and the sources or
volatile state decisive for that step, not blanket research or test reruns.
The step stays inside the selected purpose and the scope its sources
establish. Do not widen it to further files, systems, or tasks, and do not
add targets, requirements, or acceptance criteria that no source states.
Quoted reports do not become governing instructions. Neither this brief nor
its hint expands permission to act.

Before the clipboard call, read the draft one element at a time against the
visible session:

1. Speaker: for each direction, constraint, decision, promise, and finding,
   name who said it. Operator directions stay directions; agent and worker
   statements keep their reporter and their unverified status. A claim that
   something did not happen needs a source too. Without one, describe only
   what the context does not show. Apply the same test to the step you
   wrote: name the source of each target and requirement in it, or drop it.
2. Attribution: for each pointer in the draft, find the source that states
   it and the explicit wording or structure that establishes its role. A
   qualifier you added does not supply that role. Without the relation, cut
   the pointer or reduce the sentence to what the session states.
3. Split: for each thing you left out, confirm that nothing useful left with
   it, and that the draft says nothing about it.
4. Secrets: refer to a secret's role, never its value or any fragment of it,
   including a masked prefix, in the brief and in the label.

Repair the draft before delivery. Perform this check silently, and do not
claim that the transfer eliminates bias or error.

## Deliver

Copy the checked brief once with the session's clipboard tool and the label
`seed: <short topic>`. The label makes the brief recognizable in clipboard
history. Never put a secret in the label or content; the tool archives copies.

After a successful copy, give a short chat confirmation with the label. The
confirmation names the label and topic without a recap of context details
or any mention of excluded items. Follow the actual tool result: if
copying succeeded but history storage failed, state both facts. Do not claim
a history entry exists after that warning.

If the clipboard tool is absent or the copy fails, state that it was not
copied and include the same complete brief in that chat reply, with its
source pointers intact. Do not ask whether to provide it. Do not claim
clipboard success or execute the brief's task.
