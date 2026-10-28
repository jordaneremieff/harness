---
name: orchestrate
description: >
  Take and hold the orchestrator role: manage other agents so this session
  keeps its context for the operator, planning, judgment, and integration.
  Use when the operator asks a session to orchestrate, coordinate, lead, or
  manage agents, to act as main driver over a team, to have agents with their
  own context do the work, to set up threads for agents, or to keep its own
  context clean on long-horizon research, planning, or implementation; also
  when a coordinating session must bootstrap workers, write task contracts,
  choose presets, supervise check-ins, recover from quota walls, or reset or
  hand over agents. Do not use for one evidence question (dig), orientation
  only (prime), Pi session audits (audit), harness surface changes (harness),
  or a small task the session can finish directly.
compatibility: Requires Pi with the harness agent extension (spawn, send, steer, await, status, inspect, collaborate, intent, profile, reset) and codemode. Points to sibling sources extensions/agent/README.md and skills/dig/SKILL.md. Uses the operator's presets and delegation preferences; no fixed model or provider roster.
---

# Orchestrate

Hold the orchestrator role for as long as the work lasts. This session keeps
the operator conversation, the frame, team selection, contracts, acceptance,
and integration. Agents with their own context do the reading, building,
testing, and reviewing. The role exists to protect this session's context:
mechanical work that fills it degrades the judgment the operator relies on
over a long horizon. Lower spend on premium models often follows, but it is
not the aim. This skill supplies a method, not enforced limits.

Work from a short, outcome-first request. Do not ask the operator for a
process. The bootstrap is a few tool calls, not a ritual.

## 0. The role

Keep what you need to judge. Hand off what you need only to do.

- **Keep:** the operator dialogue; the frame and its corrections; the choice
  of agents and presets; contracts; the defining excerpt behind a
  load-bearing claim; acceptance; integration; and shared acts that the
  frame reserves to the integrator, such as sync, promotion, push, and
  activation.
- **Hand off:** bulk reading, searches, history and log mining, web research,
  implementation, mechanical edits, tests and gates, reviews, and trials.
- **Inline exception:** do a small, quick fix yourself when it costs less
  than the contract that would describe it. Do not let exceptions accumulate
  into the main work.

Use the existing agent tools. Build no coordination machinery: no ledgers,
mailboxes, schedulers, journals, watcher scripts, or wait loops. Durable
progress lives in the thread frame, stash handovers, agent profiles, and the
retained task routes the host already keeps.

Treat capable builders as partners: share the operator's words, the facts,
and the constraints, and invite judgment and disagreement. Give mechanical
workers precise contracts. Read `references/contracts.md` for the two
registers.

## 1. Bootstrap the role

Do these in one or two tool batches:

1. **Frame.** Copy the operator's words verbatim with their source. State the
   purpose and use path, restrictions, acceptance, and the authority the
   words grant. Label your own interpretations as yours.
2. **Preferences.** Read the delegation preferences and presets in your
   context. Search memory for delegation, roster, and model preferences.
   Read `agent_status` with `view: "fleet"` for recent provider failures.
3. **Existing work.** Read untargeted `agent_status` and list threads with
   `agent_collaborate` `action: "list"`. Reuse a standing `@handle` whose
   role covers a recurring concern. Do not control agents you did not
   create.
4. **Intent.** Publish your claim with `agent_intent`: purpose, integration
   plan, carried authority, and scope.
5. **Thread.** Create one when more than one agent shares the work. Read
   `references/threads.md` for placement and the frame.
6. **Own context.** Read your current context usage with `registry`.

**Complete when:** a one-paragraph frame exists that every contract can copy;
the roster for this work is resolved; intent is published; and a thread
exists, or you named why none is needed.

## 2. Shape the team

Pick the fewest agents that cover the independent work. Key the topology to
facts you can observe. Know which kind of session you are: a native Durable
session sees its own identity and request routes in its instructions; an
ordinary primary does not, and its `agent_await` refuses.

- **Ordinary primary (not Durable):** it cannot await results natively. If
  the work needs one composed answer from several agents, give the fan-out
  to one Durable lead that dispatches, awaits, and composes. Independent
  single tasks can still go direct; each answer arrives through normal
  delivery.
- **Native Durable session:** await exact result references yourself.
- **Recurring concern:** a standing agent with a handle and a role.
- **Long, judgment-heavy work:** a partner.
- **Independent check:** a fresh agent, from a different model family where
  the claim matters. Agreement between agents that share a briefing counts as
  one line of evidence.

Give each builder disjoint edit ownership and name one integrator. Choose
each agent by preset from the operator's preferences. Name an exact model
only when a direction requires it. At a quota wall, substitute in the
configured order and report the substitution. Read `references/controls.md`
for spawn, handle, and placement rules.

**Complete when:** each piece of work has one owner, a preset, and a stated
reason for its topology, and no two owners edit the same paths.

## 3. Write contracts

Start from the templates and check each contract before dispatch. The
script path is relative to this skill's directory. Keep filled contracts in
a scratch directory outside the skill and outside tracked paths.

```bash
node scripts/contract.mts template task
node scripts/contract.mts check <scratch>/task.md --kind task
```

Kinds: `task`, `lead`, `partner`, `review`, `frame`, `handoff`. The checker
reports missing, empty, or unfilled required slots; a missing end condition;
authority without quoted words and a source; frame fields over the thread
limits; instructions to sleep, wait a fixed time, or poll; and the contract
size, which is the cost you put on the worker.

Every deliverable contract says: post to threads and make other tool calls
first; the last message is the complete deliverable. A worker that answers a
passive notice after its deliverable can displace the answer.

Read `references/contracts.md` for slot meanings, registers, and message
shapes.

**Complete when:** each contract passes the checker, or you named why a
finding does not apply.

## 4. Dispatch

If you are an ordinary primary and the work needs a thread, spawn the agent
that will host it idle, create the thread in its storage, then send its task
with the thread ID. A native Durable orchestrator creates the thread in its
own storage first. Every other agent spawns with its task as the prompt.
Keep every returned result reference (`sessionId`, `submissionId`,
`requestId`). A creation receipt, report,
thread post, or name is not a result reference.

Choose `checkInMinutes` per task: keep the default for long work you must
supervise; use 0 for short or informational tasks. Each check-in costs you a
model turn.

Dispatch a wave in one codemode call. Read `references/codemode.md` for the
bootstrap and parallel-dispatch recipes.

**Complete when:** every dispatched task has a retained result reference, and
the operator knows what started, in one short notice.

## 5. Run the thread and the operator conversation

Stay responsive to the operator throughout. An operator correction changes
the frame: revise the thread frame, then steer each affected agent with the
correction and its source. Send the operator an interim notice only for a
real wait, a blocker that needs their decision, or a finding that changes
the work. Ask only for authority or a decision that existing authority cannot
supply.

Read new thread events through the digest recipe in `references/codemode.md`
instead of full re-reads. Name `notify` recipients only when their attention
matters now.

**Complete when:** the frame matches the latest operator direction, and every
affected agent received the change.

## 6. Supervise without polling

Results and check-ins arrive automatically. Do not poll status, sleep, or
repeat inspections as a wait. Do independent work while agents run.

At each check-in, read the bounded content and act: let work continue with a
reason, steer a concrete next act, or abort a hung tool. Verify that a steer
changed the work before you rely on it. Watch each long-lived agent's
context and reset it with a handoff before it overflows. Read
`references/supervision.md` for triage, stalls, quota walls, context resets,
and the displaced-answer pitfall.

**Complete when:** every check-in has a recorded decision, and no agent
works on a stale frame.

## 7. Integrate and accept

Read the real change, not only the summary: the diff, the commit, the test
output, or the cited source. Verify each load-bearing claim through its
pointer, or through an independent delegated check. Give every finding one
disposition: fixed now, shown false with cited evidence, or blocked at a
named layer. Repair the failed part through its owner instead of re-running
the whole mission. Run integration checks on the combined result.

**Complete when:** every accepted result has verified evidence, and every
finding has a disposition.

## 8. Keep the role durable

Your context is the scarce resource of a long role. Checkpoint before large
intake. Before compaction or a session change, write a stash handover from
the `handoff` template: role, carried operator words, team rules, verified
state, owned agents with their exact result references, unread inputs, and
next actions. Record durable lessons for standing agents in their profiles
with `agent_profile`.

**Complete when:** a fresh session can resume from the handover without
re-reading sources.

## 9. Close out

Before the final answer:

1. Resolve every live agent you own: accept its result, redirect changed
   work, or abort work that is no longer needed. Leave unrelated and
   standing work alone.
2. Update or clear your intent claim.
3. Post a conclusion to each thread you integrate; close it when the work
   ends.
4. Restore any temporary configuration you changed.
5. Report the result first, then evidence, limits, and substitutions made.

**Complete when:** no owned agent is unresolved, the intent claim is current,
and the operator has the result.

## References

- Read [controls](references/controls.md) when you choose which agent
  control fits a moment, or need its pitfall and README anchor.
- Read [threads](references/threads.md) when you place, frame, post to,
  revise, or close a thread.
- Read [contracts](references/contracts.md) when you fill a slot, pick the
  partner or mechanical register, shape a steer, report, or followUp, or set
  a check-in interval.
- Read [supervision](references/supervision.md) when a check-in, stall,
  quota wall, acknowledgement-like answer, context limit, or exit needs a
  decision.
- Read [surface](references/surface.md) when you name a harness extension,
  skill, or prompt in a contract.
- Read [codemode](references/codemode.md) when you bootstrap a team,
  dispatch a wave, sweep the fleet, or digest a thread.

The agent extension owns runtime behaviour. Check claims against
`extensions/agent/README.md` and the live tool definitions; the tool's own
answer wins over this skill.
