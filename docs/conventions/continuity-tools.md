# Continuity tools

A continuity tool lets the model preserve its work or resolve existing work near the
context limit. Stash consumes declarations from extensions that own these tools.
The declaration is a package contract, not permission to act.

## Synchronous declaration

Stash emits `harness:continuity-tools` on the factory's `pi.events` bus. The
ordinary consumer emits for tool calls in the decision or stop band. The native
consumer emits at every enabled `beforeTool` evaluation. Both consumers also emit
when the capacity command reports gate status. A producer answers synchronously:

```ts
interface ContinuityToolsRequest {
  readonly version: 1;
  declare(tool: {
    readonly name: string;
    readonly act: "compaction" | "worker-resolution";
    readonly accepts?: (input: unknown) => boolean;
  }): void;
}
```

Producers ignore unknown versions. Declarations after `emit` returns are ignored.
There is no declaration cache. One bus serves an ordinary process; one bus serves
each native service load. Both factories use the bus supplied as `pi.events`.
No extension imports another extension or interprets its arguments.

A producer declares only a tool that it registers in that runtime. One accepted
call must perform a model-decided continuity act with a bounded result and no
external content intake:

- `compaction` compacts the caller's own context.
- `worker-resolution` resolves existing work: stop it, redirect it, or report on it.

A producer must not declare a spawn tool, `codemode`, `tool_search`, or a generic
runner that executes other tools.

## Argument predicates and authority

`accepts` is a pure, bounded, synchronous predicate over raw arguments. It is
required for `worker-resolution` and optional for `compaction`. The consumer
accepts only the exact result `true`. A missing required predicate, `false`, a
non-boolean result, or a throw refuses the call. The producer refuses scheduling,
spawn and follow-up forms, and every argument form outside its declared scope.

The predicate checks argument shape, not message intent, authority, ownership,
or whether a target is live. A steer can admit new input and start an idle target.
The model uses such a call only to resolve already authorised work. Normal
permissions, request routes, and tool controls still apply during execution.

## Gate boundary

The gate judges new tool calls only. It does not cancel an in-flight call, remove
results, or refuse reports, asynchronous messages, or human input. Those inputs
remain reachable and can still fill the context window. A declaration does not
prove that compaction or preservation succeeded. The operation's result supplies
that evidence.
