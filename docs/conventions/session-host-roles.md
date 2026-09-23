# Managed session host identity

A native session hosted by another session is not an independent primary.
Registering it as a primary would admit unrelated completion turns during its
startup and let child sessions keep their own parent manager alive at shutdown.

The package owns a synchronous identity exchange over Pi's public `EventBus`.
The subagent native host publishes its claimed identity. The agent extension
uses a positive claim only to exclude that session from primary registration.
Neither participant imports sibling code, reads sibling records, infers role
from mode or ancestry, or gives numeric status snapshots control authority.

Before `session_start`, a host installs a listener on the bus it injects into
its native session's resource loader. A consumer subscribes to
`harness:session-host:role`, then emits `harness:session-host:request`:

```ts
{ version: 1, sessionId: string }
```

The host replies synchronously on that same bus only when the request names
its exact native session and it still owns that session:

```ts
{ version: 1, sessionId: string, role: "managed-child" }
```

The consumer accepts only the current version, exact session identity, and
that role. It removes its response listener immediately after the request.
No reply preserves the independently loaded consumer's existing behavior; it
is not evidence of zero work or a new execution grant. The host owns the
responder outside extension lifecycle callbacks, so extension load order and
reload do not change the answer. A replacement native host receives a separate
bus and identity check. Release, failed construction, and replacement remove
the old responder.

The consumer remembers which sessions it actually registered as primaries.
Shutdown removes only those registrations. It does not ask a responder that
might already be gone during teardown. The identity exchange does not transfer
worker ownership, send prompts, persist state, or start polling.
