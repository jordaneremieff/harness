# Managed session host identity

A native session hosted by another session is not an independent primary.
Registering it as a primary would admit unrelated completion turns during its
startup and let child sessions keep their own parent manager alive at shutdown.

The agent extension owns ordinary session hosts and their ownership associations.
It checks its managed-host records before primary registration and restart.
A managed child keeps its owner; loading extensions in that child does not turn
it into another primary. Native session identity, not mode or transcript ancestry,
selects the managed-host record. Footer status text supplies no control authority.

The owner remembers which sessions it actually registered as primaries.
Shutdown removes only those registrations. Ownership associations and
owner-directed result delivery remain part of the
[agent extension](../../extensions/agent/README.md), not a separate worker
protocol or store.
