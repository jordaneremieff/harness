# Agent controls for orchestration moments

Each row gives the moment, the control, the decision, and the pitfall. The
anchor is a heading in `extensions/agent/README.md`; read it when the
decision depends on detail. The live tool definitions and the tool's own
answers win over this table.

## Contents

- Start and shape the team
- Dispatch and deliver
- Wait and receive
- Supervise and correct
- Context and continuity
- Provider limits
- Discovery and close-out

## Start and shape the team

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| A recurring concern needs a standing owner | `agent_spawn` with `handle` (slug without `@`), `role` | Resolve or create one standing root; address it later as `@slug` | Other efforts share the handle catalogue, so a common handle can resolve to their agent; reuse never reapplies creation defaults; supplied model, thinking and role come back unapplied, a name is ignored, a conflicting cwd refuses | `#standing-agents-and-expertise` |
| One-off worker | `agent_spawn` without `handle`, with `name` for a label | Same cwd places a conversation in the caller's storage; a different cwd creates a new storage host | `role` requires a handle; set another agent's role with `agent_profile` | `#agent-collaboration-and-placement` |
| Pick the model | `preset` on spawn or place | Omit model and preset for the configured default; name an exact model only when a direction requires it | Creation never inherits the creator's model or thinking; absent thinking defaults to off | `#execution-presets-and-delegation-preferences` |
| Change an idle agent's model | `agent_configure` | Idle only; explicit argument, then preset, then retained values | A busy refusal names the target; repeat after its run ends | `#selection-and-unapplied-fields` |
| Work bound to a directory | `agent_place` | Resolves the longest directory binding or creates one | A reused owner keeps its own model; supplied fields are reported unapplied | `#controls` |
| Check a standing agent before reuse | `agent_profile` `action: "read"` | Read role and expertise first; expertise is evidence, not authority | Updates need `expectedRevision` from a current read | `#standing-agents-and-expertise` |

## Dispatch and deliver

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| Give an agent a task | `agent_spawn` with prompt, or `agent_send` | Answer-bearing calls return `result: { sessionId, submissionId, requestId? }`; keep it | Admission is not settlement; a receipt is not acceptance | `#controls` |
| Spawn to host a thread | `agent_spawn` without prompt | Creation-only spawn returns no result reference; send the task after the thread exists | Do not spawn an agent only to hold a thread | `#peer-threads` |
| New work for a busy Durable agent | `agent_send` `mode: "followUp"` | Waits for the current run to end | It joins the current work and may share one answer | `#controls` |
| Interim notice to an owner | `agent_send` `mode: "report"` | No answer route and no check-in | Do not replace a terminal answer with a report | `#recovery-and-delivery` |
| Input at a time | `agent_send` with `deliverAt` | Durable timer; cancel with `agent_abort` `timerId` | Not a wait loop; the storage host must run at the deadline | `#controls` |

## Wait and receive

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| A native Durable session needs several results | `agent_await` with exact references | One call, at most 16 references; no provider calls while waiting | Ordinary primaries refuse this; route answer-bearing fan-out through one Durable lead | `#await-exact-peer-results` |
| The wait releases early | `agent_await` again | Explicit input or the first provider retry releases with partial outcomes; apply the input, then await the unresolved references on the same request | Never answer only to wait | `#await-exact-peer-results` |
| A long answer is cut | `agent_inspect` | Use the exact continuation the await result names | A truncated answer is not a failed one | `#await-exact-peer-results` |
| An ordinary primary waits | none | End the turn or do independent work; results arrive by delivery | Do not poll status or inspect in a loop | `#recovery-and-delivery` |

## Supervise and correct

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| A check-in arrives | read its content | Let work continue, steer a wrap-up or next act, or abort a hung tool | A check-in is not a result; each costs an owner model turn | `#controls` |
| Change busy work | `agent_steer` or `agent_send` `mode: "steer"` | Reaches the agent at its next tool boundary | Steer never interrupts a running tool | `#controls` |
| Stop work | `agent_abort` | Stops current work; retained evidence stays | An ordinary abort does not reach background agents; `background: true` does | `#agent-collaboration-and-placement` |
| Read what an agent did | `agent_inspect` | `activity`, `history`, `search`, `result` by submission, `exact` for full entries | Ordinary primaries expose only bounded latest-retained ancestry | `#independent-retained-reads` |
| A mistaken decision | `agent_rewind` | Forks before the entry and submits the correction | Files remain current; repair them separately | `#controls` |
| Side exploration | `agent_fork` | Idle fork with its own identity and an empty profile | A fork inherits no intent claim | `#controls` |

## Context and continuity

| Moment | Control | Decision | Pitfall | Anchor |
|---|---|---|---|---|
| A long-lived agent nears its budget | `agent_reset` with `handoff` | Fresh context; history, identity, files, settings and timers stay; no model turn starts | Write the handoff from the `handoff` template | `#controls` |
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
| What runs now | `agent_status` without target | Shows efforts, claims, and, inside an agent, a Created agents section | Created agents is a creation record, not a live task roster | `#agent-collaboration-and-placement` |
| One agent's state | `agent_status` with `sessionId` | Busy state, current tools, open submissions, pending timers | Settled failures appear in `agent_inspect` results, not here | `#controls` |
| Recent provider failures | `agent_status` `view: "fleet"` | Sampled machine-local evidence | Partial lower bounds; missing evidence is unknown, not zero | `#controls` |
| Find stored agents | `agent_list` | Paged catalog with query | Repeat the same query with the cursor | `#controls` |
| Declare the effort | `agent_intent` | Publish at kickoff and before promotion; clear on release | A claim is not a lock; a finished plan must not stay declared | `#efforts-presence-and-intent` |
