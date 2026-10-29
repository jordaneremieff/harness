# Codemode recipes

Codemode runs JavaScript that calls tools in one step, so raw payloads stay
out of the orchestrator's context and only the shaped result returns. Paste
a recipe into one `codemode` call and replace the values in the first lines.
Find unlisted tools with `searchTools()` and check argument shapes with
`describeTool()` before you change a recipe.

Some tools return a JSON string and others an object; `agent_collaborate`
returns a string. Each recipe parses both through `asObject`. `store` and
`load` keep small JSON values across codemode calls; the recipes use them
for result references and thread positions.

## Contents

- Team bootstrap
- Parallel dispatch
- Fleet sweep
- Thread digest

## Team bootstrap

Spawn the agent that will host the thread, create the thread from a checked
frame file, and send the task, in one call. Write `frame.md` and `task.md`
in a scratch directory first (from the `frame` and `task` templates) and
check `task.md` with `scripts/contract.mts check`. Paths in `scripts/` are
relative to this skill's directory; the recipe needs its absolute path.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const skill = "<absolute path of this skill's directory>";
const frameFile = "<scratch>/frame.md";
const taskFile = "<scratch>/task.md";

const framed = await tools.bash({ command: `node ${skill}/scripts/contract.mts frame ${frameFile}` });
const exitCode = framed.exitCode ?? framed.exit_code;
if (exitCode !== 0) return { stop: "frame check failed", findings: framed.output.slice(0, 2000) };
const frame = JSON.parse(framed.output); // Fields only; the caller selects create or revise.

const receipt = asObject(await tools.agent_spawn({ name: "lead", preset: "worker" }));
const lead = receipt.result?.sessionId ?? receipt.sessionId ?? receipt.identity;
if (!lead) return { stop: "spawn receipt names no identity", receipt };

const thread = asObject(await tools.agent_collaborate({ ...frame, action: "create", sessionId: lead }));
const task = (await tools.read({ path: taskFile })).replace("{{THREAD_ID}}", thread.threadId ?? thread.id);
const sent = asObject(await tools.agent_send({ sessionId: lead, message: task, checkInMinutes: 30 }));

const refs = [...(load("refs") ?? []), sent.result];
store("refs", refs);
return { lead, threadId: thread.threadId ?? thread.id, ref: sent.result };
```

Notes:

- Put the literal `{{THREAD_ID}}` in the Thread ID slot of `task.md`; the
  recipe fills it after the thread exists.
- `sessionId` on `create` places the thread in the lead's storage. A native
  Durable orchestrator omits it to create the thread in its own storage.
- The worker joins the thread itself as the first act of its task.
- Choose `preset` and `checkInMinutes` per `SKILL.md` sections 2 and 4.
- The ordinary bash tool returns `exit_code`; the native host returns `exitCode`.
  The recipe accepts those two current host contracts and stops on a nonzero or
  absent exit code.

## Parallel dispatch

Send one wave of tasks and keep only the result references.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const tasks = [
  { name: "reader-a", preset: "reader", file: "<scratch>/task-a.md", checkInMinutes: 0 },
  { name: "builder-b", preset: "worker", file: "<scratch>/task-b.md", checkInMinutes: 30 },
];

const sent = await Promise.all(tasks.map(async (t) => {
  const prompt = await tools.read({ path: t.file });
  const receipt = asObject(await tools.agent_spawn({ name: t.name, preset: t.preset, prompt, checkInMinutes: t.checkInMinutes }));
  return { name: t.name, ref: receipt.result ?? null, receipt: receipt.result ? undefined : receipt };
}));

const refs = [...(load("refs") ?? []), ...sent.filter((s) => s.ref).map((s) => s.ref)];
store("refs", refs);
return sent.map((s) => (s.ref ? { name: s.name, ref: s.ref } : { name: s.name, failed: s.receipt }));
```

A native Durable orchestrator then waits in one call:
`agent_await` with `results` set to the stored references (at most 16). An
ordinary primary does not wait; results arrive through delivery.

## Fleet sweep

Return only the state that supervision needs for each owned agent: name,
busy state, model, current tools, inbox size, and failures. Status lists
open submissions only, so the sweep also reads each stored result reference
for settled failures.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const overview = asObject(await tools.agent_status({}));
// Created agents appear only in a native session's status; an ordinary primary
// relies on the result references that the dispatch recipes stored.
const owned = (overview.createdAgents?.agents ?? []).map((a) => a.identity);
const ids = [...new Set([...owned, ...(load("refs") ?? []).map((r) => r.sessionId)])];

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

Return only thread events newer than the last digest. The first run returns
the whole latest page.

```js
const asObject = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const threadId = "<thread id>";

const key = `digest:${threadId}`;
const seen = load(key) ?? 0;
const page = asObject(await tools.agent_collaborate({ action: "read", threadId, limit: 20 }));
const fresh = (page.events ?? []).filter((e) => e.sequence > seen);
store(key, Math.max(seen, ...fresh.map((e) => e.sequence)));

return {
  frameRevision: page.thread.revision,
  olderUnread: fresh.length > 0 && page.nextBefore !== null && fresh[0].sequence > seen + 1,
  events: fresh.map((e) => ({ seq: e.sequence, kind: e.kind, from: e.sender, rev: e.revision, text: String(e.message).slice(0, 300) })),
};
```

If `olderUnread` is true, more than one page arrived since the last digest;
read the older page with `before` set to `nextBefore`. An event whose `rev`
is lower than `frameRevision` was written against an older frame.
