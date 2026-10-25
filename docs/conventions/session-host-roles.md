# Session host roles

The ordinary primary owns the Pi terminal and its extension lifecycle. It is a
client of Durable agent hosts, not their execution owner. Reload and shutdown
remove its delivery callbacks and client connections without stopping admitted
agent work. The primary registers one channel over the package-level Chord
Unix transport. A private 0700 directory and an owner-only 0600 socket
provide local filesystem admission; no token crosses that boundary. The exact
expected Chord hello name identifies the target, not the peer's user identity. That channel returns peer messages and answers project-trust
prompts. The [Agent host contract](../agent-host-contract.md#chord-wire-contract)
defines the shared typed Endpoint and Feed for terminal and browser consumers.

An operator also uses a native conversation directly through a browser. That
selection does not create a new instruction role, change its creator, or replace
request-local requester and reply routes. Closing the browser releases its
client observations, not the native conversation or its admitted work.

A managed namespace binds one catalogue root to its selected Agent source and
Pi dependency installation. Runtime supervises an Agent-owned namespace recovery
process independently of UI assets and provider availability. That process uses
the existing catalogue recovery and exclusive host acquisition. It registers no
ordinary primary and holds no second task index. New and retained namespaces
keep their own source routes. See
[native namespace creation and recovery](../agent-host-contract.md#native-namespace-creation-and-recovery).

One independent process owns each Durable storage. It takes the exclusive writer
claim before storage opens, and it alone resumes the native scheduler. A root
agent uses the storage ID; its forks and same-directory agents use conversation
IDs within that storage. An agent at a different directory receives a new
storage host with cwd-bound resources. Created conversations belong to native
background tasks, not to another ordinary primary. Creation records and fork
ancestry describe provenance, not result dependencies or current request routes.
Native awaited results retain the original request; the ordinary primary stays
responsive. Semantic awaiting facts are separate from native task state.
The selected-run release returns partial results without dispatch or producer
cancellation; a real abort still stops the original request. Browser Stop uses
native admitted-input identities across generation handovers, with an exact-input
guard for independently shared delegated work. Original admitted inputs still
identify surviving descendants after an intermediate agent answers. Newer unrelated
work in that agent remains untouched. It never treats a stale task ID as
permission to abort whatever work is now current. Native compaction does not
first abort work or withdraw queued inputs.

Loading configured extension factories into cwd-bound public services does not
run an ordinary session lifecycle. Factories emit native capability bundles
through the [Durable contribution contract](durable-contributions.md). Only
those bundles execute inside Durable conversations. No shadow SessionManager
or synthetic primary registration exists there.

Owner-directed reports and results retain their source IDs in native documents.
The source storage's durable-delivery watcher owns retained-output delivery. After
native commits it settles intents and routes unacknowledged receipts and reports.
A catalog owner receives native input in its own host; an ordinary primary
receives it through its registered primary channel. The watcher acknowledges
only accepted normal-owner routes, independently of other routes. Admission is
not model consumption or task acceptance.

Only an absent or proven-dead ordinary-owner endpoint permits informational
fallback copies to other registered primaries. The watcher requires complete
bounded discovery before copies, excludes the normal owners, and labels copies
`no live owning session` while retaining the original owner identity. It records
each accepted copy recipient, but copies never acknowledge the original owner's
row. Incomplete discovery refuses copies and reports that limit. Copy failures
also leave owner delivery pending. Direct thread notifications stay pending
without broadcast when their recipient has no live endpoint. Live, unknown, and
incompatible endpoints do not justify fallback; transport failure is not proof
of death.

Pending delivery and active delivery differ. Rows for proven-dead ordinary
owners remain durable without a delivery retry timer. Those rows retain the
recovery marker but alone do not prevent otherwise idle host retirement. Native
work, unsettled intents, in-flight effects, controls, and observations still
prevent retirement. An absent or unknown endpoint is not the proven-dead case.

Delivery is at-least-once. The cross-host boundary has no shared transaction or
general exactly-once promise. The manager does not poll receipts, and footer
text grants no authority. See the [agent extension](../../extensions/agent/README.md)
for delivery controls and limits.

Configuration runs only on an idle conversation through its storage owner. An
explicit model is validated against the configured catalog and the requested
reasoning level is clamped; a failed model repair on attach returns the failure
instead of a status snapshot.

The agent dashboard observes native agent conversations. The real ordinary
primary remains outside Durable storage; the dashboard does not create a
lookalike conversation to claim equal-peer terminal support. See the
[agent extension](../../extensions/agent/README.md) for controls and limits.
