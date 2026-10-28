# Threads

A peer thread keeps shared purpose and evidence in one participant's native
Durable storage. It is not an agent, a broker, or a transcript. The
orchestrator seeds the frame; peers choose contributions, share findings,
and challenge decisions. Runtime detail: `extensions/agent/README.md`
`#peer-threads`.

## When a thread earns its cost

Create a thread when two or more agents share one purpose, need the same
operator words and restrictions, or must see each other's findings. Skip it
for a single worker; the contract carries the frame. An ordinary primary
with no agent yet uses direct exchange. Never spawn an agent only to hold a
thread.

Before creating, list existing threads with `agent_collaborate`
`action: "list"` and a short `query`. Join a thread whose purpose already
covers the work instead of creating a duplicate.

## Placement

A thread lives in a participant's storage:

- **Native Durable orchestrator:** create it in your own storage (the
  default).
- **Ordinary primary:** pick an agent the work needs anyway, often the lead
  or first worker. Spawn it idle (no prompt), create the thread with
  `sessionId` set to that agent, then send its task with the thread ID. The
  creator is a member from the start.

## Frame

Fill `assets/frame.md`, then convert and check it in one step:

```bash
node scripts/contract.mts frame <scratch>/frame.md
```

The command prints the `create` arguments as JSON, or names the missing and
oversized fields and exits nonzero. Fields:

- **Title:** short and specific to the outcome.
- **Purpose:** the goal and the use path: what changes for the operator.
- **Authority:** the operator's words verbatim in quotes, plus what they
  grant and what stays reserved.
- **Source:** where and when the words were given.
- **Restrictions:** boundaries that bind every member, including
  provider or budget limits.
- **Acceptance:** the checks that decide completion.
- **Integrator:** the identity that integrates; omit it to default to the
  creator.

A frame is an attributed statement, not authenticated authority. Keep the
operator decision distinct from your interpretation.

## Members, posts, and notices

- **Join:** each agent joins itself with a one-line `contribution` naming its
  task and its hold or release condition. A second join revises it.
- **Post:** `message` with an optional `source` and `replyTo` event. Use
  `kind: "carried-authority"` with a `source` to relay an operator decision.
- **Notify:** named `notify` recipients get a steer and a model wake. Other
  members get passive notices at existing boundaries, with no model turn.
  Name recipients only when their attention matters now.
- **Read:** returns the frame, members, chronological events, and
  `nextBefore` for older pages. Use the digest recipe in
  `references/codemode.md` to read only new events.

No post or notice arms a check-in or requests a reply. A passive notice can
arrive after a worker's deliverable; contracts therefore put tool calls
first and the deliverable last.

## Revise and close

- **Operator correction:** `revise` the complete frame (creator, integrator,
  or operator only), then steer each affected agent with the change and its
  source. Events keep their frame revision; compare it with the current one.
- **Nonmember proposal:** a member without revise permission posts a
  proposal instead.
- **Split:** start another thread when a part of the work gains a separate
  purpose.
- **Close:** post a conclusion, then `close`. Closing ends mutations, not
  history. A full or closed thread is replaced by reading its frame and
  creating a new thread with all required fields.
