# Work references

This package-level contract lets an extension report that a session used a
stored work item that other sessions can also use, such as a published document
or a handover. A consumer can then find live sessions that work on the same
items even when they run in different repositories or folders. Producers and
consumers implement the contract with their own code. No slice imports another,
shares a runtime module, or reads another slice's tool output or store.

## Event and shape

Copy this shape locally into each participating slice.

```ts
type WorkReferenceEvent = {
  version: 1;
  sessionId: string; // ctx.sessionManager.getSessionId() of the session that used the item
  kind: string;      // lowercase token of 1-32 characters: [a-z][a-z0-9-]*
  id: string;        // 1-256 characters, stable across sessions for the same item
  title?: string;    // one display line; consumers may shorten it
};
```

- `harness:work-reference` carries `WorkReferenceEvent` on the public
  `pi.events` bus.

The payload is a process-local JavaScript object. Only version `1` is defined.
Consumers treat `kind` and `id` as opaque strings: two events name the same item
when both are equal. A title is display text from the producer and never
identifies an item.

## Current kinds

| Kind | Item | Producer | Emitted when the session |
|---|---|---|---|
| `document` | A stored Markdown document, by document ID | Markdown | publishes a document or reads one of its revisions |
| `handover` | A handover artifact, by its ID | Stash | writes a handover, reads one, or picks one up |

Checkpoints and other provisional material are not handovers and produce no
event. A new kind needs only a row here and the producer's own emission; a
consumer needs no change.

## Producer rules

1. Emit after the operation succeeded, never for a failed or refused one.
2. Emit only identifiers of items in a store that other sessions of the same
   operator already read by that identifier. Do not emit content, paths,
   credentials, or private text beyond a title the operator already sees.
3. Emit from the ordinary entrypoint with the invoking session's ID. A Durable
   native conversation has no ordinary session ID and emits nothing.
4. Emit without awaiting a consumer and catch listener failures. A missing or
   failing consumer never changes the operation's result.

## Consumer rules

1. Subscribe at factory setup. Ignore malformed events, other versions, and
   events for sessions that the consumer does not own.
2. Keep a bounded, newest-first set per session and retain it with the
   consumer's own session entries if it must survive a resume.
3. Treat a reference as the session's report, not as verified use or as a
   grant of authority over the item or the other session.

The Agent extension is the current consumer. It keeps each ordinary session's
newest distinct references, publishes them in the session's presence record,
and shows live sessions that share a reference in per-run context,
`agent_intent` reads, and `/agent`'s Related efforts view. See the
[Agent README](../../extensions/agent/README.md#efforts-presence-and-intent).
