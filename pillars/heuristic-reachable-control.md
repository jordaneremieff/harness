---
title: "Reachable Control"
index: "Work state, resource limits, handoffs or background traffic threaten authorised direction from a person or a coordinating agent → preserve a usable way to communicate and intervene, keeping the operator's path first."
---

# Heuristic: Reachable Control

## Recognition

This heuristic fires when a workflow, state transition, resource rule or delegation arrangement threatens a directing party's practical ability to inspect, stop, redirect or communicate about work it is authorised to direct. A directing party is a person, such as the operator or a requester, or a coordinating agent: an agent that directs work it delegated, within the bounds of that delegation.

Cues:

- Busy, waiting or degraded work removes the permitted input or cancellation path.
- A delegated worker accepts no correction until its current run ends.
- A capacity limit blocks new work and also removes the means to direct recovery.
- Background reports displace a question or response the directing party needs to read.
- Agent traffic, such as worker reports or a coordinator's instructions, displaces a question or answer the operator needs.
- A handoff changes the responsible destination before the directing party can find and address it.
- An unrelated save, read or refresh must succeed before the directing party can communicate a correction.

A path is usable only if the directing party can find it, understand its effect and reach the intended destination. Its mere presence does not establish those properties. For a coordinating agent, finding the path means having an addressable destination, and understanding its effect means knowing whether an input corrects the current work or queues new work.

## Move

1. Identify the work, its responsible destination, each directing party and the interventions each is authorised to make. A coordinating agent's authority comes from its delegation and stays within the operator's. Preserve that authority boundary.
2. Separate admitting or executing work from accepting direction about it. A resource limit or busy state need not eliminate safe communication, inspection and recovery.
3. Keep the responsible destination and pending dialogue with a person reachable ahead of agent traffic. Retain useful reports without letting routine activity displace the question or response needed to direct the work. A path that reaches a coordinating agent does not satisfy this step for the operator. The operator's direction may pass through a coordinator only if it still reaches the work in the affected state.
4. Check the meaningful action in the affected state, not merely the control's presence while idle. During handoff, check that the directing party can find and address the replacement before treating the transfer of control as complete.
5. If an action cannot take effect safely or the transport cannot deliver it, state that specific boundary and preserve the safe alternatives that remain. Distinguish received direction from completed action.

Use an existing adequate path. This heuristic does not require a second control surface, a central coordinator or continuous supervision by a person or a coordinating agent.

## Why This Works

Authority has little practical effect when the system's own work makes the direction path unusable. Preserving that path lets the directing party change priorities or respond to an unexpected state without first needing the blocked work to finish successfully.

Delegation repeats this structure one level down. A coordinating agent that cannot reach a busy worker cannot redirect work whose priority has changed, and operator direction that passes through that coordinator stalls with it. The coordinator's path serves the operator's direction; it does not replace the operator's own path.

The requirement concerns continued influence over the work, not exposure of every mechanical step. Automation can remain autonomous while the directing party retains a usable way to intervene.

## When NOT to Apply

- The requested intervention exceeds the directing party's authority, including the bounds of its delegation, or a binding restriction.
- The relevant path is already usable and the change does not threaten it.
- The work is complete and no continuing decision or recovery requires direction.
- The unavailable feature does not affect permitted influence over the work.
- The other agent is an independent peer with no delegated authority over the work. Concurrent Work Discovery and Governing Context govern that contact.

Legitimate resource and safety limits remain binding. An operation that cannot stop safely need not promise an immediate stop. An unavailable transport must not be represented by a cosmetic control. Preserve the remaining permitted path and make its effect clear.

## Relationship to Other Pillars

System Autonomy assigns deterministic mechanism to the system and judgment to the agent. Reachable Control preserves the directing party's practical ability to exercise authorised judgment while that mechanism runs.

Governing Context preserves the understanding needed for integration and dependent decisions. Reachable Control preserves the directing party's usable route to direct that continuation.

Message Role Mapping governs the force of carried direction: a coordinating agent's direction carries the operator's grant within its scope, and the operator's later correction governs. Reachable Control keeps the path by which each direction reaches the work.

Verification Reach checks whether evidence establishes that the control performs the claimed action in the relevant state.

Burden Absorption removes the effort of mechanical waiting. Reachable Control prevents that wait from removing permitted influence.

Committed Contribution keeps claims open to correction. Reachable Control also covers stopping or redirecting work whose claims are sound but whose priority has changed.
