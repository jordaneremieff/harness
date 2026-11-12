# Threads

A peer thread keeps shared purpose and evidence in one participant's native
Durable storage. It is not an agent, a broker, or a transcript. The thread's
creator seeds the frame; members choose contributions, share findings, and
challenge decisions. Runtime detail: `extensions/agent/README.md`
`#peer-threads`.

## When a thread earns its cost

Create a thread when evolving shared facts, decisions, or coordination among
several agents need one retained place: one part's findings change another
part's question, several agents act on the same carried decision and its
corrections, or the operator wants to follow the exchange there. A shared
purpose alone does not require one. Independent parts with sufficient briefs
need none, and direct `agent_send` covers a single exchange. An ordinary
primary with no agent yet uses direct exchange. Never spawn an agent only to
hold a thread.

Before creating, list existing threads with `agent_collaborate`
`action: "list"` and a short `query`. Join a thread whose purpose already
covers the work instead of creating a duplicate.

## Placement

A thread lives in a participant's storage:

- **Native Durable session:** create it in your own storage (the default).
- **Ordinary primary:** pick an agent the work needs anyway. Spawn it idle (no
  prompt), create the thread with `sessionId` set to that agent, then send its
  task with the thread ID. The creator is a member from the start.

## Frame

Pass the frame fields directly to `agent_collaborate` with
`action: "create"`; the tool refuses missing or oversized fields. For an
existing thread, use `{ ...frame, action: "revise", threadId }`. When a long
or reused frame is easier to keep in a file, fill `assets/frame.md` and
convert it with `node scripts/contract.mts frame <scratch>/frame.md`, which
prints the fields as JSON or names missing and oversized fields. Fields:

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

- **Join:** each agent joins itself with a one-line `participation` naming its
  task and its hold or release condition. Omission preserves its declaration;
  an empty string clears it. An unchanged join creates no event or notice.
  Create accepts `participation` too. Join does not accept a discussion `message`;
  post a separate message for discussion.
- **Post:** `message` with an optional `source` and `replyTo` event. Use
  `kind: "carried-authority"` with a `source` to relay an operator decision.
- **Size:** keep `participation` within 256 characters and `message` within
  8,000 characters. Write longer content to a file and post its path.
  Do not split the content across repeated posts to evade the caps.
- **Notify:** named `notify` recipients get active attention. Other members get
  body-free passive event facts, with no model turn. Each passive notice arrives
  as one message without the event body and names the exact `agent_collaborate`
  read call for that event.
  Name recipients only when their attention matters now.
- **Read:** the default read returns the frame, members, chronological events,
  and `nextBefore` for older pages. Follow that cursor with `before`.
  To read new events, use `after: 0` initially, then the last returned sequence.
  Supply `knownFrameRevision` with `after` to omit an unchanged frame.
  Forward pages return `direction: "forward"`, page coverage, and an exact `next`
  call when more events remain. Follow it unchanged. Do not mix `after` and
  `before`; a revision without `after` refuses.
- **Time and recovery:** each event read shows its epoch `at` and derived ISO UTC
  `atUtc`. A null UTC value means the epoch exceeds the date conversion range.
  Active excerpts mark a cut with `[cut]`. Active and passive notices both name
  an exact thread read for the full event.

At the next normal context boundary, an ordinary session groups verified passive
facts for the same thread and recipient, between assistant messages, into a frozen
range marker. Later facts form another marker; they do not enlarge a frozen range.
Active or unmatched notices remain intact. The original retained messages remain
unchanged. This context grouping applies to ordinary sessions, not native sessions.

A read does not acknowledge addressed attention or indicate agreement. A create
event omits its duplicate frame text in read output and marks that omission;
the top-level frame and the retained original event stay intact.

No post or notice arms a check-in or requests a reply. A passive notice can
arrive after a contributor's deliverable; assignments therefore put tool calls
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
