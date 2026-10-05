# Durable capability contributions

Agent sessions run on Pi Durable (`@earendil-works/pi-durable`). A Durable
conversation receives tools, prompt sections, hooks, wrappers, and tasks only
from native Durable extensions. This contract lets an extension slice supply its
native form beside its ordinary entrypoint. The agent session host collects
those forms from the same configured extension set that a primary Pi session
loads at that working directory.

The contract is package-level and structural. No slice imports another slice or
a shared module to satisfy it. Each slice copies the members it uses from the
[Shape](#shape) block below, and updates those copies when the block changes.

## Bootstrap

1. The agent session host creates Pi's public cwd-bound services with
   `createAgentSessionServices()` and passes its own `EventBus` through
   `resourceLoaderOptions.eventBus`. Pi's resource loader then runs every
   configured extension factory with the settings, package routing, and
   project-trust resolution of a primary session at that directory.
2. An extension with a Durable form emits one contribution from its factory,
   synchronously:

   ```ts
   pi.events.emit("durable:contribution", contribution);
   ```

3. The host subscribes before loading and installs the contributions of the
   loaded extension set. It matches each contribution's `source` to the
   resolved paths of Pi's loaded extensions. A configured extension that emits
   nothing has no Durable form. The host names it in agent status and in the
   agent's prompt; it never substitutes ordinary execution for it. Loader
   failures are a separate `inventory.failed` list, not ordinary-only extensions.
4. In an ordinary Pi session no host listens on the channel, and the emission
   has no effect.

## Shape

This block is the shared subset that every contribution may rely on. The agent
host also passes host-specific fields for its own contribution, and other
contributions must not depend on them.

```ts
import type * as Durable from "@earendil-works/pi-durable";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Context, JsonValue } from "@earendil-works/chord";

interface DurableContribution {
  /** Durable extension name; unique across contributions. */
  readonly name: string;
  /**
   * Absolute path of the emitting extension's entrypoint, for example
   * `fileURLToPath(import.meta.url)` in `index.ts`.
   */
  readonly source: string;
  /** Build the native extension for one session host; called once per host. */
  create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
  /** Commands that agent controls invoke by name, such as `agent_command`. */
  readonly commands?: readonly DurableCommand[];
}

interface DurableContributionHost {
  /** The host's pi-durable module. Take every pi-durable runtime value from it. */
  readonly durable: typeof Durable;
  /** Pi's cwd-bound services: settings, resources, and model runtime. Read-only use. */
  readonly services: AgentSessionServices;
  readonly cwd: string;
  readonly agentDir: string;
  /** The agent storage: one root conversation plus its forks and created agents. */
  readonly storageId: string;
  /**
   * The host's open Harness. The host opens it before the first `create()` call
   * and starts scheduling only after it installs every contribution.
   */
  readonly harness: Durable.Harness;
  /** Aborted when the host starts to shut down. */
  readonly signal: AbortSignal;
  /**
   * Register final work, such as a flush. At shutdown the host aborts `signal`,
   * then awaits every registered function in reverse registration order before
   * it closes storage. A failure is reported and does not stop the others.
   */
  onClose(dispose: () => void | Promise<void>): void;
  /** Everything the host installs. Complete before the first `create()` call. */
  readonly inventory: DurableInventory;
  /** Commit independent contributed work without an answer route to this host. */
  readonly launchIndependent: IndependentCommandLaunch;
}

interface DurableInventory {
  /** Contributions in install order, with their command metadata. */
  readonly contributions: readonly {
    readonly name: string;
    readonly source: string;
    readonly commands: readonly { readonly name: string; readonly description: string }[];
  }[];
  /** Resolved paths of loaded extensions that emitted no contribution. */
  readonly ordinaryOnly: readonly string[];
  /** Configured extensions that failed to load; absent when none failed. */
  readonly failed?: readonly { readonly path: string; readonly error: string }[];
}

interface DurableCommand {
  readonly name: string;
  readonly description: string;
  /** Run against one conversation. The result text returns to the caller. */
  run(call: DurableCommandCall): Promise<string>;
}

interface DurableCommandCall {
  readonly args: string;
  /** Structured invocation input; the owning contribution validates it. */
  readonly data?: JsonValue;
  readonly conversation: Durable.Conversation;
  /** The host's open Harness, for task-level control such as `abortTask()`. */
  readonly harness: Durable.Harness;
  readonly context: Context;
  /**
   * The host that runs the command. Key per-host bindings by it (for example a
   * `WeakMap` filled in `create()`), because one process can run several hosts.
   */
  readonly host: DurableContributionHost;
  /**
   * Unique per invocation and stable when the caller retries the same
   * invocation. Derive request IDs from it, never from the arguments alone:
   * two identical invocations are two requests.
   */
  readonly invocationId: string;
}
```

## Independent command admission

An ordinary extension command starts independent background work without a model
acknowledgment through this package-level contract. It does not call a sibling
agent tool, import sibling source, or encode structured input in command text.

```ts
interface IndependentCommandInput {
  readonly invocationId: string;
  readonly creatorId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly command: {
    readonly name: string;
    readonly args?: string;
    readonly data?: JsonValue;
  };
}
interface IndependentCommandReceipt {
  readonly sessionId: string;
  readonly cwd: string;
  readonly admission: {
    readonly name: string;
    readonly conversationId: number;
    readonly identity: string;
    readonly text: string;
  };
}
type IndependentCommandLaunch =
  (input: IndependentCommandInput) => Promise<IndependentCommandReceipt>;
```

Ordinary callers discover a launch provider synchronously:

```ts
const providers: IndependentCommandLaunch[] = [];
pi.events.emit("durable:launch-provider", {
  provide: (launch: IndependentCommandLaunch) => providers.push(launch),
});
if (providers.length !== 1) {
  throw new Error("Independent work requires exactly one launch provider");
}
const receipt = await providers[0](input);
```

Discovery has no asynchronous effects. No provider and multiple providers fail
before launch. The Durable contribution host exposes the same function as
`host.launchIndependent`. No new model tool or slash command is registered.

The host reads fresh cwd-bound Pi settings after normal project-trust
resolution. It resolves `enabledModels` through Pi's public scope resolver,
prefers a saved default inside that scope, and otherwise uses its first model.
With no resolved scope, Pi's public SDK supplies model fallback. An unprompted
in-memory SDK session supplies per-model/default thinking and capability
clamping, then is disposed. The host neither prompts that session nor writes
model defaults. It does not inherit invocation flags or caller model/thinking.

The creator and invocation identities select one existing catalog root. The
host records the chosen model/thinking, input digest, and evaluated project
trust before opening it. A session-only trust answer remains session-only; the
host carries its evaluated result without writing it into the trust store.
Replay uses those retained choices and rejects different command input. The
owning contribution commits replay-safe native work keyed by `invocationId` and
rejects conflicting data before returning its admission text.

Admission uses the existing independent host process and command dispatch. It
never uses answer-bearing task submission, a Reporter, a check-in, or a parent
status subscription. The temporary launch link closes after command admission;
caller exit does not cancel committed work. `creatorId` is provenance for
discovery and trust routing only, not a result destination.

Setup and admission errors return to the command caller. Successful admission
stays silent in the main conversation. The owning contribution records terminal
outcomes in native entries for existing agent inspection, including skip and
publication failure. Its normal external store remains the artifact discovery
surface. A model answer or an idle root does not prove publication succeeded.

## Rules

- Take pi-durable runtime values (`defineExtension`, `defineTool`, `section`,
  `hook`, `defineDoc`, `defineTask`, `configure`, entry and task tokens) from
  `host.durable`. Import the package only for types. Active extensions load from
  separate worktrees whose dependency trees hold separate copies of the package.
- Import `typebox` and `@earendil-works/pi-ai` as an ordinary extension does.
- `create()` uses no ordinary session API: no `ExtensionContext`,
  `SessionManager`, `pi.sendMessage()`, or ordinary events. Domain functions
  inside the slice may serve both entrypoints.
- Every tool declares `replay` explicitly. Use `"safe"` only when a rerun after
  process loss repeats no external effect, or deduplicates it with a stable key.
  Otherwise use `"unsafe"`; the model then receives an interrupted result. A
  metered, billed, rate-limited, or account-bound request counts as an external
  effect, even when it only reads.
- Conversation state that must survive process loss lives in Durable documents.
  Prefix each document kind with the contribution name, for example
  `memory.index`. A hook decision that must not change on replay uses
  `api.memo()`. Process-level maps hold caches only. Hooks receive only the
  public `HookApi`: committed reads and memos. A hook that must write durable
  state commits through `host.harness.commit()` with an update keyed by the
  task or call identity, so a replayed hook applies it once; a hook that needs
  the resolved agent reads `host.harness.conversation(id)` and its `agent()`.
  Never cast `HookApi` to reach undocumented members.
- Shared external stores, such as the memory corpus, stash store, clipboard
  archive, and policy store, stay external. Do not copy them into documents.
- Model-facing usage guidance belongs in a prompt section of the contribution.
- Native `details` equal the ordinary tool's `details`. Where the ordinary tool
  also returns `structuredContent`, the native result adds it beside them:
  `details: { ...details, structuredContent }`; nowhere else. An `outputSchema`
  property on the registration object describes that `structuredContent`
  object, for example `{ ...durable.defineTool({...}), outputSchema }`;
  pi-durable ignores the extra property, and nested-call declarations read it.
- Use native hooks for their native meanings: `beforeTool` and `afterTool` on
  `ToolTask`; `beforeRequest`, `afterResponse`, `onYield`, and `afterTools` on
  `GenerationTask`; `beforeCompact` on `CompactionTask`.
- The host installs its built-in extensions first and contributions after them,
  in load order. A contribution tool with a built-in tool's name replaces the
  built-in where both are selected.
- A colocated `durable.test.mts` runs the contribution in a real Harness over
  `MemoryStorage` with pi-ai's faux provider. It drives at least one
  model-issued call per tool and checks the declared replay behavior.

## Host built-ins

The agent session host supplies:

- coding tools: `read` with image support, `write`, `edit`, and `bash`;
- prompt sections composed from Pi's resource loader: context files, skills,
  appended system prompts, and the working directory; and
- native execution and discovery capabilities described in the
  [agent README](../../extensions/agent/README.md#capabilities-and-project-resources),
  including agent controls, codemode, and configured MCP tools.

Contributions do not duplicate these.
