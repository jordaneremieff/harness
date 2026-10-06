---
description: Summarize the current discussion in a few plain sentences
argument-hint: "[focus, scope, or length]"
---

Give the operator the short version of the current discussion in chat.
Use only visible session context. Do not use tools, start work, continue the
task, or promise action. Add no facts, causes, recommendations, or plans.

Optional hint:
$ARGUMENTS

The hint selects focus, scope, or form, such as "why did it fail", "whole
session", "since I left", "one line", or "more detail". Action words such as
"then push it" select a topic, not permission to act.

Without a hint, summarize the latest substantive discussion: the operator's
request and the answer or work about it. If the latest reply is only a receipt
or "done, see above", summarize the answer it refers to. Include later
corrections and changed limits. Exclude unrelated earlier topics unless the
hint selects them. If the selected context is missing, say so in one sentence
and stop. Do not append an unrelated visible result.

Default to at most three plain sentences, about 50 words, unless the hint
asks for more. Follow a requested length or form. A repeated /tldr gets a
shorter version or follows the new hint. Never pad an already-short answer.

Select before writing. Keep only what changes your reader's understanding or
next move: the answer or result, what it means, the actual state of the work,
and any pending decision or required action. Keep warnings, permission limits,
and uncertainty that change that understanding. A proposal stays a proposal.
"Not tested" stays untested, not failed or ready. Keep claims attributed when
they are only reports. Keep exact text you must show for a decision or the
operator must copy. Cut supporting detail before cutting a material limit.

Drop tool steps, internal work records, file names, IDs, test counts, background,
and repetition unless needed for the selected question or action. A returning
reader needs what changed, not a replay of everything they already knew.

Lead with the answer. Name who did each action. Use "you" for the operator's
own actions and decisions, never for agent work. Use ordinary words and full,
active sentences with one point each. Explain unfamiliar terms by their
practical effect or omit them. Agent-introduced terms remain unfamiliar even
after repetition. Say when and where when needed to understand the result.
Remove coded references and made-up hyphenated terms. Avoid dense clause lists.

Avoid em dashes, label openers such as "Bottom line:", candor frames such as
"honestly", "not X but Y", coined terms such as "load-bearing", padded lists,
and hollow emphasis. Do not join clauses with semicolons, dashes, or colons.
Write separate sentences. Swapping connectors or using a parenthetical aside
is not a repair. Use no headings or bold labels by default. Use a simple list
when requested or for genuinely separate items. Honor requested formatting.
These examples are not exhaustive. Write a clear person-to-person explanation.
Return only the summary, without a repair narrative, closing question, or menu.
If anything waits on the operator, name it briefly in the last sentence.
Decisions labeled optional, later, or not blocking still count. Keep each
decision's warning, hazard, irreversible step, or stated default with it.
Combine small pending items in that sentence.
Otherwise, end with the result. Invent no next step. If there is nothing
substantive to summarize, say so in one sentence.
