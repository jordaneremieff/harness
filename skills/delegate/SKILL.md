---
name: delegate
description: >
  Work with other agents and choose how: do the work directly, take selective
  help, collaborate with peers, or coordinate a team, and revise that choice
  as the work develops. Use when the operator asks a session to delegate,
  collaborate, orchestrate, coordinate, lead, or manage agents, to act as main
  driver over a team, to have agents with their own context do work, to set
  up threads for agents, or to keep its own context clean on long-horizon
  research, planning, or implementation; also when a session must brief
  agents, choose presets, keep result references, supervise check-ins, recover
  from quota walls, or reset or hand over agents. Read it before the first
  dispatch of such work: the agent tool descriptions omit assignments,
  threads, preset choice, supervision, and close-out. Do not use for one
  evidence question (dig), orientation only (prime), Pi session audits
  (audit), harness surface changes (harness), or a small task the session can
  finish directly.
compatibility: Requires Pi with the harness agent extension (spawn, send, steer, status, inspect, collaborate, intent, profile, reset, work) and codemode. Points to sibling sources extensions/agent/README.md and skills/dig/SKILL.md. Uses the operator's presets and delegation preferences; no fixed model or provider roster.
---

# Delegate

Choose how agents work together for the outcome the operator wants, and revise
that choice as the work develops. Delegation serves the outcome. Context
preservation, parallel progress, expertise, and independent challenge are
reasons to involve other agents; none of them alone decides who does what.
This skill supplies methods, not enforced limits or a required topology.

The session that owes the operator the result owns its integration and
acceptance. That ownership is not a management-only role. The owner can read,
implement, test, and verify substantive work itself, hand parts to others, and
change the arrangement when evidence changes the problem.

Use the existing agent tools. Build no coordination machinery: no ledgers,
mailboxes, schedulers, journals, watcher scripts, or wait loops. Durable
progress lives in threads, stash handovers, agent profiles, and the retained
task routes the host already keeps.

## 1. Frame the work

Ground the work in the operator's words before you split it: the purpose and
use path, restrictions, acceptance, and the authority the words grant. Label
your own interpretations as yours. A frame in the conversation is enough until
other agents or a later session need to share it.

Gather what the next decision needs, not a fixed checklist:

- **Preferences:** the delegation preferences and presets in your context, and
  memory when a choice depends on earlier operator preferences.
- **Existing work:** untargeted `agent_status` and an `agent_collaborate`
  `action: "list"` when related efforts, standing agents, or an existing thread
  can affect the work. Reuse a standing `@handle` whose role covers a recurring
  concern. Do not control agents you did not create.
- **Provider state:** `agent_status` with `view: "fleet"` before a large or long
  dispatch, for recent provider failures.
- **Intent:** a claim through `agent_intent` when the work includes shared
  repository acts or overlaps other efforts.
- **Own context:** your context usage through `registry` before a long effort.

**Complete when:** you can state the purpose, authority, restrictions, and
acceptance that the work needs, and you know which existing agents, efforts,
and preferences apply.

## 2. Choose an arrangement

Choose by the task: its dependencies, uncertainty, size, the context it will
consume, the expertise it needs, and where independent judgment matters. Each
of these arrangements can fit, and work can move between them:

- **Direct:** do the work yourself when coordination costs more than it gives.
- **Selective assistance:** keep the main line of work and hand off a bounded
  part, such as broad reading, a parallel change, an experiment, or an
  independent check.
- **Peer collaboration:** work alongside capable agents that share the purpose
  and contribute to the direction as well as the content.
- **Dedicated coordination:** one session spends most of its effort on
  coordination when many parallel parts and a long horizon make that worth its
  cost. That session can be you or another agent.

No minimum or maximum agent count applies, and no topology needs a stated
justification. Revisit the arrangement when a result, a surprise, or a
contributor's proposal changes the problem.

These facts shape the choice:

- **No session waits for agent output.** Results, reports, and messages
  arrive as events, in an ordinary primary and in a native Durable session
  alike. Each session does its own part, ends its run when nothing remains for
  it, and integrates answers as they arrive. A native Durable session sees its
  own identity and request routes in its instructions. When one composed
  answer from an agent serves the work, that agent can do the main work itself
  and use helpers selectively. Delivery prescribes no staffing.
- **Recurring concern:** a standing agent with a handle and a role.
- **Independent check:** a fresh agent, from a different model family where the
  claim matters. Agreement between agents that share a briefing counts as one
  line of evidence.
- **Ownership:** give each contributor a coherent piece of work, such as one
  behaviour with its implementation, focused tests, and documentation. Edit
  boundaries protect concurrent work; they do not define the unit of thought.
  Give each path that changes concurrently one owner at a time. Name one
  accountable owner for composition and for shared acts such as sync,
  landing, activation, and push; that owner need not be a separate session.
- **Model choice:** choose each agent by preset from the operator's preferences.
  Name an exact model only when a direction requires it. At a quota wall,
  substitute in the configured order and retain the choice and reason.
  Follow the [wall procedure](references/supervision.md#quota-walls) for
  operator messages; read `references/controls.md` for spawn, handle, and
  placement rules.

**Complete when:** each part of the work has an owner, concurrent edits do not
overlap, and composition and shared acts have one accountable owner.

## 3. Brief contributors

A direct task message is the normal assignment. Give the contributor what it
needs to judge and deliver its part:

- the purpose and where the part fits;
- the outcome and how it will be accepted;
- relevant facts and source pointers, with their qualifications;
- carried operator decisions in the operator's words with their source, apart
  from your interpretations;
- real restrictions: reserved acts, other owners' paths, and shared state it
  must not change;
- the edits and acts it may use; and
- the end condition and the reply route.

Reuse context the contributor already has, such as a thread frame, a standing
agent's expertise, or an earlier task in the same session, instead of repeating
it. Pick the register by the work: invite a capable peer to judge, challenge
the framing, and decide with you; give precise steps where each step matters to
you. Leave contributors room to raise discoveries, propose a changed approach or
division of work, and exchange findings directly with relevant peers through
`agent_send` or a thread, within the authority they carry.

Name a skill the contributor must read only when its method matters to the
task, such as `delegate` for an agent that will coordinate others or `dig` for
an evidence question. When a contributor posts to threads or can receive
notices, ask it to make other tool calls first and put the complete
deliverable in its last message.

The templates in `assets/` and the checker in `scripts/contract.mts` are
optional aids for long, reused, or handed-over assignments and thread frames.
They are not a prerequisite for dispatch. Read `references/contracts.md` for
slots, registers, message shapes, and check-in intervals.

**Complete when:** each contributor has what it needs to judge its part, without
your full context and without restrictions it does not need.

## 4. Dispatch

Keep these dispatch facts with the task evidence:

- Each preset you used, its exact `provider/model`, and its thinking level.
  State `off` when creation has no configured thinking level. Do not infer
  settings from your own model.
- Recent provider failures or quota walls from `agent_status` with
  `view: "fleet"` when you read them. Sampled evidence has coverage limits;
  missing evidence is unknown, not a clean provider record.
- Each model the operator named and its resolution: a matching preset, an
  explicit override, or a refusal and its reason. With `enforceRoster: true`,
  creation refuses an explicit model that matches no preset or an operator
  exclusion. Do not weaken enforcement or silently substitute a model.

Use the current preferences and registry model facts to resolve names. If a
name remains ambiguous, hold only that dispatch and ask for the missing choice.
Check creation receipts against the selected settings and retain the
effective settings.

If you are an ordinary primary and a thread is useful, spawn an agent the work
needs anyway without a prompt, create the thread in its storage, then send its
task with the thread ID. A native Durable session creates the thread in its own
storage. Every other agent spawns with its task as the prompt.

Spawn one-off agents without a `handle`. A handle names a standing agent in a
catalogue that other efforts share: a common handle such as `fix-docs` can
resolve to another effort's agent, which keeps its own directory and context,
and a conflicting `cwd` refuses. Give a handle only to a standing agent for a
recurring concern, and make it specific to that concern. Use `name` for a
readable label.

Keep every returned result reference (`sessionId`, `submissionId`,
`requestId`). A creation receipt, report, thread post, or name is not a result
reference.

Results arrive without supervision turns; no check-in runs unless you ask for
one. Set `checkInMinutes` only for long work that needs a watchdog, and read
the check-in as a watchdog, not a result. Each check-in costs you a model turn.

Batch independent dispatches in one codemode call when that helps. Read
`references/codemode.md` for dispatch, thread, sweep, and digest recipes.

**Complete when:** every dispatched task has a retained result reference and
the evidence records its effective settings.

## 5. Share facts, decisions, and corrections

Use a thread when evolving shared facts, decisions, or coordination among
several agents need one retained place: one part's findings change another
part's question, several agents act on the same carried decision and its
corrections, or the operator wants to follow the exchange there. A shared
purpose alone does not require a thread. Independent parts with sufficient
briefs need none, and direct `agent_send` covers a single exchange. Read
`references/threads.md` for placement, frames, and posts.

Stay responsive to the operator. An operator correction changes the frame:
revise the thread frame when one exists, then steer each affected agent with
the correction and its source. Ask only for authority or a decision that
existing authority cannot supply.

### Operator status reports

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
the whole result.

**Complete when:** every affected agent works from the latest operator
direction, and operator status reports follow "Operator status reports".

## 6. Supervise without polling

Results, reports, and check-ins arrive as events. Do not hold a run open for
agent output. No call waits for a result; do not poll status, sleep, or repeat
inspections as a wait. After you send work:

- **Do the work that remains for you.** Do ready independent work before the
  run ends. When none remains, a native agent declares the open work with
  `agent_work` `continue`: the request, the exact result references, and a
  note. A task that stays blocked or deferred and depends on no producer
  takes an empty `results`: that records open work and withdraws nothing.
  The native agent then ends the run with a short state note: what is open,
  and what it does when each result arrives. A result, a report, or a message
  starts its next run. A record without a dependency gets no later run by
  itself; it stays open in the status until the native agent calls
  `agent_work` `complete`, which alone closes an item.
  In an ordinary session, when only delegated work remains, or after you
  handled an event that needs no operator message under "Operator status
  reports", call `agent_work` `continue` with a short note for the operator:
  what is open and what happens next.
  Make it the only call in the last tool batch and write no chat text.
  `continue` shows the note as one card in the transcript and ends the turn
  without a further model call. The operator reads the note, so "Operator
  status reports" governs its wording: plain words, each agent and each
  piece of work described by what it does, and no session, submission or
  request identifier. The result references of your open requests stay in
  the receipts of your spawn and send calls, and after a compaction a
  continuity note lists the requests that have no delivered result, so the
  note carries none. The note is not stored as session state. When the session works
  again, the card is history; a later turn that needs nothing from the
  operator ends with a new `continue`.
- **Stay reachable.** An input reaches a running agent at its next tool
  boundary, the end of its current round of tool calls. With parallel calls
  nothing is placed between two tool completions of one round. The reach of
  the operator and of every other agent is therefore one tool round of yours.
  Run a
  command that can take more than about two minutes as a background job
  (`bash` with `background`); its completion arrives as an event. Do not chain
  long foreground calls.
- **Read each input by its class.** A steer corrects the current work: apply
  it now. A followUp and operator input are new work: finish the current step,
  then do them in the same run. A report, a result, a check-in, and a thread
  notice are events: read them and continue. An answer names each request that
  it covers.
- **Keep a native state note apart from a result.** Open the note with words that say
  it is a state note and not the result. A native agent uses `agent_work`
  `complete` as the only act that completes declared work; it sends the final
  report to the reply recipient of the original request. A run that completes its request without
  declared work answers with the result itself.
- **Know where your input is.** The send receipt returns `placement`:
  `"placed"`, `"unplaced"` or `"withdrawn"`; `"withdrawn"` means the input
  is in neither the recipient's inbox nor its transcript.
  `agent_status` shows `unplaced: n` and
  `oldest: <age>` for the recipient. After 5 minutes unplaced, one notice with
  the recipient's current step goes to the sender of an explicit send and to
  the recipient's requester. Act on the step that it names; do not send the
  input again.
- **Read a native contributor's state note as open work, not completion.** Read the
  open work in `agent_status` with its `sessionId`, and act when the final
  report arrives.

At each check-in, read the bounded content and act: let work continue with a
reason, steer a concrete next act, or abort a hung tool. Verify that a steer
changed the work before you rely on it. Watch each long-lived agent's context
and reset it with a handoff before it overflows. Read
`references/supervision.md` for triage, stalls, quota walls, context resets,
and the displaced-answer pitfall.

**Complete when:** every check-in has a decision, no agent works on a stale
frame, and no run of yours stays open only for agent output.

## 7. Integrate and accept

Read the actual result and defining evidence, not only the summary. Complete,
repair, or extend work yourself when that serves the outcome, or return it to
its owner. Reuse applicable source reads and execution results after checking
their reach and validity for the composed candidate and execution conditions.
Use existing context and results; add a concise summary only when complex
claims, disputes, or handoffs need it.

Challenge the governing contracts, assertions, fixtures, mocks, omitted cases,
and evidence limits. Repeating the author's commands alone does not establish
independent review. Choose additional review or execution for the material
error it can expose, not for a second pass label or a different agent. Once
the demonstrated findings are resolved and their repairs verified, stop: a
reviewer's recommendation of another round is not a new requirement.

Give each finding its repository-required disposition. Verify the repaired
contract; select permanent regression protection for its future value against
lifecycle cost. Examine interactions not covered by existing evidence and check
those that affect acceptance. Do not automatically rerun all contributor checks.
A new contributor, reviewer, commit, or handoff alone is not a reason to repeat
a complete gate. Assign one final owner for the relevant candidate and execution
basis under the repository's completion policy; contributors' local passes do
not establish integration or release.

Land each finished change as soon as the repository's completion policy permits;
team coordination adds no steps to that policy; the directing session's review
of a contributor's result continues after landing through follow-up changes
unless repository policy makes it a landing condition.

**Complete when:** accepted claims have sufficient applicable evidence, material
interactions are resolved, and every finding has its required disposition.

## 8. Keep long work resumable

Context is finite for every long-running session, including yours. Checkpoint
before large intake. Before compaction or a session change, preserve the
context needed for continuity: purpose and current arrangement, carried
operator words, standing rules, verified state, owned agents with their exact
result references, unread inputs, and next actions. Use native compaction when
its checked summary suffices; use a stash for a fresh-session handover.
`assets/handoff.md` lists the same fields. Record
durable lessons for standing agents in their profiles with `agent_profile`.

**Complete when:** a fresh session can resume from the handover without
re-reading sources.

## 9. Close out

Before the final answer:

1. Resolve every live agent you own: accept its result, redirect changed work,
   or abort work that is no longer needed. Leave unrelated and standing work
   alone. If you are a native agent, close each open work item that you
   declared with `agent_work` `complete`.
2. Update or clear your intent claim.
3. Post a conclusion to each thread you integrate; close it when the work ends.
4. Restore any temporary configuration you changed.
5. Give the final answer under "Operator status reports", with its evidence,
   its limits, and each substitution made.

**Complete when:** no owned agent is unresolved, any intent claim is current,
and the operator has the result.

## References

- Read [controls](references/controls.md) when you choose which agent control
  fits a moment, or need its pitfall and README anchor.
- Read [threads](references/threads.md) when you place, frame, post to, revise,
  or close a thread.
- Read [contracts](references/contracts.md) when you use a template, pick the
  partner or mechanical register, shape a steer, report, or followUp, or set a
  check-in interval.
- Read [supervision](references/supervision.md) when a check-in, stall, quota
  wall, acknowledgement-like answer, context limit, or exit needs a decision.
- Read [surface](references/surface.md) when you name a harness extension,
  skill, or prompt in an assignment.
- Read [codemode](references/codemode.md) when you batch dispatches, host a
  thread in a new agent, sweep owned agents, or digest a thread.

The agent extension owns runtime behaviour. Check claims against
`extensions/agent/README.md` and the live tool definitions; the tool's own
answer wins over this skill.
