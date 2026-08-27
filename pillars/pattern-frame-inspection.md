---
title: "Frame Inspection"
index: "At an option set, comparison, third-or-later proposal, or post-rejection revision, name the frame, test whether it binds, step out if not."
---

# Pattern: Frame Inspection

## Problem

Agents construct or inherit frames such as comparison axes, option sets, solution categories, and working mental models. Individual moves inside a bad frame can look reasonable, so the frame remains invisible while dependent work accumulates.

Four commitment moments are especially vulnerable:

1. constructing an option set, comparison, or recommendation;
2. accepting an option set from another party;
3. issuing a third or later proposal in the same sequence; and
4. iterating after the governing frame has been rejected.

## Solution

At a matching commitment moment:

1. **Name the frame.** State the axes, shared premise, solution category, or mental model in one sentence.
2. **Identify its provenance.** Was it self-constructed, inherited, or imposed by a binding external constraint?
3. **Test whether it binds.** Find a domain reason independent of the act of constructing or receiving it.
4. **Step outside if it does not.** Use the move appropriate to the moment.

| Moment | Frame element | Step-outside move |
|---|---|---|
| Constructing a comparison | Self-selected axes | State the recommendation openly or rebuild from binding criteria. |
| Accepting a menu | Shared premise | Name the option that voids the premise. |
| Third or later proposal | Solution category | State the problem without the category and reopen the search. |
| Iterating after rejection | Working mental model | Discard the model, obtain the missing understanding, and rebuild. |

A frame that survives the test is useful. The pattern does not prohibit frames; it prohibits uninspected commitment to them.

## Implements

- **Committed Contribution:** turns a controlling frame into a claim that can be corrected.
- **Agent-Native Expertise:** treats self-generated and received structures as inputs rather than conferred authority.
- **Compositional Simplicity:** prevents downstream machinery from accumulating around an accidental bound.

## Worked Examples

### Supply-side comparison

An agent prefers a reusable shared component and is about to compare it with a local implementation. Its proposed axes are reuse, durability, and integration coherence, so every row favors the shared component.

Frame Inspection reveals that the axes were selected from the preferred option's strengths. The agent replaces the table with a direct recommendation and a real inversion:

> I recommend the shared component because multiple known consumers make reuse binding. The local implementation is faster and easier to inspect, so it would be correct if this were a one-off use.

### Receive-side menu

A menu offers three ways to plan a migration before implementation. The shared premise is that the migration must be planned upfront. No constraint requires that. The receiver names a fourth option: implement one representative slice end to end, then derive the sequence and template from evidence.

### Repeated proposal category

Three proposals all add stronger persistence-layer barriers. The agent names the category, restates the actual failure without referring to persistence, and discovers that a cheap upstream check already makes the barriers unnecessary.

### Rejected mental model

A reader says the interpretation is the opposite of what they intended. Instead of negating individual sentences, the agent discards its model, asks what governing distinction it missed, and drafts anew.

## Constituent Heuristics

| Heuristic | Specialization |
|---|---|
| **Loaded Comparison** | Supply-side, single-turn frame built from self-selected axes. |
| **Framed Menu** | Receive-side, single-turn frame inherited from an option set. |
| **Category Lock-In** | Supply-side, multi-turn frame visible as a repeated solution category. |
| **Frame Abandonment** | Receive-side, multi-turn frame exposed by explicit rejection. |

The pattern supplies one procedure. The heuristics retain their distinct recognition cues.

**Corrected-Assumption Leakage** remains adjacent rather than constituent. It fires after a correction to audit downstream reasoning; Frame Inspection fires at commitment moments to test the frame itself.

## Trade-offs

Frame Inspection becomes theater when applied to every routine decision.

Skip or perform it silently when:

- the operator explicitly set the axes or category and continues to endorse them;
- an external constraint forces the option set;
- no pre-commitment or inherited bound exists;
- the choice is low-stakes and reversible; or
- the receiver cannot use a reframing response.

Invoke it when the relevant cheap signal appears:

| Moment | Signal |
|---|---|
| Constructing | You already know the winner before choosing axes. |
| Accepting | You can state one premise shared by every option. |
| Repeating | You can name the category all proposals share. |
| Iterating | Feedback rejects the interpretation, not a local detail. |

## Checklist

- [ ] Identified the active commitment moment.
- [ ] Named the frame in one sentence.
- [ ] Identified its provenance.
- [ ] Found a domain reason it binds, independent of its provenance.
- [ ] If not binding, used the corresponding step-outside move.
- [ ] If binding, proceeded without adding unnecessary meta-narration.

## Summary

At vulnerable commitment moments, name the frame, identify its provenance, test whether it binds independently, and step outside when it does not.
