# Session host roles

The ordinary primary owns the Pi terminal and its extension lifecycle. It is a
client of Durable agent hosts, not their execution owner. Reload and shutdown
remove its delivery callbacks and client connections without stopping admitted
agent work. The primary registers one channel over the public `pi-server`/
`pi-client` Unix transport: a same-user socket where a private 0700 directory,
an owner-only 0600 socket, and the exact `serverId` handshake are the boundary;
no token crosses it. That channel returns peer messages and answers project-trust
prompts.

One independent process owns each Durable storage. It takes the exclusive writer
claim before storage opens, and it alone resumes the native scheduler. A root
agent uses the storage ID; its forks and same-directory children use conversation
IDs within that storage. A child at a different directory receives a new storage
host with cwd-bound resources. Child conversations belong to native background
tasks, not to another ordinary primary.

Loading configured extension factories into cwd-bound public services does not
run an ordinary session lifecycle. Factories emit native capability bundles
through the [Durable contribution contract](durable-contributions.md). Only
those bundles execute inside Durable conversations. No shadow SessionManager
or synthetic primary registration exists there.

Owner-directed reports and results retain their source IDs in native documents.
The source storage's durable-delivery watcher is the sole retained-output
delivery owner: after every native commit it settles intents, routes each
unacknowledged receipt or report, and only then acknowledges the source. A
catalog owner receives a native follow-up in its own host. A noncatalog owner is
an ordinary primary reached through its registered primary channel. Only an
absent or proven-dead owner endpoint permits fallback: the watcher broadcasts
to every live primary within one bounded discovery of registered endpoints, and
each delivery is labeled `no live owning session` while the original owner
identity stays in the message details. It acknowledges the row only after
discovery and every delivery complete; a partial or unavailable scan leaves the
row pending and reports that coverage explicitly. A live or unknown endpoint
refuses fallback and retries. Delivery is at-least-once; the cross-host boundary
has no shared transaction and no general exactly-once promise. The manager does
not poll receipts. Delivery and task acceptance remain distinct. Footer text
grants no authority.

Configuration runs only on an idle conversation through its storage owner. An
explicit model is validated against the configured catalog and the requested
reasoning level is clamped; a failed model repair on attach returns the failure
instead of a status snapshot.

The agent dashboard observes native agent conversations. The real ordinary
primary remains outside Durable storage; the dashboard does not create a
lookalike conversation to claim equal-peer terminal support. See the
[agent extension](../../extensions/agent/README.md) for controls and limits.
