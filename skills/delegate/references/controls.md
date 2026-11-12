# Agent controls for collaboration moments

Each row gives the moment, the control, the decision, and the pitfall. The
anchor is a heading in `extensions/agent/README.md`; read it when the
decision depends on detail. The live tool definitions and the tool's own
answers win over this table. For messages to the operator, follow
[Operator status reports](../SKILL.md#operator-status-reports).

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
| New work for a busy Durable agent | `agent_send` `mode: "followUp"` | Placed at the agent's next tool boundary as new work for the same run | It may share one answer with the current work; the answer names each request it covers | `#controls` |
| Notice to another agent | `agent_send` `mode: "report"` | Placed at the owner's next tool boundary as an event; no answer route and no check-in | A report does not complete a native agent's declared work; that agent uses `agent_work` `complete` | `#recovery-and-delivery` |
| Know where a sent input is | the send receipt, then `agent_status` with `sessionId` | The receipt returns `placement`: `"placed"`, `"unplaced"` or `"withdrawn"`; `"withdrawn"` means the input is in neither the recipient's inbox nor its transcript; status shows `unplaced: n` and `oldest: <age>` | One notice arrives after 5 minutes unplaced, with the recipient's current step; do not send the input again | `#controls` |
| Input at a time | `agent_send` with `deliverAt` | Durable timer; cancel with `agent_abort` `timerId` | Not a wait loop; the storage host must run at the deadline | `#controls` |

## Receive results

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| Work is sent and other work remains for you | none | Do your own part, ready independent work included, before the run ends; each result, report, or message arrives as an event | No call waits for a result; do not poll status or inspect in a loop | `#recovery-and-delivery` |
| A native agent sent work and has none left | `agent_work` `continue`, then a state note | Declare the request, the exact result references (at most 16), and a note; end the run with a short state note; an arriving result starts your next run | The declaration is not the answer; do not hold the run open for agent output | `#recovery-and-delivery` |
| A native agent's routed task stays blocked or deferred and depends on no producer | `agent_work` `continue` with an empty `results` | Records open work without a dependency; it stays in the status until `complete` | No later run starts by itself for it; an empty `results` withdraws nothing | `#recovery-and-delivery` |
| A native agent's declared work is done or failed | `agent_work` `complete` with `status` and `message` | Sends the final report to the reply recipient of the original request | It is the only act that completes declared work; arrived results and a settled input do not | `#recovery-and-delivery` |
| An ordinary session has only delegated work left | a short state note, then end the turn | Results arrive as events at its next tool boundary or start its next turn | It has no `agent_work` tool and never polls | `#recovery-and-delivery` |
| A command can take more than about two minutes | a background job (`bash` with `background`) | Its completion arrives as an event; an input reaches you at the end of your current tool round, and nothing is placed between two parallel calls of one round | A chain of long foreground calls keeps every sender out for its whole length | `#controls` |
| A native contributor ends a run with a state note | `agent_status` with `sessionId` | The note means open work, not completion; read each open item and its dependencies there | Do not poll; the final report arrives when the contributor completes the work | `#controls` |
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
| Choose a substitute | the preferences' substitution order | Substitute deliberately and retain the choice and reason | Name or thinking changes do not clear a provider block | `#exhausted-provider-limits` |

## Discovery and close-out

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| What runs now | `agent_status` without target | An ordinary primary sees efforts and claims; inside an agent it returns compact rows for the conversations of its storage | The compact native read omits host inventory, effort awareness, and created-agent detail; keep the identities and result references that dispatch returned | `#agent-collaboration-and-placement` |
| One agent's state | `agent_status` with `sessionId` | Busy state, current tools, open submissions, pending timers | Settled failures appear in `agent_inspect` results, not here | `#controls` |
| Recent provider failures | `agent_status` `view: "fleet"` | Sampled machine-local evidence | Partial lower bounds; missing evidence is unknown, not zero | `#controls` |
| Find stored agents | `agent_list` | Paged catalog with query | Repeat the same query with the cursor | `#controls` |
| Declare the effort | `agent_intent` | Publish where a real dependency needs coordination; clear on release | A claim is not a lock; a finished plan must not stay declared | `#efforts-presence-and-intent` |
