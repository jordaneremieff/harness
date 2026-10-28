# Contracts and messages

A contract gives a worker everything it needs without the orchestrator's
context. Templates live in `assets/`; print one with
`node scripts/contract.mts template <kind>` (paths relative to this skill's
directory) and check
the filled copy with `check <file> --kind <kind>`.

## Contents

- Kinds
- Slot meanings
- Partner and mechanical registers
- Message shapes
- Check-in intervals

## Kinds

| Kind | Use for |
|---|---|
| `task` | One worker, one outcome |
| `lead` | A Durable lead that fans out, awaits exact results, and returns one composed answer |
| `partner` | A capable peer invited to judge and disagree |
| `review` | An independent check of a named claim |
| `frame` | Thread `create` fields |
| `handoff` | An `agent_reset` handoff or stash handover |

## Slot meanings

- **Purpose:** why the work exists and where it fits; lets the worker judge
  tradeoffs you did not foresee.
- **Objective:** one observable end state, not an activity.
- **Operator authority:** the operator's words verbatim in quotes, with the
  source. Agent interpretations go elsewhere, labelled as such.
- **Restrictions and exclusions:** what the worker must not do, including
  reserved acts and other owners' paths.
- **Permitted edits and acts:** exact paths, branches, and acts.
- **Starting sources:** files, threads, or notes to read first, each with why
  it matters. Point to sources; do not paste them.
- **Dependencies and other owners:** work in flight that this task touches
  or must not touch, and its owner.
- **Acceptance evidence:** the checks or outputs that prove the objective.
- **Output format and length:** sections and a length bound for the final
  answer. Large output goes to a file, cited by path.
- **End condition:** when to stop and how to report a blocker. Always add:
  post to threads and make other tool calls first; the last message is the
  complete deliverable.
- **Reply route:** the exact identity that receives the answer.
- **Thread ID:** the thread to join first, when work is shared.
- **Provider or budget notes:** known walls, the substitution order, and
  what to do at a wall (stop and report the exact error text).
- **Lead-only slots:** fan-out ownership (parts, presets, what the lead
  keeps), result references (keep exact references and await them natively),
  composed answer (one answer covering every result, gaps named).
- **Review-only slots:** the claim under review, the evidence each verdict
  must reach, and independence (verify from primary sources, not from the
  author's conclusion).

Run the checker on every contract. Read its size line: a long contract costs
the worker context before it starts.

## Partner and mechanical registers

- **Mechanical worker:** precise steps, exact paths, exact checks, a fixed
  output shape. Leave no design choice open that you care about.
- **Partner:** share purpose, facts, and constraints; state the decision or
  question; invite disagreement with the framing. Do not prescribe steps.
  Decide together, and record the decision in the thread.

Pick the register by the work, not by the model: a strong model on a
mechanical task still gets a precise contract.

## Message shapes

| Purpose | Mode | Shape |
|---|---|---|
| Correction to busy work | `steer` | The change, its source, the affected step, and what to do with work already done |
| Next act at a check-in | `steer` | One concrete act, its completion condition, and the end condition if it changed |
| New task to a reused agent | `followUp` | A full contract; on a busy Durable agent it waits for the current run and may share one answer |
| Notice without an answer | `report` | The fact, its source, and whether any action is expected |
| Operator decision relay | `steer` or thread post with `kind: "carried-authority"` | The verbatim words, source, and scope |

Every terminal answer from a worker carries the result or the exact blocker,
never a waiting note.

## Check-in intervals

Model-origin tasks arm automatic owner check-ins at the configured interval.
Each check-in costs the owner a model turn.

- **Keep the default** for long builds, leads, and anything you must steer.
- **Use 0** for short tasks, informational steers, and reports.
- **Set longer** for long, self-contained work you trust to run.

A lead waiting in `agent_await` reacts to input by origin. A report or
followUp from an ordinary primary releases the wait; the lead applies it and
awaits the unresolved references again. A report from a native agent that is
not an awaited producer stays queued until the wait ends. Send a lead input
during its wait only when it must act on it now.
