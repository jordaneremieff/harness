# Read-only reconnaissance with native codemode

Use Pi's native `codemode` to read independent sources together and return a
small result. The agent, stash, memory, and registry extensions expose bounded
objects through `outputSchema` and `structuredContent`. Scripts use those
objects directly, without parsing terminal prose or JSON strings.

This composition adds no shared runtime, store, or cross-extension import.
Each extension still owns its data, bounds, errors, and continuation rules.

## Enable the native tool

The CLI supplies the built-in extension. Add `+codemode` to the existing
`defaultTools` selection without removing its other entries. For otherwise
default settings:

```json
{
  "defaultTools": ["+codemode"]
}
```

Activation decides adoption. The built-in registers `codemode` inactive, and an
inactive tool is not declared to the model, so the model cannot call it and
has nothing to discover. An agent asked to use codemode in such a session can
only fall back to other tools or explain the gap. Once the tool is declared,
Pi's own tool description and its system prompt guidance select it for
batched calls and output filtering without harness instructions. Check the
declaration before changing instructions or policy: `registry` with
`kind: "tool"` and `name: "codemode"` reports `configured` and `active`
separately. `/reload` activates a tool newly added to `defaultTools` in a
running session; `--tools` replaces the whole selection, so an invocation that
passes it must name `codemode` too. Managed sessions created by the
[agent extension](../extensions/agent/README.md) load the built-in through its
public factory and follow the same setting.

Keep native codemode's default `on` mode. It preserves direct tool declarations
alongside script access, and each declared tool that scripts can call carries a
one-line call note: `tools.<name>(args)` resolves to the tool's output. The
full declaration is not repeated in that note; `describeTool(name)` returns
it, and the `codemode` description lists the callable tools without `direct`
exposure within `codemode.inlineBudget` (3000 estimated tokens by default). In
`only` mode, Pi hides direct tool declarations.
Native `read` has no output schema, so a script receives its text but not its
image blocks. Use direct `read` for images. Activating codemode does not require
an MCP server or `tool_search`.

Leave `tool_search` inactive for this workflow. Its discovery covers inactive
`codemode` and `deferred` tools, not these direct harness tools. Inside a script,
`describeTool(name)` and `searchTools(query)` inspect callable tools, and
`describeNamespace(name)` reads a namespace such as an MCP server. The script
catalog and its discovery helpers are distinct from the `tool_search` tool. See
[Find MCP and deferred tools](#find-mcp-and-deferred-tools).

SDK hosts must supply the native factory themselves. With the normal resource
loader, the essential setup is:

```typescript
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();
const settingsManager = SettingsManager.create(cwd, agentDir);
settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  extensionFactories: [createCodemodeExtension({ mode: "on" })],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  resourceLoader,
  sessionManager: SessionManager.inMemory(cwd),
});
try {
  await session.bindExtensions({});
  await session.prompt("Use codemode for bounded read-only reconnaissance.");
} finally {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}
```

The configured resources must include the contributing extensions. An SDK
session does not inherit another session's registrations. Extension-owned
shutdown remains the embedding host's responsibility; `dispose()` disconnects
the session but does not emit `session_shutdown`.

## Compose independent observations

Send the following JavaScript as the native `codemode` tool's `code` input.
Replace the example search terms with the task's subject. This example returns
one bounded page per source, not an exhaustive inventory.

```javascript
// @options: {"timeout_ms": 30000, "max_output_tokens": 6000}
const requests = [
  ["agent_list", { limit: 3 }],
  ["agent_status", {}],
  ["stash_list", { query: "recon", limit: 3 }],
  ["memory_search", { query: ["recon", "reconnaissance"], limit: 3 }],
  ["registry", { kind: "tool", search: "read", limit: 3 }],
];
const settled = await Promise.allSettled(
  requests.map(([name, args]) => tools[name](args)),
);

return settled.map((result, index) => {
  const tool = requests[index][0];
  if (result.status === "rejected") {
    return { tool, status: "rejected", error: String(result.reason) };
  }
  const value = result.value;
  if (typeof value !== "object" || value === null) {
    return { tool, status: "unexpected-shape" };
  }
  const failed = value.kind === "error" || value.ok === false ||
    typeof value.unavailable === "string" || [
    "unavailable", "cancelled", "stale_cursor", "io_error", "invalid_arguments",
  ].includes(value.outcome);
  if (failed) return { tool, status: "tool-error", evidence: value };

  const { rows, sessions, matches, notes, records, ...metadata } = value;
  const items = rows ?? sessions ?? matches ?? notes ?? records ?? [];
  const selected = items.slice(0, 3);
  return {
    tool,
    status: "fulfilled",
    records: selected,
    scriptOmitted: items.length - selected.length,
    metadata,
  };
});
```

`Promise.allSettled` keeps one rejected source from discarding successful
siblings. A fulfilled promise does not establish successful tool execution:
native codemode also resolves data-bearing error results to their structured
object. Check the tool's error fields as well as the promise state. Registry's
`missing`, `ambiguous`, and `partial` outcomes still require interpretation;
the retained `outcome` is not replaced by the promise's `fulfilled` status.

The example keeps non-record metadata intact and reports its own record
omissions. Its output budget is a separate native limit. If Pi truncates that
output, follow the reported output path or request less data before drawing a
conclusion. Do not mistake a short script result for complete source coverage.

The installed `docs/codemode.md` is the script API reference: globals, tool
result shapes, the `models` API, and limits. It records the store bounds
(262,144 characters of JSON per value, 1,048,576 across all values) and the
failure contract: a failed, blocked, or invalid-argument call rejects with an
`Error` carrying the tool's error text, and a failed script keeps its partial
output while calls still running at script end are cancelled.

## Preserve source boundaries

| Tool | Records | Required interpretation |
| --- | --- | --- |
| `agent_list` | `rows` | Keep `coverage`, including its `unavailable` storages, `nextCursor`, `observedAt`, and `authority`. A row is catalog and conversation metadata, not live host state. |
| `agent_status` | `sessions` | Keep `primaries`, `failures`, `coverage`, `observedAt`, and `discovery`. A row read from a storage without a live host is a snapshot, not live owner state. |
| `stash_list` with query | `matches` | Keep `skipped`, `coverage`, `nextCursor`, `consistency`, and `representation`. Search does not activate a handover. |
| `stash_list` without query | `records` | Keep `omittedRecords`, `textTruncated`, and `limitReached`. `coverage.complete: null` means store-wide coverage is unknown. |
| `memory_search` | `notes` | Keep `scan`, `coverage`, `countScope`, `hasMore`, and `nextCursor`. Ranking and counts cover one source window. |
| `registry` | `records` | Keep `outcome`, availability/coverage fields, `resultBounded`, `pageBlocked`, and `cursor`. Registration, activation, and callability are separate facts. |

Follow each source's cursor independently:

- For `agent_list`, repeat the query and cwd with `nextCursor` as `cursor`.
- For stash search, repeat the query and filters with `nextCursor` as `cursor`.
- For memory search, repeat the query and `includeRetired` with `nextCursor` as
  `cursor`. Continue after empty pages while a cursor remains.
- For registry, pass only `cursor`. A blocked page or stale cursor is not the end
  of a complete inventory.

Read selected memory notes with their digests before relying on their content.
Read selected stashes before resuming them. Discovery records grant no authority.
A script does not upgrade historical evidence into an operator decision.

## Find MCP and deferred tools

MCP tools from a server with the default `codemode` exposure are deferred. Pi
neither declares them to the model nor lists them in the `codemode` description,
so that description stays the same while such servers connect. A script finds them
through these sources:

- The `mcp_servers` section of the system prompt names each enabled server that
  has `codemode` or `deferred` tools, how its tools are reached, and a one-line
  summary, within a fixed character cap; when servers do not fit, the section
  counts the omitted ones. The section is absent when no such server is enabled.
- `searchTools(query, { limit, namespace })` ranks tools with BM25 over names,
  descriptions, schema text, and the namespace's name, description, and
  instructions. Pass `namespace` to search one server.
- `describeNamespace(name)` resolves to `{ name, description?, instructions?,
  tools }`, with script identifiers as tool names, or to `undefined`. It is how
  scripts read the server's full instructions. Name a namespace as
  `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius`, or `dev_radius`.

```javascript
const found = await searchTools("list pages", { namespace: "dev-docs", limit: 5 });
const namespace = await describeNamespace("dev-docs");
return {
  found,
  namespace: namespace && {
    name: namespace.name,
    tools: namespace.tools,
    instructions: namespace.instructions?.slice(0, 2000),
  },
};
```

The example cuts the instructions to a bounded excerpt. Check for an `undefined`
result before reading fields: an unknown namespace does not reject.

A script that calls `searchTools`, `describeNamespace`, `describeTool`, or reads
`ALL_TOOLS` waits for servers that are still connecting. A script that only names
`mcp__<server>` waits for that server. Pi activates `codemode` itself when an
enabled server has `codemode` exposure, unless `autoEnableCodemode` is false in
`mcp.json`, and activates `tool_search` for `deferred` exposure.

`registry` with `kind: "tool"` lists MCP tools with their exposure (`deferred` for
default servers), namespace, and configured presence; callability still comes
only from the invocation's tool context. The registry extension reports the
namespace `name` and `description`, omits `instructions`, and sets
`instructionsOmitted: true` when instructions exist, as its
[README](../extensions/registry/README.md) states. Use `describeNamespace()` for
the full text. The [checked Pi contract](pi-durable-harness.md#mcp-and-deferred-tool-discovery)
records the exposure, naming, and waiting rules with their sources.

## Generate images from a script

The `models` API runs image models with the session's credentials. OpenRouter
image models, such as `google/gemini-2.5-flash-image` and
`black-forest-labs/flux.2-pro`, use the same `OPENROUTER_API_KEY` or `/login`
credential as its chat models. List the IDs that work with the current
credentials with `models.getAvailableOfType("image")`. Generation can take
minutes, so leave `timeout_ms` unset or generous; at most four `models` calls
run at once per script, and further calls wait for a free slot.

```javascript
// @options: {"timeout_ms": 300000}
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

`generateImages` does not throw on provider errors; check `stopReason` and
`errorMessage`. Show each image block with `image()`: printing the base64
`data` with `text()` adds a large string the model cannot read, and a script
that generates images without showing them gets a note in its result.
Generated images are not saved to disk. Their usage is added to the `codemode`
tool result and counts toward the session cost, as classifier calls do.

## Orchestration versus native execution

The sandbox has no Node APIs, file system, network, or timers. Scripts reach
the outside world through script-callable tools and the `models` API.
Script-callable tools are the active `direct` tools and every `codemode` or
`deferred` tool; nested calls run through the same tool pipeline as direct
calls, so validation, hooks, and permission checks apply. Use a script to run
independent calls together, to filter or join structured tool output before it
enters model context, to loop a project command over cases and return only the
verdicts, or to reduce a few reads to one small structure. `bash` resolves
inside a script to `{ output, exit_code, ... }` with up to 1 MiB of output, more
than the model's truncated view.

Keep a native runtime for application code, project libraries, framework
shells, tests, binary formats, compression, and long-running or interactive
processes. The script supplies the loop, selection, assertions, and reduction
around a plain single-purpose `bash` command; it does not generate source for
another language to feed through a heredoc.

## Native execution boundaries

Nested calls use Pi's argument validation, `tool_call`, and `tool_result`
pipeline. Policy therefore intercepts the nested calls rather than only the
outer script. A successful nested Pillars source read with a draft delivers the
assessment task to the normal continuation. It does not prove that the model
applied the assessment.

Check a tool's presence with `"name" in tools` before an optional call. Reading
an absent member throws an error that names the close matches, so a `typeof
tools.name` probe fails instead of returning undefined.

Only script output reaches the model as the codemode result. Pi retains bounded
nested-call metadata, not complete nested results. Return the evidence needed
for the conclusion, including errors and coverage. Avoid `store()` for this
one-pass read-only workflow.

Use `agent_status` for orientation, not periodic progress checks. Use direct
`agent_compact` for compaction: its `model-only` exposure excludes nested script
calls. Parallel execution does not grant permission to use mutating tools, and a
script failure does not undo completed side effects.

See the [checked Pi contracts](pi-durable-harness.md#native-codemode-composition)
and [MCP discovery](pi-durable-harness.md#mcp-and-deferred-tool-discovery),
[agent](../extensions/agent/README.md), [stash](../extensions/stash/README.md),
[memory](../extensions/memory/README.md), and
[registry](../extensions/registry/README.md) for the owning contracts.
