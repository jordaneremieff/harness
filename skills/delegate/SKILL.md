---
name: delegate
description: >
  Set and keep how this session divides work with agents: orchestrator,
  architect or maker mode. Use when the operator asks this session to
  orchestrate, delegate, run agents, save its budget or context, stay on the
  design, or work hands-on (for example `/skill:delegate orchestrator`); while
  a mode is set, before you read, edit or run work yourself, to check that the
  mode gives you that work; after compaction or resume, to recover the mode
  and open hand-offs before you act; and to brief, supervise, accept or report
  on delegated work. Do not use for agent tool arguments, delivery or recovery
  rules, which the tool definitions and the Agent extension own.
compatibility: >
  Pi-specific. Uses the Agent extension's tools (agent_brief, agent_spawn,
  agent_send, agent_status, agent_yield, agent_profile, agent_compact), the
  history extension's history_search, and a worker tool when the session
  offers one.
  Package-root references: `extensions/agent/README.md` for tool contracts and
  `extensions/agent/codemode.md` for codemode recipes.
---

# Delegate

This skill sets which work a session does itself and which work it gives to
other agents, keeps that division in force for the whole session, and gives
the method for handing work off and taking results back. The tool definitions
and `extensions/agent/README.md` own arguments, delivery and recovery.

## Set the mode

A delegation mode states which work this session does itself and which work
it gives to agents. The operator sets the mode of a session; the creator of a
durable agent sets that agent's mode within the operator's direction. The
model, provider or budget of a session never selects a mode.

1. Read the mode from the operator's words for this session, including the
   text after `/skill:delegate`. A durable agent reads its mode from its role
   and its brief.
2. Match the words to a mode:

   | The operator says, for example | Mode | What the mode protects |
   | --- | --- | --- |
   | "orchestrate", "delegate everything", "save your budget", "don't spend premium tokens on mechanical work" | orchestrator | This session's turns and context, the most expensive resource in the work. |
   | "architect", "keep your context clean", "stay on the design" | architect | This session's context, kept clear for design and the decisive checks. Cost is not the limit. |
   | "maker", "hands-on", "do it yourself and use agents for side work" | maker | The main work, done in this session. |

   If the words name budget or cost, choose orchestrator. If they name only a
   clean context, choose architect. Words that match no mode are instructions
   for the work: apply them and keep the current mode.
3. State the mode once, in one line that starts with `Delegation mode:`. For
   example: `Delegation mode: orchestrator. Agents do the reading, building and
   checks; I frame, brief, decide, integrate and accept.` The line shows the
   operator how you read the words, so a wrong reading gets corrected at once,
   and it gives compaction and history search a fixed text. If the work keeps
   a plan or result document, put the same line at its top.
4. An instruction changes the mode only as far as it changes who does the
   work. "Run the tests yourself" gives you those test runs for that task; the
   rest of the mode stays. When the task ends, the session mode applies again.
5. With no mode, choose the division per task. You may do substantive work
   yourself. Delegate where independent progress, expertise, a clean context
   or an independent challenge pays for the brief.
6. When you create a durable agent that will coordinate other agents, put its
   mode line in its `role`. A durable agent's role is part of its instructions
   on every turn and survives compaction, reset and host restart. When the
   operator gives a durable agent a standing mode, the agent adds the mode line
   to its own role with `agent_profile` and keeps the rest of the role. It
   never saves an instruction for one task in its role.

## What each mode gives away

"You" is this session. "Agent" is a durable agent or a worker run; see
[Choose the route](#choose-the-route).

| Work | Orchestrator | Architect | Maker |
| --- | --- | --- | --- |
| Talk with the operator, decide, set acceptance | You | You | You |
| Search or survey files, history or the web | Agent | Agent | You, or an agent for a separable part |
| Read to understand code or material | Agent: ask for the constraints, interfaces and locations that decide your question | You: the interfaces, contracts and sources that decide the design; an agent for the rest | You |
| Edit the work product: code, tests, documents, configuration | Agent | Agent; you write design notes and interface sketches | You |
| Run builds, tests, checks, trials and experiments | Agent | Agent; you run the one check that decides a design question | You |
| Read long logs, transcripts or raw output | Agent | Agent | You |
| Find the cause of a failure | Agent | Agent, unless the cause decides the design | You |
| Review and independent challenge | Agent | Agent | Agent |
| Integrate: merge, commit, activate, publish | You; the branch owner resolves a conflict | You | You |
| Accept: read the evidence that decides acceptance | You | You | You |

Under orchestrator, you make only these tool calls:

- agent, worker and coordination calls, and memory, Pillars and registry reads
  for decisions about the operator's preferences and principles;
- reads of an agent's result or report, a cited passage, a diff hunk or a
  check result, each to answer a named question for a brief or for acceptance;
- short commands that show state, such as `git status`, `git log -3` or
  `git diff --stat`;
- integration commands: merge, commit, activate, push;
- briefs, and reports to the operator from accepted evidence.

If you need to search for evidence, read to understand, diagnose a failure,
run a missing check or write any part of the requested work product, give that
work to an agent.

Under architect, you also read the interfaces, contracts and sources that
decide the design, write design notes and interface sketches, and run the one
check that decides a design question. Searches, implementation, long runs and
experiments go to agents.

Under maker, you do the main work. Give agents the independent review of your
result, parallel parts that do not touch your work, and side tasks that would
interrupt the main line.

## Keep the mode for the whole session

Drift starts with one reasonable exception and grows by repetition. Each own
read or fix looks cheaper than a brief, and after a few of them the session
works as a maker without a decision. Hold the mode with two checks:

1. Before each tool call that reads, edits or runs material of the work, ask:
   does my mode give this work to me? If not, write the brief instead of
   making the call.
2. At each of these moments, look at your own calls since the previous moment:
   - an operator message arrives;
   - an agent result, report or check-in arrives;
   - you start a new piece of work;
   - you are about to reply to the operator.

   If you did work that the mode gives to agents, stop and brief the rest of
   that work, with what you found, to an agent. Do not finish work yourself
   because you started it.

| Thought | Answer |
| --- | --- |
| "It is faster if I do it." | In this mode your turns and context cost more than an agent's time. Hand it off and do coordinator work meanwhile. |
| "It is only a small fix." | Small fixes are how drift starts. Send it to the agent that owns the area, or brief a new one. |
| "The agent got it wrong, so I will correct it." | Return the finding through that agent's route (see [Accept and integrate](#accept-and-integrate)) and check its repair. |
| "I must understand the code before I can brief it." | Ask an agent for the understanding: the constraints, interfaces and locations that decide your question. |
| "Everything waits for this step." | Hand it off now, then brief the next part or review a result while it runs. |
| "I am already deep into it." | Stop at the next call. Brief what remains and what you found. |
| "The operator wants this fast." | Only the operator changes the mode. Keep it until the operator says otherwise. |

## After compaction or resume

Before the next act:

1. Find the mode. Look in the summary's constraints, in a durable agent's
   role, and at the top of the plan or result document. If none of them shows
   it, search the session history for `Delegation mode:` and for the
   operator's latest instruction about dividing the work (`history_search`).
   If the summary did not show the mode, put the mode line in your next
   message to the operator so that the next summary keeps it.
2. Find the open hand-offs. After compaction, a continuity note lists each
   request that has no delivered result; `agent_status` shows your agents and
   their states; a handover lists the rest. Do not assign work again that an
   open hand-off already covers.
3. If this skill's text is not in your context, read it again.

When you compact yourself with `agent_compact` or write a handover, include the
mode line, each open hand-off with its result reference, and the next act. The
operator can restate the mode at any time with `/skill:delegate <mode>`.

## Choose the route

Follow the routing instructions and delegation preferences in your context.
They name the presets, the models to avoid and the budget facts of this
machine.

- **Worker tool**, when your context offers one: bounded development work
  with named sources, the exact files it may change, checks and a checkable
  end condition. Keep decisions that depend on this conversation, and work
  that needs your access, out of it.
- **Durable agent** (`agent_brief`, or `agent_spawn` with a short prompt):
  work that needs judgment, a full session's tools, a long run or later
  corrections. Choose the preset for the work. Reuse an existing `@handle`
  expert when its expertise fits. Use a new agent for unrelated work,
  independent review or conflicting ownership.
- **Same agent** (`agent_brief` with its `sessionId` for a new task,
  `agent_send` for a short follow-up or a correction): repairs and further
  work in an area that agent owns.
- **Parallel agents**: only independent parts, each with its own files,
  branch or worktree. Two agents never edit one area.
- **You**: only what the mode keeps.

To group calls or keep exact result references in a codemode script, use the
recipes in `extensions/agent/codemode.md`.

## Brief the work

The agent sees only the brief, not this conversation. Brief a task with
`agent_brief`: it takes the brief as fields, checks them, renders one standard
brief, and creates or reaches the agent in the same call. A short follow-up, a
report or a correction stays an `agent_send` or `agent_steer` message. Fill
the fields:

1. `objective`: one bounded outcome.
2. `purpose`: why the work matters and which decision the result feeds.
3. `sources`: exact paths, commits, URLs, and what each one establishes.
   Point to files instead of pasting long material; what you paste also stays
   in your own context.
4. `operator`: each operator decision you carry, quoted, with its source and
   scope. Your own proposals and interpretations go in the other fields.
5. `permitted` and `restrictions`: what the agent may change, what it must not
   touch (such as another session's uncommitted work), and acts it must not do
   (such as push, delete or activate).
6. `checks`: the commands that establish the result, with time limits.
7. `endCondition`: the observable state that ends the task.
8. `result`: what the final message contains.

Set `kind` when the work is not a bounded task: `lead` for ownership of a
composed outcome, `review` for an independent judgment, `partner` for a shared
inquiry, `handoff` to continue existing work. In codemode, keep the fields
that several briefs share in one object and spread it into each call.

Shape the requested result by the mode:

- orchestrator: the outcome, failures and exceptions, what was verified and
  how, and where the evidence is. Keep it short.
- architect: the options, the evidence with its sources, disagreements and
  open risks, and a recommendation.
- maker: the actionable detail for the part that you integrate.

Before you send a brief, test it: could the agent judge its own result with
only this brief? If not, add the missing criterion, dependency or source. A
thread frame needs no brief: `agent_collaborate` create takes its purpose,
authority, source, restrictions, acceptance and integrator as fields.

## Supervise without polling

Keep the exact result reference of each dispatch that owes an answer. While
agents run, do coordinator work: brief the next part, review an arrived result,
integrate. When only agent work remains, end the turn as the tool guidance says
(`agent_yield` in an ordinary session, declared background work in a durable
agent). Results arrive as events.

When a missing result changes the next act, inspect the exact request once and
tell apart a pending input, a provider retry, open declared work, a terminal
result and an unavailable source. Do not resend only because a result is not
visible yet; for an unreachable recipient, follow
`extensions/agent/README.md`, "Recovery and delivery". On a check-in, let the
work continue, steer it to a concrete act, or stop hung or superseded work. At a
quota wall, read the actual error, substitute deliberately for the affected
work only, keep its scope and evidence requirements, and report the
substitution once.

## Accept and integrate

The session that owes the outcome integrates it. Read the evidence that decides
acceptance: the actual change, the result lines of the checks, and the defining
source of each consequential claim. A summary or a settled run is not
acceptance. Reuse checks that still apply; check interactions that no check
covered.

Return each finding to the contributor that did the work, through its own
route: `agent_send` to a durable agent, or the continuation that a worker tool
offers for its earlier run. Then check the repair where the claim lives.
If nothing independent remains while the repair runs, end the turn; do not take
over the repair.

Before you end, resolve each live hand-off of this task: integrate its result,
keep an explicit continuation, redirect it, or stop superseded work. Do not
stop unrelated or standing agents to close the task. State the limits that
affect acceptance.

## Work together

Send facts that change another contributor's next decision while they still
matter, and let contributors challenge the method and exchange evidence
directly. Use a peer thread (`extensions/agent/README.md`, "Peer threads") when
shared facts, decisions or dependencies need one retained place. A post or an
admission receipt is not an agreement; when a correction matters to
acceptance, check that the affected work changed.

## Report to the operator

Before you report on delegated work to the operator, read
[reports.md](references/reports.md). It fixes the opening line, the order of
facts and when a message is due.
