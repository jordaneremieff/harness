# Session host roles

The ordinary primary owns the Pi terminal and its extension lifecycle. It is a
client of Durable agent hosts, not their execution owner. Reload and shutdown
remove its delivery callbacks and client connections without stopping admitted
agent work.

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
An ordinary primary acknowledges a source after it submits the native message.
A Durable owner receives a native follow-up with a stable request ID before
acknowledgement; native admission deduplicates retries. The cross-host boundary
has no shared transaction and no general exactly-once promise.
Delivery and task acceptance remain distinct. Footer text grants no authority.

The agent dashboard observes native agent conversations. The real ordinary
primary remains outside Durable storage; the dashboard does not create a
lookalike conversation to claim equal-peer terminal support. See the
[agent extension](../../extensions/agent/README.md) for controls and limits.
