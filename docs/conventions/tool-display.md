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

Every slice that registers a tool with a custom renderer publishes it; the
[emission grammar](emissions.md) requires a renderer for every harness tool.
Find the current publishers with `rg -l toolDisplay extensions/*/display.ts`.
Agent publishes its internal cards from the same renderer records used by its
ordinary registration. The agent dashboard also retains local precedence for
those cards.

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

For a retained call under a Pi built-in name, use the checked owner publication
if present. As in Pi's ordinary tool registry, fill each absent `renderCall` and
`renderResult` from the built-in. The publication controls `renderShell`: if it
omits the field, Pi uses its default shell. Without a publication, use the
built-in's own renderers and shell.

For `codemode`, use the renderers captured from Pi's public factory without
registering a tool with a session. If capture fails, use the standard card.
Codemode details pass through unchanged, including the producer's nested statuses.
When a built-in or codemode result has no retained call in view, use the standard
card without assuming a call schema or renderer. If the call arrives, use the
resolved renderers.

For local Agent tools, use the same Agent card functions with the transcript's
observed roster. Keep the owner's shell and configured disclosure hint, including
the self-rendered `agent_yield` state note. For other tools, use a checked owner
publication when available and Pi's standard card otherwise. Definitions stay
inert: the client does not register them or use them to execute tools.

## Presentation modules for the attached terminal

The standalone Agent terminal is a separate process. It cannot receive the
renderer references that the event bus carries, and it does not run extension
factories. An owning slice therefore also exposes a pure presentation module that
the attached client imports locally.

```ts
// <slice>/display.ts
export function toolDisplay(): ToolDisplayPublication; // same records as the ordinary publication
```

The module imports only presentation code and public Pi or pi-tui types. It does
not import the slice entrypoint or its Durable form, register tools, emit events,
read settings or credentials, open a store, or start a host. Evaluating it has no
effect beyond module evaluation. The ordinary registration and the event
publication derive from this function, so one record set serves all consumers.

The slice advertises the module in the contribution it emits on
`durable:contribution`:

```ts
display: { version: 1, entry: "./display.ts", export: "toolDisplay" }
```

This contract covers tool cards only: inert presentation of retained tool calls
and results. An owner browser that the attached terminal can open over the
conversation is a different role with its own request route; it is the
[operator views](operator-panels.md#attached-panels) convention, advertised beside `display` as
`panel`. A display module never executes and a panel module never renders tool
cards.

- `version` is `1` and `export` is `"toolDisplay"`. Other values and extra
  fields are refused.
- `entry` is a bare relative file path that starts with `./`. It has no empty,
  `.`, or `..` segment, backslash, colon, query, fragment, or control or space
  character. It is never an absolute path or a URL.
- `entry` resolves relative to the directory of the contribution's `source`.
  The resolved real path must be a file inside that directory, so a symbolic link
  that leaves it is refused.

Host. The Agent host reads the descriptor only from a contribution that its
loader admitted: the `source` must match a loaded extension entrypoint. A
malformed descriptor, or an entry that does not resolve, removes only the
descriptor. The contribution still installs and the host reports the refusal as a
bootstrap issue. The inventory in `status` carries each admitted descriptor
beside its contribution. The field is optional in `DurableInventorySchema`, so
the status response identity changed with its introduction. A host and a client
from different releases refuse each other through the existing operation
identity check. No reader accepts the older shape.

Client. After a successful attach the client reads the live host's `status`
inventory and imports each advertised module under the managed Pi peer
resolver. It calls the export and keeps only fields that
`presentationRecords` accepts: a tool name plus `renderCall`, `renderResult`,
and `renderShell`. A module that is missing, throws, exports no function,
publishes another version, or repeats a name already supplied costs only its own
cards. The client reports the first bounded diagnostic in the target header
once per selection load, with the issue count if there is more than one. No
inventory means no display-module diagnostic. The attach does not wait for the modules. The lookup replaces the
previous source's lookup as a unit and the transcript rebuilds its cards, so no
renderer closure from an earlier source stays attached. Passive roster or
retained-transcript reads never start a host to obtain presentation.

The standalone conversation and the Agent dashboard use the same
[resolution rules](#agent-dashboard-resolution). A cold read without inventory
uses the local Pi and Agent renderers where applicable and the standard card for
other tools. Renderers are trusted local code, not a sandbox.

## Verification

Each publisher's slice-local tests use a fake bus to assert initial publication,
request responses, renderer identity, field selection, and subscription cleanup.
Agent tests use fake publishers to assert both load orders, registry replacement,
reload, malformed-payload containment, inert definitions, native precedence, and
use by the native `ToolExecutionComponent`. Each slice also tests its descriptor,
its `toolDisplay()` records against the ordinary publication, and that importing
the module registers and emits nothing. Agent tests load fixture modules through
the real resolver for the standalone path, covering a missing module, a
throwing export, a refused entry and source replacement. No slice test imports
another slice's source or asserts its private display vocabulary.
