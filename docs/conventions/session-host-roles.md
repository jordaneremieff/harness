# Session host roles

The ordinary primary owns the Pi terminal and its extension lifecycle. It is a
client of Durable agent hosts, not their execution owner. Reload and shutdown
remove its delivery callbacks and client connections without stopping admitted
agent work. The primary registers one channel over the package-level Chord
Unix transport. A private 0700 directory and an owner-only 0600 socket
provide local filesystem admission. Writer and observation identities cross
that boundary as protocol data, not authentication credentials. The exact
expected Chord hello name identifies the target, not the peer's user identity. That channel returns peer messages and answers project-trust
prompts. The [Agent host contract](../agent-host-contract.md#chord-wire-contract)
defines the shared typed Endpoint and Feed for its clients. A client that
observes a native conversation does not create a new instruction role, change
its creator, or replace request-local requester and reply routes. Closing a
client releases its observations, not the native conversation or its admitted
work.

One independent process owns each Durable storage. It holds a Darwin descriptor
lease on a permanent private inode before storage opens, and it alone resumes
the native scheduler. The inode's record is diagnostic, not PID-based
ownership. After runtime closure and socket removal, the holder writes its
validated generation end through the held descriptor, then closes it. An ended
record proves only that generation's end, never global absence, release of a
replacement, or permission for recovery or deletion. A failed end write retains
exclusion until actual process exit. A new holder clears the end marker. An acquiring control
attaches first, then lets a runner contend for the lease; a busy runner opens no
runtime. The current endpoint's hello carries the server's per-run writer identity separately from its static operation contract. Only a match with validated readiness from the exact owned launch supplies a child-exit source for automatic recovery. A foreign endpoint remains attachable without that authority. Initial and later
change frames bind its latest successful bounded publication to that writer.
Connected roster rows use that snapshot without a catalogue socket probe. Link
loss, rebind and close invalidate it; unknown metadata never counts as active.
A qualified clean end for the exact foreign writer is expected retirement, not
a recovery fault. Catalogue work markers do not override a known loss refusal; explicit attachment and primary registration retain their separate recovery roles. This exclusion contract covers cooperating writers on a private local
macOS filesystem, not network/shared filesystems or uncooperative writers. A root
agent uses the storage ID; its forks and same-directory agents use conversation
IDs within that storage. An agent at a different directory receives a new
storage host with cwd-bound resources. Created conversations belong to native
background tasks, not to another ordinary primary. Creation records and fork
ancestry describe provenance, not result dependencies or current request routes.
Native awaited results retain the original request; the ordinary primary stays
responsive. Semantic awaiting facts are separate from native task state.
The selected-run release returns partial results without dispatch or producer
cancellation; a real abort still stops the original request. A run stop uses
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
receives only its own rows through its registered primary channel. The watcher
acknowledges only accepted owner routes, independently of other routes.
Admission is not model consumption or task acceptance.

A row for an ordinary primary waits at its source when the owner's endpoint is
absent, dead, unverified, or incompatible, when its endpoint publishes no
session file, or when its published session file does not yet exist. No other
session receives the row. The receiver refuses misaddressed rows and copies
before they affect the session. It also refuses a fresh delivery without a valid
saved transcript. A refusal of one row's content parks that row; a refusal about
the session parks the owner's rows. Either holds only while the owner's facts
equal those of the refused attempt, and an explicit refresh lifts it. A
transient transport failure retries; it is not proof of death.

Pending delivery and active delivery differ. Parked and terminal rows remain
durable without a delivery retry timer. Those rows neither retain the recovery
marker nor prevent otherwise idle host retirement. Native work, pending
admissions, active rows, in-flight effects, controls, and observations still
prevent normal retirement. Explicit release closes observations only on a
successful retirement seal; it never cancels native tasks or deletes retained
rows. New admissions, pending native work and active delivery rows cancel the
release and restore normal idle retirement without closing observations.
Delivery scans, read-only requests and generation-only races leave the release
pending for the next activity or quiescent event.
The source writer publishes a bounded parked-recipient sidecar before clearing
its recovery marker. An exact primary registration, its first saved transcript,
or a newly available named recipient wakes the matching source through bounded
catalogue scans. Unrelated registration does not relaunch parked-only hosts. Sidecars stay
outside the catalogue directory; only their source writer changes them.

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
