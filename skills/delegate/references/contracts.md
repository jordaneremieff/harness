# Assignments and messages

A direct task message is the normal assignment. It gives the contributor what
it needs to judge and deliver its part; `SKILL.md` section 3 lists that
content. The templates in `assets/` give the same content a fixed structure
for long, reused, or handed-over assignments and thread frames. Print one with
`node scripts/contract.mts template <kind>` (paths relative to this skill's
directory). When a structural check helps, check the filled copy with
`check <file> --kind <kind>`. Neither step is a prerequisite for dispatch.

## Contents

- Kinds
- Slot meanings
- Partner and mechanical registers
- Message shapes
- Check-in intervals

## Kinds

| Kind | Use for |
|---|---|
| `task` | One outcome with one owner; the outcome can span implementation, tests, and documentation |
| `lead` | An agent that owns one composed result and does the work itself or with helpers as it judges |
| `partner` | A capable peer invited to judge and disagree |
| `review` | An independent check of a named claim |
| `frame` | Thread frame fields for `create` or `revise`, without an action |
| `handoff` | An `agent_reset` handoff or stash handover |

## Slot meanings

- **Purpose:** why the work exists and where it fits; lets the contributor judge
  tradeoffs you did not foresee.
- **Objective:** one observable end state, not an activity.
- **Operator authority:** the operator's words verbatim in quotes, with the
  source. Agent interpretations go elsewhere, labelled as such.
- **Restrictions and exclusions:** what the contributor must not do, including
  reserved acts and other owners' paths.
- **Permitted edits and acts:** the paths, branches, and acts. Scope a coherent
  piece of work rather than a file count, and keep it disjoint from concurrent
  edits by other owners.
- **Starting sources:** files, threads, or notes to read first, each with why
  it matters. Point to sources; do not paste them.
- **Dependencies and other owners:** work in flight that this task touches or
  must not touch, its owner, and the peers the contributor can contact directly
  about shared findings or a proposed change of ownership.
- **Acceptance evidence:** the checks or outputs that establish the objective.
- **Output format and length:** sections and a length bound for the final
  answer. Large output goes to a file, cited by path.
- **End condition:** when to stop and how to report a blocker. Add: make other
  tool calls and thread posts first; the last message is the complete
  deliverable.
- **Reply route:** the exact identity that receives the answer.
- **Skills to load:** the skills the agent reads before work, each with its
  reason. Name one only when its method matters: `delegate` for an agent that
  will coordinate others, `dig` for an evidence question. Agents often skip a
  skill that the tool descriptions seem to cover, so name it when it matters.
- **Thread ID:** an existing thread to join when it serves this assignment;
  otherwise omit this slot. Keep
  `participation` on create/join within 256 characters and `post.message` within
  8,000 characters. Join does not accept a discussion message.
  Write longer content to a file and post its path.
- **Provider or budget notes:** known walls, the substitution order, and what to
  do at a wall (stop and report the exact error text).
- **Lead-only slots:** division of work (the parts you can see and any
  suggested helpers; the lead can do the work itself, revise the split, or use
  helpers selectively), result references (keep exact references for delegated
  parts; a native lead declares the open ones with `agent_work` `continue`,
  while an ordinary lead ends its turn with a short state note; neither holds
  a run open for results), and composed answer (one answer for the whole
  result, gaps named; a native lead ends declared work with `agent_work`
  `complete`).
- **Review-only slots:** the claim under review, the evidence each verdict must
  reach, and independence. Challenge contracts, omitted cases and evidence from
  defining sources rather than adopt the author's conclusion. Repeating the
  author's commands alone does not establish independent review.

The checker's size line shows what a long assignment costs the contributor's
context before it starts.

## Partner and mechanical registers

- **Mechanical:** precise steps, exact paths, exact checks, a fixed output
  shape. Leave no design choice open that you care about.
- **Partner:** share purpose, facts, and constraints; state the decision or
  question; invite disagreement with the framing and the division of work. Do
  not prescribe steps. Decide together, and record a decision that others must
  see where they will see it.

Pick the register by the work, not by the model: a strong model on a mechanical
task still gets precise steps. A contributor in either register can raise a
discovery that changes the plan.

## Message shapes

| Purpose | Mode | Shape |
|---|---|---|
| Correction to busy work | `steer` | The change, its source, the affected step, and what to do with work already done |
| Next act at a check-in | `steer` | One concrete act, its completion condition, and the end condition if it changed |
| New task to a reused agent | `followUp` | A sufficient task message; a busy agent gets it at its next tool boundary and may cover it in one answer with its current work |
| Notice without an answer | `report` | The fact, its source, and whether any action is expected |
| Operator decision relay | `steer` or thread post with `kind: "carried-authority"` | The verbatim words, source, and scope |

The receiver reads each input by its class. A `steer` corrects the current
work: apply it now. A `followUp` and operator input are new work: finish the
current step, then do them in the same run. A `report`, a result, a check-in,
and a thread notice are events: read them and continue. Send a busy agent a
`steer` only when it must change its current work.

A terminal answer from a contributor carries the result or the exact blocker.
One case differs: a run that ends while work the contributor sent is open.
The contributor does its ready independent work first. A native contributor
then declares the open work with `agent_work` `continue` and ends the run
with a state note. An empty `results` is valid: it records a blocked or
deferred task that depends on no producer, and no later run starts by itself
for it. An ordinary contributor ends its turn with a short state note
instead; results arrive as events at its next tool boundary or start its
next turn, and it never polls. Both notes say first that they are state notes
and not results; they name the open work and what the contributor does when
each result arrives. A native contributor uses `agent_work` `complete`, with
`status` `done` or `failed` and the result or exact blocker as `message`, to
send the final report to the reply recipient of the original request.

## Check-in intervals

A task arms owner check-ins only when `checkInMinutes` or the
`agent.checkInMinutes` setting names an interval; the default is none, and the
result still arrives through normal delivery. Each check-in costs the owner a
model turn.

- **Leave it unset** for short tasks, informational steers, reports, and any
  work whose result is the only event you need.
- **Set an interval** for long work you must steer midway, or work where a
  silent stall would cost more than the watchdog turns.

A state note from the contributor does not end the task for the owner: the
work is open until the final report arrives. Read the open work in
`agent_status`; do not poll.
