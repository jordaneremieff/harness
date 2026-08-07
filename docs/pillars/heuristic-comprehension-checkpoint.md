# Heuristic: Comprehension Checkpoint

## Recognition

This heuristic fires when broad reading is accumulating faster than a working model.

Cues:

- Several rounds of file or document reads have occurred without intermediate synthesis.
- Files are opened because they seem related rather than to answer a named question.
- Contradictions are noticed and deferred without deciding whether they matter.
- Coverage is cited as readiness, but component interactions cannot be explained concretely.
- An artifact is about to be written while important regions of the model remain "probably" or "roughly."
- The task requires cross-component or domain understanding rather than a local lookup.

No fixed file count proves the problem. The trigger is the gap between consumed input and articulated understanding.

## Move

1. **Stop reading.** Do not add more input until the current material has been synthesized.
2. **Articulate the model concretely.** State actors, state transitions, invariants, dependencies, and failure paths in ordinary language.
3. **List specific gaps.** Replace "understand this better" with questions whose answers would change the artifact.
4. **Resolve contradictions.** Classify each as naming drift, version difference, implementation defect, or a broken assumption.
5. **Read to answer.** Every next source should have a named question and a reason it is likely to answer it.
6. **Test comprehension before production.** Explain each load-bearing interaction without relying on vague labels or unexamined code structure.

Example:

```text
Known: records become eligible after their specific prerequisite identifier exists.
Unknown: whether eligibility is reevaluated on each result or only at batch end.
Contradiction: one test implies immediate reevaluation while a design note implies
batch gating. Next read: the state-transition handler and its tests.
```

## Negotiation

| Situation | Calibration |
|---|---|
| Unfamiliar, cross-system domain | Checkpoint early and often. |
| Familiar module with one bounded question | A checkpoint may be unnecessary. |
| Structural orientation through indexes and search | Gather the map first; synthesize before deep reads multiply. |
| Sequential history where order is the explanatory structure | Continue while periodically stating what changed and why. |
| Behavioral contradiction | Resolve immediately if it can alter the artifact. |
| Minor naming inconsistency | Record and defer if not load-bearing. |

## Why This Works

Reading adds input. Understanding requires constructing and testing relations among those inputs. Search and parallel reads create a strong progress signal because visible coverage rises, but they do not prove that the model can predict behavior or explain interactions.

Articulation externalizes the model. Specific gaps produce targeted investigation, and contradictions become diagnostic evidence rather than context noise. The checkpoint therefore converts breadth into a plan for depth.

This heuristic complements Coverage Calibration. One prevents under-sampling; the other prevents high input volume from masquerading as comprehension.

## When NOT to Apply

- A single source directly answers a bounded lookup.
- You are performing initial navigation rather than claiming understanding.
- A known structure is being inspected with explicit questions.
- The task is mechanical and preserves behavior.
- Stopping would interrupt a short, logically indivisible sequence; checkpoint at its end.

## Relationship to Pillars

- **AI-Native Expertise:** consumed input is not expertise until it supports a tested working model.
- **Cognitive Stratification:** the model and gaps belong in working memory, not merely in the transient stream of reads.
- **Grounding Preflight:** checks the conclusion boundary; Comprehension Checkpoint acts during intake and synthesis.
- **Coverage Calibration:** balances depth with breadth.
- **Circular Grounding:** understanding what code does does not establish what the domain requires.

## Summary

When reading expands without an explicit working model, stop, state what is known, name gaps and contradictions, and make every further read answer a specific question before producing the artifact.
