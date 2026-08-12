# Heuristic: Category Lock-In

## Recognition

This heuristic fires when:

1. You are issuing a third or later proposal for the same problem.
2. The proposals are all members of one nameable solution category.
3. Feedback has changed individual proposals but not the category.
4. Continued use of the category has not been grounded in a binding domain requirement or explicit operator decision.

Cues:

- Each new proposal is a more elaborate member of the same family.
- Pushback becomes more meta while revisions remain local.
- You can state the category more easily than the underlying problem.
- Alternatives are searched only inside the category's vocabulary.
- The latest proposal preserves the same ownership boundary, storage layer, or mechanism despite repeated discomfort.

## Move

1. **Name the category.** Make the shared family visible.
2. **Restate the problem without category vocabulary.** Describe desired outcome, constraints, and failure cost.
3. **Trace category provenance.** Was it required by the domain, supplied by the operator, or activated by a familiar association?
4. **Ask the meta-question.** Is feedback rejecting members, the category, or the problem framing beneath it?
5. **Generate outside candidates.** Include doing less, moving the responsibility, using an existing capability, or changing the constraint.
6. **Return only when justified.** If the category survives, explain the domain reason rather than the number of variants explored.

Example:

```text
All three proposals enforce uniqueness in persistent storage. The actual need is
to avoid an expensive duplicate side effect. Persistent enforcement is not a
stated requirement, and the upstream operation already exposes a cheap lookup.
Reopen the problem around duplicate cost and existing mitigation.
```

## Negotiation

| Situation | Response |
|---|---|
| The category is mandated by a binding requirement | Continue inside it and make the requirement explicit. |
| Feedback clearly rejects only one member | Iterate locally; do not abandon a sound category prematurely. |
| Two proposals share a category | Watch for lock-in, but count alone is not enough. |
| A third proposal is requested explicitly | Supply it, while noting if the category itself appears questionable. |
| Outside candidates violate known constraints | Keep the category and document the exclusion. |
| The problem statement itself is unstable | Use Frame Abandonment rather than only widening the solution search. |

The proposal count is a trigger for inspection, not proof of error.

## Why This Works

Familiar problem classes activate familiar solution families. Once a category is active, local feedback is naturally interpreted as guidance for the next member. Every iteration appears responsive while the more consequential choice, the category itself, remains unexamined.

Naming the category converts it from an invisible search boundary into a claim. Restating the problem without its vocabulary reveals whether the category was doing analytical work or merely shaping the language.

## When NOT to Apply

- The category follows directly from a binding standard, interface, or operator decision.
- The proposal sequence is deliberately exploring members before comparing families.
- Feedback explicitly confirms the category and requests another member.
- The category is broad enough that the proposals represent genuinely different mechanisms.
- A local correction clearly resolves the observed failure.

## Relationship to Pillars

- **Frame Inspection:** Category Lock-In is the supply-side, multi-turn specialization.
- **Context Calibration:** tests whether the category was inherited from a different source context.
- **Frame Abandonment:** fires when the underlying mental model has been rejected; Category Lock-In catches a stealthier sequence before explicit frame rejection.
- **Failure Cost Calibration:** often supplies the category-free restatement for reliability machinery.
- **Tell Laundering:** sibling mechanism at prose altitude: surface variation can preserve an unchanged underlying category.

## Summary

When repeated proposals stay inside one family, name the category, restate the problem without it, and test whether the domain requires the category before proposing another member.
