# Supervision

Supervise from delivered events: results, check-ins, thread notices, and
operator input. Never poll, sleep, or loop on status or inspection, and never
hold a run open for agent output. Continue your own part of the work while
agents run; when none remains, end the run with a state note that names the
open result references.

## Contents

- Check-in triage
- State notes
- Stalls
- The displaced-answer pitfall
- Quota walls
- Context watch and reset
- Exit

## Check-in triage

A check-in carries a bounded summary: tool-call count, current tools, the
last tool lines, and an unfinished-reply excerpt. Decide one of three:

- **Continue:** the work advances toward its end condition. State why in
  one line; no message to the agent is needed.
- **Steer:** the work drifts, repeats, widens past its scope, or waits on
  something you can supply. Send one concrete next act with its completion
  condition. Do not send "keep going".
- **Abort:** a tool hangs, or the work is no longer needed. Abort, then
  finish the missing part yourself or re-dispatch only that part.

After a steer, check that the next check-in or result shows the change
before you rely on dependent work.

## State notes

An agent that sent work and has none left ends its run with a state note. The
note says in its first words that it is not the result, and it names the open
work. Read it as open work, not as completion:

- Do not accept, integrate, or re-dispatch on a state note.
- Read the open work in `agent_status` with the agent's `sessionId` when you
  need its current state. Do not poll it.
- The final result arrives as a report whose first line says that it is the
  final result and names the request. Act on that.
- An answer that is neither a result nor a marked state note falls under "The
  displaced-answer pitfall".

## Stalls

Read `agent_inspect` `view: "activity"` for what the agent did last, and
`agent_status` with its `sessionId` for its current tools and open
submissions. Common causes:

- **Waiting on input:** the agent asked a question in a report or thread
  post. Answer it with a steer.
- **Repeating a failed method:** steer it to a different source or method.
- **Blocked tool:** a long command without a bound. Abort and give a bounded
  command.
- **New work behind the current step:** a followUp is placed at the agent's
  next tool boundary; the agent finishes its current step first.

## The displaced-answer pitfall

An agent writes its deliverable in a message that also calls a tool, such as
a thread post. A passive notice then arrives, the agent replies to the
notice, and that short acknowledgement becomes the request's terminal
answer. Prevent it in the assignment: post to threads and make other tool
calls first; the last message is the complete deliverable.

If a delivered answer reads like an acknowledgement, do not re-dispatch
yet. Read the agent's earlier assistant entries with `agent_inspect`
`view: "history"` and `source: "assistant"`, or `view: "exact"` on the entry
before the acknowledgement. The deliverable is usually there.

## Quota walls

Providers report exhaustion in different words: an hourly or five-hour
window, a weekly or monthly limit, a usage limit, out of credits, or a
billing block. The host settles the submission as unanswered with
`model_error` and never substitutes a model by itself.

1. Read the exact error: `agent_inspect` `view: "result"` with the
   `submissionId`. The provider block holds the error text. Do not parse a
   reset time into a schedule.
2. If the agent is still active, abort it.
3. Pick the substitute from the preferences' substitution order. Do not
   route through excluded providers.
4. Configure the idle agent with the substitute's exact model through
   `agent_configure`. A name or thinking change alone does not clear the
   block.
5. Send a continuation that names the state the failed run left, and keep
   its new result reference. The failed request stays inspectable.
6. Report the wall and the substitution to the operator in one line.

Check `agent_status` `view: "fleet"` before a large dispatch to see recent
failures. Its windows are partial lower bounds, not remaining quota.

A reason that starts with `content_refusal:` means the provider refused the
request content. The same task fails again on that provider. Choose another
explicit provider/model under your existing authority, or change the form of
the task; the host never substitutes a model by itself. A reason that starts
with `model_error:` carries the provider's text: read it before you repeat
the task. When a reason is only `model_error`, read the provider's text with
`agent_inspect` `view: "result"` and the `submissionId` before you repeat the
task.

## Context watch and reset

A long-lived agent that fills its context degrades, then fails. Track each
standing agent's usage through `agent_status` or check-in content. Plan
against the preferences' planning context budget when one exists; otherwise
reset well before the model's window.

1. Write the handoff: purpose and current arrangement, carried operator
   words, standing rules, verified state, owned agents with exact result
   references, unread inputs, next actions. `assets/handoff.md` lists these
   fields.
2. Reset with `agent_reset` and the handoff. History, identity, files,
   settings, and timers stay; no model turn starts.
3. Send the next task.

Use `agent_compact` instead when the same context should continue in a
smaller form. Apply the same watch to your own context: checkpoint before
large intake and hand over through a stash before the wall.

## Exit

Before the final answer, resolve every agent you own:

- **Accept** a settled result after its evidence checks.
- **Redirect** work the frame changed.
- **Abort** work that is no longer needed. A background abort also stops
  reporters.

Leave standing agents idle with their expertise updated, not running. Do
not stop unrelated or standing work that belongs to other efforts. Then
update or clear the intent claim and conclude or close the threads you
integrate.
