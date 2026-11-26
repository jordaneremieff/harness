# Codemode recipes

Codemode runs JavaScript that calls tools in one step, so raw payloads stay
out of your context and only the shaped result returns. Paste
a recipe into one `codemode` call and replace the values in the first lines.
Find unlisted tools with `searchTools()` and check argument shapes with
`describeTool()` before you change a recipe.

The Agent tools that the recipes call resolve to objects, in an ordinary
session and inside a Durable agent. Inside a Durable agent, `agent_abort` and
the deferred controls resolve to their JSON text; read them with `JSON.parse`.
`store` and `load` keep small JSON values across codemode calls; the recipes
use them for result references and thread positions.

## Contents

- How Agent tools behave in a script
- Thread for delegated work
- Parallel dispatch
- Fleet sweep
- Thread digest
- Save a result digest to a file

## How Agent tools behave in a script

- **Turn and compaction controls stay outside scripts.** `agent_yield` and
  `agent_compact` are model-only. A nested call cannot end the turn, because
  codemode resolves it to its result. Return from the script, then call
  `agent_yield` directly in the last tool batch.
- **A failed call rejects.** The rejection carries the tool's error text, such
  as an unknown identity or a schema violation. Use `Promise.allSettled` for a
  batch, so that one refusal does not discard the receipts of calls that
  succeeded. Some refusals resolve instead: `agent_status` can return
  `format: "refused"`, an `agent_brief` preview returns `problems`, and a
  result read returns `status: "unavailable"` with a `reason`.
- **A receipt is admission.** A dispatch resolves when the host admits the
  input. The answer arrives later as an event of your session, never inside
  the script.
- **An ended script leaves admitted work running.** A timeout or a thrown error
  cancels the calls still waiting, not the work that a host admitted. A lost
  receipt is not a failed dispatch: find the agent with `agent_list` and its
  open requests with `agent_status` before you send the task again. Never
  repeat `agent_abort`.
- **Parallel inputs have no order.** Calls in one `Promise.all` reach one
  recipient in any order. Send in sequence when the order matters.
- **Continue pages from what the page returns, with a cap.** An `agent_inspect`
  history, branch or activity cursor keeps the view and filters of its read:
  pass `sessionId` and `cursor`. A search continuation repeats `view: "search"`
  and its query. `agent_list` and `agent_status` continue with the fields of
  `coverage.next`, and `agent_collaborate` with the fields of `next`. A page
  without rows is not the end while a continuation remains. Stop at a fixed
  number of pages and report that the cap stopped the loop.

## Thread for delegated work

Any session creates a thread without an agent: `create` without `sessionId`
places it in the caller's own storage. An ordinary primary's own storage is its
thread storage, which holds threads and runs no agent work. Create the thread,
then give its ID to the agents that share the work, in one call.

```js
const frame = {
  title: "<short outcome title>",
  purpose: "<shared purpose and use path>",
  authority: "<the operator's words in quotes, and what they grant>",
  source: "<where and when the words were given>",
  restrictions: "<boundaries that bind every member>",
  acceptance: "<what decides completion>",
};
const task = "<task message; {{THREAD_ID}} marks where the thread ID goes>";

const { threadId } = await tools.agent_collaborate({ ...frame, action: "create" });
const { sessionId } = await tools.agent_spawn({ name: "<label>", preset: "worker" });
const sent = await tools.agent_send({ sessionId, message: task.split("{{THREAD_ID}}").join(threadId) });

store("refs", [...(load("refs") ?? []), sent.result]);
return { agent: sessionId, threadId, ref: sent.result };
```

Notes:

- A spawn without a prompt creates an idle agent and returns its `sessionId`.
  The send returns the result reference of the task.
- Other sessions find the thread with `agent_collaborate` `list`, or through
  the Active thread hints of related sessions.
- The agent joins the thread itself as the first act of its task.
- Choose the preset and a check-in interval using current delegation
  preferences and the public tool definition. The values in the examples are
  illustrative.

## Parallel dispatch

When you delegate independent tasks together, put the common brief fields in
one object. Keep the exact result reference from each dispatch.

```js
const shared = {
  purpose: "Decide which parser cases need new examples.",
  sources: ["README.md:1 Current examples and how to run them"],
  restrictions: ["Review only. Do not edit files."],
  checkInMinutes: 0,
};
const tasks = [
  {
    name: "Input cases", preset: "reader",
    objective: "Identify input cases absent from the current examples.",
    endCondition: "Stop once each documented input type has an example or a named gap.",
    result: "List gaps with one example input each.",
  },
  {
    name: "Error cases", preset: "worker",
    objective: "Identify which parser errors need examples.",
    endCondition: "Stop when each public error has a documented example or a named gap.",
    result: "List gaps with the source that defines each error.",
  },
];

const settled = await Promise.allSettled(tasks.map((task) => tools.agent_brief({ ...shared, ...task })));
const sent = settled.map((outcome, index) =>
  outcome.status === "fulfilled"
    ? { name: tasks[index].name, ref: outcome.value.result }
    : { name: tasks[index].name, refused: String(outcome.reason).slice(0, 300) },
);

store("refs", [...(load("refs") ?? []), ...sent.filter((s) => s.ref).map((s) => s.ref)]);
return sent;
```

Point to source material in `sources` rather than copying it into each brief.
A refused brief, for example one that names a missing source path, does not
discard the references of the briefs that the hosts admitted. Repair and send
only the refused task. A receipt does not settle the task.

## Fleet sweep

Return only the state that supervision needs for each dispatched agent: name,
busy state, model, queue and open work, and the requests that are still out
or failed. No status read lists the agents that a session created: the compact
native read omits created-agent detail. The sweep uses the result references
that the dispatch recipes stored.

```js
const refs = load("refs") ?? [];
const ids = [...new Set(refs.map((ref) => ref.sessionId))];

const statuses = await Promise.allSettled(ids.map((sessionId) => tools.agent_status({ sessionId })));
const agents = statuses.map((outcome, index) => {
  const sessionId = ids[index];
  if (outcome.status === "rejected") return { sessionId, unavailable: String(outcome.reason).slice(0, 200) };
  if (outcome.value.format === "refused") return { sessionId, refused: outcome.value.reason };
  const c = outcome.value.conversation;
  return {
    sessionId, name: c.name, busy: c.busy, availability: c.availability,
    model: c.model ? `${c.model.provider}/${c.model.modelId}` : null,
    inbox: c.queue.inbox, submissions: c.queue.submissions, unplaced: c.unplaced, openWork: c.openWorkCount,
  };
});

const reads = await Promise.allSettled(refs.map((ref) =>
  tools.agent_inspect({ sessionId: ref.sessionId, view: "result", submissionId: ref.submissionId }),
));
const results = reads.map((outcome, index) => {
  const ref = refs[index];
  if (outcome.status === "rejected") return { ...ref, error: String(outcome.reason).slice(0, 200) };
  const r = outcome.value;
  return { ...ref, status: r.status, reason: r.reason, providerError: r.providerBlock?.error.slice(0, 200) };
});

return {
  agents,
  out: results.filter((r) => r.status === "queued" || r.status === "placed"),
  failures: results.filter((r) => r.error || r.reason || r.status === "unanswered" || r.status === "unavailable"),
};
```

`agent_status` with `detail: true` adds live tools, tasks and submissions for
one agent; read it only for an agent that the sweep shows in trouble.

## Thread digest

Return the thread events after the last digest, oldest first, through the
forward read (`after`, `next`, `coverage`). The saved position moves only
past events that the digest returns, so a later digest continues at the
first unread event. The first run starts at the first event.

```js
const threadId = "<thread id>";
const pages = 3; // forward pages per digest
const shown = 600; // characters of an ordinary message before a cut
const budget = 24000; // characters of event rows per digest

const key = `digest:${threadId}`;
const saved = load(key) ?? { after: 0 };
let call = { action: "read", threadId, after: saved.after, limit: 20, ...(saved.frameRevision ? { knownFrameRevision: saved.frameRevision } : {}) };
let page;
let frame;
let through = saved.after;
let used = 0;
let full = false;
const events = [];
for (let read = 0; read < pages && call && !full; read++) {
  page = await tools.agent_collaborate(call);
  frame = page.thread ?? frame;
  for (const e of page.events) {
    const text = String(e.message);
    const whole = e.kind === "carried-authority" || text.length <= shown;
    const row = {
      seq: e.sequence, kind: e.kind, from: e.sender, rev: e.revision,
      ...(e.replyTo ? { replyTo: e.replyTo } : {}), ...(e.source ? { source: e.source } : {}),
      text: whole ? text : `${text.slice(0, shown).replace(/[\uD800-\uDBFF]$/, "")} [cut]`,
      ...(whole ? {} : { cut: { shown, of: text.length, read: { action: "read", threadId, after: e.sequence - 1, limit: 1 } } }),
    };
    const size = JSON.stringify(row).length;
    if (events.length > 0 && used + size > budget) { full = true; break; }
    events.push(row);
    used += size;
    through = e.sequence;
  }
  if (full) break;
  through = page.coverage.through;
  const { tool, ...following } = page.next ?? {};
  call = page.next ? following : null;
}
store(key, { after: through, frameRevision: page.frameRevision });

return {
  frameRevision: page.frameRevision,
  closed: page.closed,
  ...(frame ? { frame: { title: frame.title, purpose: frame.purpose, authority: frame.authority, source: frame.source, restrictions: frame.restrictions, acceptance: frame.acceptance, integrator: frame.integrator } } : {}),
  through,
  newest: page.sequence,
  next: through < page.sequence ? { action: "read", threadId, after: through, knownFrameRevision: page.frameRevision, limit: 20 } : null,
  events,
};
```

Notes:

- `next` is the exact `agent_collaborate` call for the first unread event, or
  `null` when the digest reached the newest event. Run the digest again, or
  make that call, until `next` is `null`; `newest - through` counts the
  events that remain.
- A row whose text ends in `[cut]` is an excerpt. Its `cut.read` is the exact
  call that returns the complete event. A `carried-authority` post and every
  `source` return whole, so a relayed operator decision or correction and its
  source stay in the digest.
- `frame` is present on the first run and whenever the frame changed since the
  last digest: read it before you act on the events. An event whose `rev` is
  lower than `frameRevision` was written against an older frame.
- The position is stored only after every page of the digest was read. A
  failed read stores nothing, and the next digest repeats from the old
  position.

## Save a result digest to a file

Use a caller-supplied output path for an agent's answer or declared final
report. Pi's built-in `write` replaces the file. The digest stays out of the
owner's context; the owner can show or publish the file with the tools of
its session.

```js
const sessionId = "<agent session>";
const submissionId = 0; // the submissionId of the result reference
const finalReport = false; // true for the retained final report of declared work
const path = "<output path>";

let call = { sessionId, view: "result", submissionId, ...(finalReport ? { finalReport } : {}) };
let content = "";
for (let page = 0; page < 600; page++) {
  const result = await tools.agent_inspect(call);
  if (!finalReport && result.status !== "done") throw new Error(`The answer is not available: ${result.status} ${result.reason ?? ""}`);
  const text = finalReport ? result.finalReport?.text : result.answer;
  if (typeof text !== "string") throw new Error("The requested result has no retained text.");
  content += text;
  const continuation = finalReport ? result.finalReportContinuation : result.answerContinuation;
  if (!continuation) {
    let bytes = 0;
    for (const char of content) {
      const n = char.codePointAt(0);
      bytes += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
    }
    await tools.write({ path, content });
    return { path, bytes, pages: page + 1 };
  }
  const { tool, ...next } = continuation;
  call = next;
}
throw new Error("The result exceeds the page limit; no digest was written.");
```

Each page names the exact call for the next page in `answerContinuation`, or in
`finalReportContinuation` for a final report; the loop follows it unchanged.
