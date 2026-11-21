# Codemode recipes

Codemode runs JavaScript that calls tools in one step, so raw payloads stay
out of your context and only the shaped result returns. Paste
a recipe into one `codemode` call and replace the values in the first lines.
Find unlisted tools with `searchTools()` and check argument shapes with
`describeTool()` before you change a recipe.

Some tools return a JSON string and others an object; `agent_collaborate`
returns a string. Each recipe parses both through `asObject`. `store` and
`load` keep small JSON values across codemode calls; the recipes use them
for result references and thread positions.

## Contents

- Thread hosted by a new agent
- Parallel dispatch
- Fleet sweep
- Thread digest
- Save a result digest to a file

## Thread hosted by a new agent

An ordinary primary has no thread storage of its own. When a thread is useful,
spawn an agent the work needs anyway, create the thread in its storage, and
send its task, in one call.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const frame = {
  title: "<short outcome title>",
  purpose: "<shared purpose and use path>",
  authority: "<the operator's words in quotes, and what they grant>",
  source: "<where and when the words were given>",
  restrictions: "<boundaries that bind every member>",
  acceptance: "<what decides completion>",
};
const task = "<task message; {{THREAD_ID}} marks where the thread ID goes>";

const receipt = asObject(await tools.agent_spawn({ name: "<label>", preset: "worker" }));
const host = receipt.result?.sessionId ?? receipt.sessionId ?? receipt.identity;
if (!host) return { stop: "spawn receipt names no identity", receipt };

const thread = asObject(await tools.agent_collaborate({ ...frame, action: "create", sessionId: host }));
const threadId = thread.threadId ?? thread.id;
const sent = asObject(await tools.agent_send({ sessionId: host, message: task.split("{{THREAD_ID}}").join(threadId), checkInMinutes: 30 }));

const refs = [...(load("refs") ?? []), sent.result];
store("refs", refs);
return { host, threadId, ref: sent.result };
```

Notes:

- `sessionId` on `create` places the thread in the new agent's storage. A
  native Durable session omits it to create the thread in its own storage.
- The agent joins the thread itself as the first act of its task.
- Choose the preset and check-in interval using current delegation preferences
  and the public tool definition. The values in the examples are illustrative.

## Parallel dispatch

When you delegate independent tasks together, put the common brief fields in
one object. Keep the exact result reference from each dispatch.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
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

const sent = await Promise.all(tasks.map(async (task) => {
  const receipt = asObject(await tools.agent_brief({ ...shared, ...task }));
  return { name: task.name, ref: receipt.result ?? null, receipt: receipt.result ? undefined : receipt };
}));

const refs = [...(load("refs") ?? []), ...sent.filter((s) => s.ref).map((s) => s.ref)];
store("refs", refs);
return sent.map((s) => (s.ref ? { name: s.name, ref: s.ref } : { name: s.name, failed: s.receipt }));
```

Point to source material in `sources` rather than copying it into each brief.
A receipt does not settle the task. Follow
[the delegate skill](../../skills/delegate/SKILL.md) for results and open work.

## Fleet sweep

Return only the state that supervision needs for each owned agent: name,
busy state, model, current tools, inbox size, and failures. Status lists
open submissions only, so the sweep also reads each stored result reference
for settled failures.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
// No status read lists the agents that a session created: the compact native
// read omits created-agent detail. The sweep uses the result references that
// the dispatch recipes stored.
const ids = [...new Set((load("refs") ?? []).map((r) => r.sessionId))];

const agents = await Promise.all(ids.map(async (sessionId) => {
  try {
    const c = asObject(await tools.agent_status({ sessionId })).conversation ?? {};
    const m = c.agent?.model;
    return {
      sessionId, name: c.name, busy: c.busy, model: m ? `${m.provider}/${m.modelId}` : undefined,
      tools: (c.live?.tools ?? []).map((t) => t.name), inbox: c.inbox?.items?.length ?? 0,
    };
  } catch (error) {
    return { sessionId, unavailable: String(error).slice(0, 200) };
  }
}));

const results = await Promise.all((load("refs") ?? []).map(async (ref) => {
  const r = asObject(await tools.agent_inspect({ sessionId: ref.sessionId, view: "result", submissionId: ref.submissionId }));
  return { ...ref, status: r.status, reason: r.reason, error: r.providerBlock?.error?.slice(0, 200) };
}));

return { agents, failures: results.filter((r) => r.status === "unanswered" || r.reason) };
```

## Thread digest

Return the thread events after the last digest, oldest first, through the
forward read (`after`, `next`, `coverage`). The saved position moves only
past events that the digest returns, so a later digest continues at the
first unread event. The first run starts at the first event.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
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
  page = asObject(await tools.agent_collaborate(call));
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
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const sessionId = "<agent session>";
const submissionId = 0; // the submissionId of the result reference
const finalReport = false; // true for the retained final report of declared work
const path = "<output path>";

let content = "";
let offset = 0;
for (let page = 0; page < 600; page++) {
  const result = asObject(await tools.agent_inspect({ sessionId, view: "result", submissionId, ...(finalReport ? { finalReport } : {}), ...(offset ? { offset } : {}) }));
  const part = finalReport ? result.finalReport : result;
  const text = finalReport ? part?.text : part.answer;
  if ((!finalReport && result.status !== "done") || typeof text !== "string") throw new Error("The requested result is not available.");
  content += text;
  if (part.nextOffset == null) {
    let bytes = 0;
    for (const char of content) {
      const n = char.codePointAt(0);
      bytes += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
    }
    await tools.write({ path, content });
    return { path, bytes };
  }
  if (!Number.isSafeInteger(part.nextOffset) || part.nextOffset <= offset) throw new Error("The result cursor did not advance.");
  offset = part.nextOffset;
}
throw new Error("The result exceeds the page limit; no digest was written.");
```
