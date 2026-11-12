# Agent controls for collaboration moments

Each row gives the moment, the control, the decision, and the pitfall. The
anchor is a heading in `extensions/agent/README.md`; read it when the
decision depends on detail. The live tool definitions and the tool's own
answers win over this table.

## Contents

- Start and shape the work
- Dispatch and deliver
- Receive results
- Supervise and correct
- Context and continuity
- Provider limits
- Discovery and close-out

## Start and shape the work

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| A recurring concern needs a standing owner | `agent_spawn` with `handle` (slug without `@`), `role` | Resolve or create one standing root; address it later as `@slug` | Other efforts share the handle catalogue, so a common handle can resolve to their agent; reuse never reapplies creation defaults; supplied model, thinking and role come back unapplied, a name is ignored, a conflicting cwd refuses | `#standing-agents-and-expertise` |
| One-off agent | `agent_spawn` without `handle`, with `name` for a label | Same cwd places a conversation in the caller's storage; a different cwd creates a new storage host | An explicit `role` is saved on the new agent's profile without a handle; later changes use `agent_profile` | `#agent-collaboration-and-placement` |
| Pick the model | `preset` on spawn or place | Omit model and preset for the configured default; name an exact model only when a direction requires it | Creation never inherits the creator's model or thinking; absent thinking defaults to off | `#execution-presets-and-delegation-preferences` |
| Change an idle agent's model | `agent_configure` | Idle only; explicit argument, then preset, then retained values | A busy refusal names the target; repeat after its run ends | `#selection-and-unapplied-fields` |
| Work bound to a directory | `agent_place` | Resolves the longest directory binding or creates one | A reused owner keeps its own model; supplied fields are reported unapplied | `#controls` |
| Check a standing agent before reuse | `agent_profile` `action: "read"` | Read role and expertise first; expertise is evidence, not authority | Updates need `expectedRevision` from a current read | `#standing-agents-and-expertise` |

## Dispatch and deliver

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| Give an agent a task | `agent_spawn` with prompt, or `agent_send` | Answer-bearing calls return `result: { sessionId, submissionId, requestId? }`; keep it | Admission is not settlement; a receipt is not acceptance | `#controls` |
| Spawn to host a thread | `agent_spawn` without prompt | Creation-only spawn returns no result reference; send the task after the thread exists | Do not spawn an agent only to hold a thread | `#peer-threads` |
| New work for a busy Durable agent | `agent_send` `mode: "followUp"` | Placed at the agent's next tool boundary; it joins the current work | It may share one answer with the current work | `#controls` |
| Interim notice to an owner | `agent_send` `mode: "report"` | No answer route and no check-in | An interim notice is not the final result; its first line says which it is | `#recovery-and-delivery` |
| Final result after a state note | `agent_send` `mode: "report"` to the request's reply recipient | The first line says that it is the final result and names the request | A state note is not a result | `#recovery-and-delivery` |
| Input at a time | `agent_send` with `deliverAt` | Durable timer; cancel with `agent_abort` `timerId` | Not a wait loop; the storage host must run at the deadline | `#controls` |

## Receive results

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| Work is sent and other work remains for you | none | Do your own part; each result, report, or message arrives as an event | No call waits for a result; do not poll status or inspect in a loop | `#recovery-and-delivery` |
| Work is sent and nothing remains for you | none | End the run with a short state note: the open result references, and what you do when each arrives; an arriving result starts your next run | Do not hold the run open for agent output | `#recovery-and-delivery` |
| A command can take more than about two minutes | a background job (`bash` with `background`) | Its completion arrives as an event; an input reaches you at your next tool boundary | A chain of long foreground calls keeps every sender out for its whole length | `#controls` |
| A contributor ends a run with a state note | `agent_status` with `sessionId` | The note means open work, not completion; read the open work there | Do not poll; the final result arrives as a report | `#controls` |
| A long answer is cut | `agent_inspect` `view: "result"` with the `submissionId` | Read the complete answer from the retained result | A truncated answer is not a failed one | `#live-conversation-and-history` |

## Supervise and correct

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| A check-in arrives | read its content | Let work continue, steer a wrap-up or next act, or abort a hung tool | A check-in is not a result; each costs an owner model turn | `#controls` |
| Change busy work | `agent_steer` or `agent_send` `mode: "steer"` | Reaches the agent at its next tool boundary | Steer never interrupts a running tool | `#controls` |
| Stop work | `agent_abort` | Stops current work; retained evidence stays | An ordinary abort does not reach background agents; `background: true` does | `#agent-collaboration-and-placement` |
| Read what an agent did | `agent_inspect` | `activity`, `history`, `search`, `result` by submission, `exact` for full entries | Ordinary primaries expose only bounded latest-retained ancestry | `#live-conversation-and-history` |
| The operator wants to watch an agent or talk to it in their own terminal | the standalone terminal in a pane: `rex run --label "agent @slug" -c <package root> -- node extensions/agent/terminal.ts --session @slug`, through the Rex tools or CLI | The pane shows the agent's live console; text typed there is admitted like any other input; the agent keeps running when the pane closes | A console inside the primary's dashboard is not a pane the operator asked to see; the entry resolves the managed Pi install itself, so pass no environment variable | `#standalone-terminal-attachment` |
| A mistaken decision | `agent_rewind` | Forks before the entry and submits the correction | Files remain current; repair them separately | `#controls` |
| Side exploration | `agent_fork` | Idle fork with its own identity and an empty profile | A fork inherits no intent claim | `#controls` |

## Context and continuity

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| A long-lived agent nears its budget | `agent_reset` with `handoff` | Fresh context; history, identity, files, settings and timers stay; no model turn starts | Cover the fields that the `handoff` template lists | `#controls` |
| A continuing context grows | `agent_compact` | Shrinks context without stopping work or queued inputs | The summary applies at the next native boundary | `#controls` |
| Save lessons for a standing agent | `agent_profile` `action: "update"` | Bounded sourced expertise that survives reset and compaction | Forks start with an empty profile | `#standing-agents-and-expertise` |

## Provider limits

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| An agent settles unanswered with `model_error` | `agent_inspect` `view: "result"` | Read the provider error text, abort if still active, configure an explicit model on the idle agent, send a continuation, keep its new reference | The host never substitutes a model; a retry notice does not prove exhaustion | `#exhausted-provider-limits` |
| Choose a substitute | the preferences' substitution order | Substitute deliberately and report it | Name or thinking changes do not clear a provider block | `#exhausted-provider-limits` |

## Discovery and close-out

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| What runs now | `agent_status` without target | An ordinary primary sees efforts and claims; inside an agent it returns compact rows for the conversations of its storage | The compact native read omits host inventory, effort awareness, and created-agent detail; keep the identities and result references that dispatch returned | `#agent-collaboration-and-placement` |
| One agent's state | `agent_status` with `sessionId` | Busy state, current tools, open submissions, pending timers | Settled failures appear in `agent_inspect` results, not here | `#controls` |
| Recent provider failures | `agent_status` `view: "fleet"` | Sampled machine-local evidence | Partial lower bounds; missing evidence is unknown, not zero | `#controls` |
| Find stored agents | `agent_list` | Paged catalog with query | Repeat the same query with the cursor | `#controls` |
| Declare the effort | `agent_intent` | Publish where a real dependency needs coordination; clear on release | A claim is not a lock; a finished plan must not stay declared | `#efforts-presence-and-intent` |
