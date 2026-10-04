---
title: "Concurrent Work Discovery"
index: "A consequential action affects a shared substrate while relevant concurrent activity is unknown → use bounded discovery before acting."
---

# Heuristic: Concurrent Work Discovery

## Recognition

This heuristic fires before a consequential action on a shared substrate used by independently active agents, when their relevant current activity is unknown.

A shared substrate is a place or resource where efforts encounter or affect the same work, state, or capacity. The action is consequential when it can materially change another effort's usable work, next decision, or access to that capacity. Mere presence in the same directory does not establish such a dependency.

Cues:

- A shared change is about to be published or activated without current awareness of other work it affects.
- An operation will consume shared capacity that other active efforts also need.
- The plan treats the local session's view as the complete account of current work.
- Clean local state is being taken as evidence that no other effort is active.

No collision or unexplained dirty state is required for this cue.

## Move

1. **Identify the shared consequence.** Name the substrate and the other work or capacity the action can affect. Keep the discovery scope tied to that consequence.
2. **Use bounded current discovery.** Consult the available presence or work view before the action. A current view already supplied by the system satisfies this step; do not require an extra call merely to repeat it. Retrieve further detail only where a relevant gap changes the decision.
3. **Preserve the evidence limits.** Keep unavailable information, stale records, and no relevant activity found within the checked scope distinct. Registration, process existence, current intent, and reachability establish different facts. A dated notice describes a past change, not necessarily a current commitment. Incomplete discovery does not establish absence.
4. **Exchange intent where a dependency matters.** Obtain the relevant purpose, next consequential act, restrictions, and contact route. Coordinate the dependent action within existing grants. Use Governing Context when the exchange needs a shared decision frame; leave independent work independent.
5. **Recheck when the basis changes.** A changed plan, newly active effort, or changed shared state can invalidate the earlier view. Refresh what matters before the dependent action, not through continuous monitoring of all activity.

Discovery grants no control over another effort. A declaration of intent is not an exclusive claim, permission to publish someone else's work, or proof that the action occurred.

## Negotiation

| Condition | Response |
|---|---|
| The current view already covers the relevant activity | Use it; do not duplicate discovery or contact. |
| Another effort is active but no dependency affects this action | Continue independently; contact is not compulsory. |
| Relevant work exists but its next act is unclear | Ask for the missing intent or condition, not the entire conversation. |
| Discovery is unavailable, stale, or incomplete | Keep activity unknown; use available evidence and the action's consequences to decide what can proceed. Continue independent authorized work; hold only an action that needs unresolved authority or coordination to proceed safely. |
| An operation already has concurrency protection | Retain that protection; decide whether any dependency remains outside what it protects. Awareness does not replace the operation's checks. |

## Why This Works

Independently active efforts can reach the same shared state without prior contact. Discovering that relationship before acting makes intent and dependencies available for a coordination decision rather than leaving them to be reconstructed after a conflict.

The expected benefit comes from relevant information guiding a dependent decision, not from more messages or a larger roster. Bounded discovery constrains the information requested; it does not establish that coordination costs less than independent work and repair. Judge its value against the attention and communication it consumes. Mechanical presence and freshness handling belong in the system rather than a recurring agent checklist.

## When NOT to Apply

- The action does not materially affect shared work, a dependent decision, or shared capacity.
- Relevant activity and dependencies are already current and understood.
- Existing isolation or operation-level coordination fully covers the action's relevant effects.

This heuristic does not require a new registry, a fixed polling interval, contact with every discovered agent, or an operator approval for ordinary coordination within existing authority.

## Relationship to Pillars

- **[Phantom Stewardship](heuristic-phantom-stewardship.md):** handles encountered dirty state and uncertain return continuity; discovery here can be needed before any residue appears.
- **[Coordination Phantom](heuristic-coordination-phantom.md):** tests the parties required by an imported convention; this heuristic starts from a consequential shared action whose relevant activity is unknown.
- **[Governing Context](heuristic-governing-context.md):** preserves the frame needed when discovered efforts become interdependent.
- **[System Autonomy](principle-system-autonomy.md):** places mechanical discovery and freshness below the autonomy boundary while leaving relevance and coordination choices to agent judgment.
- **[Message Role Mapping](pattern-message-role-mapping.md):** keeps observed activity, declared intent, and faithfully carried authority distinct.

## Summary

Before a consequential shared action, use bounded discovery to resolve relevant unknown activity, exchange intent where a dependency matters, and preserve independent work and authority.
