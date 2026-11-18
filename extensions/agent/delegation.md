# Delegate work with Agent

Use this guide when deciding whether to divide a task, briefing contributors, or handling their results. It applies with or without a playbook. The [Agent reference](README.md) and current tool definitions own controls, arguments and delivery. The [package delivery workflow](../../docs/agent-delivery.md) owns release acts and acceptance for harness improvements.

## Divide the work

Follow explicit instructions for the task first. Otherwise use the selected playbook's defaults. With no playbook, choose by the task. Revisit the arrangement when the evidence or dependencies change. A playbook grants no authority and does not choose a model or pass to another session by itself.

Direct work, selective assistance, peer collaboration and dedicated coordination are all valid. Divide work where independent progress, expertise, context isolation or a useful challenge makes up for briefing and integration. Keep tightly coupled work or work with caller-only access together. Do not require a manager, thread, roster or worker count. Outcome ownership allows substantive work, not just coordination.

## Brief contributors

Give each contributor a coherent outcome with enough context to judge and deliver it:

- Purpose, source pointers and qualifications, and the question or use path that matters.
- Granted authority and its source, restrictions, owned changes and explicit exclusions. Distinguish operator decisions from your own proposed method.
- Acceptance evidence, required checks, dependencies, end condition and result recipient.

A direct task message is sufficient; no contract file or template is required. Ask for decisive evidence, limitations and where to find detailed material. Reuse what the recipient already knows. Use a session whose expertise and ownership fit; preserve the current requester and reply route. Resolve a known expert before creating another. Use a fresh session for unrelated work, independent judgment, conflicting ownership or unsuitable retained context. Keep corrections and repairs with the current owner when that still serves the task.

[Optional templates and contract checker](delegation/contracts.md) help with briefs that benefit from a fixed structure. Use current delegation preferences when choosing a preset and the relevant public tool definition when setting a check-in. [Codemode recipes](delegation/codemode.md) show how to group calls and retain exact result references.

## Work together

Exchange facts that change someone else's next decision while the facts still matter. Let contributors challenge the proposed method and exchange evidence directly rather than relay it through a lead. Use a [peer thread](README.md#peer-threads) when changing shared facts, decisions or dependencies need a retained place. Otherwise, direct exchange is enough. Preserve the shared purpose, authority and source, restrictions, acceptance and who integrates. A declaration, post or admission receipt is not an agreement or proof of understanding. When a correction matters to acceptance, verify that the affected work changed.

## Supervise without polling

Keep the exact result reference from an answer-bearing dispatch. A creation receipt, name, check-in or peer post does not substitute for one. Do ready work while contributors run. Do not keep a run open for their output or imitate a wait with status reads or sleeps. Follow the Agent reference for [native declared work](README.md#declared-background-work), [ordinary yield](README.md#state-note-of-an-ordinary-session) and [exact result reads](README.md#read-peer-results). A state note is not a terminal answer.

When a missing result changes the next act, inspect the exact request and the relevant activity once. Distinguish a pending input, a provider retry, an open work declaration, a terminal result and an unavailable source. A newer contribution may obscure the final answer in a summary; find the exact result, not just the newest message. Use [recovery and delivery](README.md#recovery-and-delivery) for unreachable recipients or uncertain placement; do not resend merely because a result is not visible yet. Put the complete deliverable in the terminal answer after any thread contribution or interim report.

On a check-in, decide whether to continue, steer to a concrete action or stop hung or superseded work. On a quota wall, use the observed error and the current permitted alternatives. Substitute deliberately for the affected work only, retain its scope and evidence requirements, and report the substitution. If no suitable route remains, finish independent work and name the gap. Before context loss, preserve the agreed frame, evidence, owned work and exact next act; use the public continuity controls, not another watcher or journal.

## Integrate and accept

The session that owes the outcome integrates it. Check actual changes and the defining evidence for consequential claims, not just summaries or settlement. Reuse applicable checks and verify uncovered interactions. Review findings in time to change the result; reconcile real disagreements and stop when the acceptance evidence is sufficient.

Before exit, resolve this task's owned live work: integrate useful results, keep an explicit continuation for unfinished work, redirect changed work or stop superseded work. Do not stop unrelated or standing agents to close this task. State any limits that affect acceptance and name the exact boundary.

## Operator status reports

Write for an operator who reads only the newest message. Each message stands
alone: state the current situation, not a change from an earlier message.
Refer to no earlier message, tool call or report.

In every message to the operator, describe each internal name or use its
description instead: a name this work created or that only its participants use,
such as an agent, a branch, a work package or a check. Say what a commit changes
when you name it by identifier; a public release number needs no description.

Send a message only for a result, a blocker, or a decision or action that only
the operator can supply. An agent event that changes nothing for the operator
gets no message; a statement of no change is not a message.

Open a status report with one heading line for the current local date and
time. Read the clock; use 12-hour am/pm time with its zone label.
Lead with the decision the operator must make, when one exists; otherwise
with the answer to the question asked; otherwise with the current result.
Then state the relevant facts in this order:

1. The current state of the requested outcome.
2. Where finished work is and whether the system the operator uses includes
   it. Explain any gap.
3. What is in progress or waits, including ready work that has not started,
   and what each item waits for, if anything.
4. What happens next and what triggers it.
5. What the operator must do or decide.

Omit facts that have nothing useful to state. The opening line and the order
are fixed; other headings, layout and length are not.

Keep the complete result of extended work in one current document. Replace
that document whenever its content changes. Name its path in a message that
this rule permits; a change of the document alone is not a reason for one.
When the operator asks for the state, answer with the whole current state.

Batch contributor reports at the source. Each directing agent closes its part
in its state file. One agent combines those reports and sends one message for
the whole result. The operator's pane rule applies to material for the
operator; give the requesting agent the complete result.
