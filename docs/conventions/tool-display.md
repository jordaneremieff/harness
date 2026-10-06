# Tool display contract

This package-level contract lets the agent dashboard use an owning extension's
ordinary Pi tool presentation. Pi's tool inventory does not expose renderer
functions. Publishers send those references through the public `pi.events` bus;
consumers never import sibling extensions or interpret their output formats.

## Events and shape

Copy this contract shape locally into each participating slice. Equivalent Pi
`Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">`
notation and inline versioned envelopes preserve the same shape; alias names
need not match. Do not create a shared runtime module or import another slice.
`ToolDefinition` is Pi's public type from `@earendil-works/pi-coding-agent`.

```ts
type ToolDisplayPublication = {
  version: 1;
  tools: Array<{
    name: string;
    renderCall?: ToolDefinition["renderCall"];
    renderResult?: ToolDefinition["renderResult"];
    renderShell?: ToolDefinition["renderShell"];
  }>;
};
type ToolDisplayRequest = { version: 1 };
```

- `harness:tool-display:publish` carries `ToolDisplayPublication`.
- `harness:tool-display:request` carries `ToolDisplayRequest`.

These are process-local JavaScript payloads, not serialized messages. Renderer
functions retain their identity. Only version `1` is defined. No aliases,
predecessor shapes, or compatibility readers exist.

Each tool has a nonempty name and at least one defined renderer or shell.
`renderCall` and `renderResult`, when defined, are functions. `renderShell`, when
defined, is `"default"` or `"self"`, as Pi specifies. Tools without custom
presentation need no publication.

## Publisher lifecycle

At extension factory setup:

1. Build the same tool definitions or renderer records used for registration.
2. Select only `name`, `renderCall`, `renderResult`, and `renderShell`.
3. Subscribe to `harness:tool-display:request`.
4. On a request with `version === 1`, emit the current publication.
5. Emit that publication once during factory setup as well.

Do not publish `execute`, parameters, prompts, schemas, loadout hooks, mutable
extension state, or a tool registration API. Do not wait for `session_start`.
A request response only emits display data; it executes no tool. Publishers own
their renderer logic and its handling of arguments and result details.

The owning slices are brave, clipboard, history, memory, pillars, policy,
registry, and stash. Agent publishes its internal cards from the same renderer
records used by its ordinary registration. The agent dashboard also retains
local precedence for those cards.

## Consumer lifecycle and safety

At extension factory setup:

1. Create a fresh local registry.
2. Subscribe to `harness:tool-display:publish`.
3. Emit `harness:tool-display:request` with `{ version: 1 }`.

The publication listener ignores malformed envelopes and malformed entries. It
copies only checked renderer fields, never execution or loadout fields. It
replaces each valid entry by tool name; it does not merge a new entry with old
fields. A publication does not withdraw names absent from its list. Each name
belongs to its owning slice; concurrent duplicate owners violate this contract.

The current Pi event bus invokes a synchronous handler immediately. This
subscribe-before-emit handshake therefore covers both factory load orders:
a later publisher's initial emission reaches an existing consumer, and a later
consumer's request reaches an existing publisher. No timer or fixed wait is
part of the protocol. Pi tracks `pi.events.on` subscriptions and removes them
when its extension runtime is invalidated. A reload recreates the registry and
subscriptions and repeats the same handshake, so the new consumer does not
retain removed tools or old renderer closures. Dashboard component instances
belong to the current view, not module-global reading state. Reopened views
build new definitions from the current lookup rather than reuse old cards.

Renderer references are trusted extension code, not a sandbox. Sanitization
prevents copied tool execution capabilities; it does not remove the ordinary
capabilities of a renderer closure. The consumer creates a display-only
`ToolDefinition` whose `execute` always throws and whose loadout hooks are absent.
Pi's `ToolExecutionComponent` handles renderer errors with its standard fallback.

## Agent dashboard resolution

`collectToolDisplay(pi.events)` returns a dynamic name lookup. The agent factory
passes that lookup through `createAgentCommand`, dashboard operations,
`ConversationView`, and `AgentConversation` to `createDashboardToolDefinitions`.
The lookup contains no sibling names or sibling-specific result logic.

Resolution order is:

1. Pi builtin definitions for known calls.
2. Pi's public codemode factory presentation and local agent cards.
3. A checked publication for other tool names.
4. Pi's standard card when no renderer is available.

A missing builtin call still uses Pi's missing-tool semantics. Published
renderers do not replace native builtin, codemode, or agent presentation. If Pi's
codemode factory capture is unavailable, codemode uses the standard card rather
than a publication. Dashboard definitions remain inert at every resolution step.
Codemode details pass through unchanged; no legacy-record normalizer exists.

## Verification

Each publisher's slice-local tests use a fake bus to assert initial publication,
request responses, renderer identity, field selection, and subscription cleanup.
Agent tests use fake publishers to assert both load orders, registry replacement,
reload, malformed-payload containment, inert definitions, native precedence, and
use by the native `ToolExecutionComponent`. No slice test imports another
slice's source or asserts its private display vocabulary.
