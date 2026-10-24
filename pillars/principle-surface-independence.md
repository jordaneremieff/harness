---
title: "Surface Independence"
index: "Operational meaning and lifetime determine a capability's home; its current interface does not."
---

# Principle: Surface Independence

## Statement

Operational meaning and lifetime determine a capability's home; its current interface does not. An operation that must remain useful across changes of interface belongs with the system that owns that operation. Interfaces present and invoke its public contract rather than become its sole owner.

An operational capability is an action, policy or durable state with meaning beyond its presentation. An interface is a way to present and invoke it, such as a graphical client, terminal client or API adapter. Rendering, layout, local wording and device interaction normally belong to the interface itself.

## Core

| Question | Implication |
|---|---|
| Must the operation remain usable if this interface is replaced? | Its contract and required state need an independent home. |
| Does another operational mode need the same action, policy or state? | Let those modes use one operational contract rather than parallel policies. |
| Must configuration or state survive the interface? | Keep it with the capability whose lifetime it follows. |
| Must recovery work despite a specified interface failure? | Keep that recovery route independent of the failure it must address. |
| Is the behaviour intrinsically presentation or device interaction? | Keep it in the interface. |
| Does no independent lifetime, cross-mode need, surviving state or recovery requirement exist? | This principle does not require relocation. Compare total cost under Compositional Simplicity. |

Specify operational contracts in terms of their job, authority and lifecycle, not the incidental layout or private implementation of their first interface. This permits another mode to adopt the contract without requiring speculative features for imagined consumers.

Absorb common operational complexity at its proper owner. When a relevant platform contract changes, adapt at that shared boundary rather than accumulate separate interface-specific policies. Preserve binding constraints and safe transitions; independence does not require adopting every upstream change.

## Rationale

An interface can change or fail while the operation behind it remains necessary. If that interface solely owns the operation, replacement can strand configuration, another mode can acquire a divergent policy, or recovery can require the component that is broken.

A coherent operational home separates those lifetimes. It does not guarantee low cost, successful recovery or good presentation. Those properties still need design and evidence.

## Shape

Interfaces adapt a public contract. The operational owner holds the lasting policy, state and lifecycle. Where recovery must survive an interface failure, its invocation route does not depend on that interface.

These are logical responsibilities, not a required service topology. One small module can supply the operational boundary. A server inside the same failed product does not by itself establish recovery independence.

## Design Implications

1. Specify the operational role, authority, state and required lifetime. A neutral function name alone does not establish an independent role.
2. Check the existing public operation and its owner. One interface's limit does not establish a missing system capability.
3. Place the lasting contract, policy and state at the lowest sufficient layer that owns the operation and does not require the presenting interface.
4. Let interfaces adapt that contract. Keep layout, device interaction and local presentation there rather than copy operational policy or parse another interface's private output.
5. Where recovery must survive a specified failure, name its host, process and transport dependencies. Keep the route independent of that failure, not of every imaginable failure.
6. Test the requirement that applies. After interface replacement, do the operation and required state remain coherent and callable? Across modes, do they use the intended common policy? Under the specified failure, is required recovery still invocable? Verify the public operation and usable route, not code placement alone.

If a required public operation is missing, name that boundary. An interface-local substitute does not satisfy an independent-lifetime requirement merely because it closes the visible gap.

## Tensions and Limits

A credible operational home does not require a demonstrated second consumer. Nor does it prove that a capability deserves construction. Harness Over Architecture governs that decision, including bounded exploration where useful behaviour becomes discoverable only after a capability exists.

Shared contracts have costs and can freeze a poor abstraction. A small neutral module may be sufficient; a new service, registry or deployment boundary needs its own justification. Do not duplicate an existing platform capability.

Interfaces need not expose identical controls or grant identical access. They can offer different authorised operations while sharing the policy and state of operations they do expose.

A disposable prototype may remain local. If it becomes ordinary infrastructure, reconsider its ownership rather than silently retain a temporary arrangement.

Presentation-specific behaviour stays local. A binding security, platform or ownership constraint can require another placement or prohibit exposure through a particular interface.

## Relationship to Other Pillars

Intrinsic Organization gives knowledge an identity independent of its consumers. Surface Independence concerns the ownership and lifetime of callable operations, policy and state.

System Autonomy separates intent from deterministic mechanism. Compositional Simplicity counts the cost of the whole arrangement. Neither alone supplies the interface-replacement and recovery tests.

Harness Over Architecture governs construction and its scale. Live Substrate Exposure governs safe changes to running consumers. Reachable Control tests whether the authorised person can actually find and use the resulting direction path.
