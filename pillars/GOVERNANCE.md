# Pillars — Governance

Operating rules for the pillar corpus defined in [README.md](README.md). This
file is the durable home of the corpus contract: it survives delivery-surface
regeneration, and no adapter may restate it.

## Document Types

| Type | Purpose | Lifespan |
|---|---|---|
| `principle-*.md` | Core beliefs about systems, knowledge, and contribution | Evergreen |
| `pattern-*.md` | Structural procedures embodying principles | Evergreen |
| `heuristic-*.md` | Context-dependent recognition-to-move guidance | Evergreen |

Heuristics are evergreen documents that fire situationally: they apply when
their recognition condition matches and is not defeated. No document type has
automatic precedence over another.

## Application Contract

1. Match the current judgment moment to explicit recognition conditions.
2. A match creates a rebuttable obligation in the **decision procedure**: apply the guidance or identify the fact, binding constraint, inversion, sibling, carve-out, or contradiction that defeats it.
3. System and safety instructions, law, permissions, and explicit operator authority remain separate higher constraints.
4. Resolve apparent collisions by checking facts, source authority, recognition scope, and stated carve-outs. Do not resolve them by document type. If consequential guidance still conflicts, record a composition ambiguity and obtain the appropriate authority rather than inventing precedence.
5. Application may change a decision or stabilize an already-correct one. Citation, naming, retrieval, and doctrinal vocabulary do not prove application.
6. Routine work need not narrate doctrine. Name the governing pillar when the operator requests a Pillars evaluation, when a consequential distinction needs auditability, or when explaining a material override.
7. Consult the smallest relevant set. Full-corpus recital is not compliance.
8. Doctrine does not inherit across sessions, processes, subagents, or graders. Supply is a delivery act governed by [Supplying doctrine to subagents](#supplying-doctrine-to-subagents) below.
9. Version-attributed observations, evaluations, evolution decisions, and citation grades must identify the doctrine snapshot and actual delivery profile under the source-envelope rule in the supply section below. Ordinary use need not log consultation.
10. Reality can expose a doctrine defect. Use contradiction handling and operator-approved governance rather than forcing compliance.

## Consultation Procedure

1. Read [README.md](README.md) first. Its rows quote each entry's own `index`
   sentence; treat them as a shortlist, never as complete recognition rules and
   never as evidence that no pillar applies.
2. If your situation's vocabulary misses every index line, grep entry bodies
   using the situation's nouns and verbs — for example term families such as
   `ask question escalate guess clarify` for investigation moments,
   `repeat iterate revision` for loops. A zero-hit result is not proof of
   absence either; inspect plausible Recognition sections before concluding.
3. Load only the few documents whose Statement, Core, or Decision Heuristic
   (principles), Intent, Problem, or Solution (patterns), or Recognition or
   Move (heuristics) match.
4. Decide whether each match binds or is defeated under the application
   contract. State why a plausible sibling does not bind when the distinction
   matters.
5. Apply the result to the artifact or decision. Do not stop at naming the
   doctrine.
6. Narrate only under item 6 of the application contract.
7. A forwarded excerpt from another conversation re-grounds deterministically:
   exact-quote search (`rg -F`) against README.md resolves it to its live entry.
8. If reality contradicts the doctrine, classify the contradiction rather than
   forcing compliance.

## Supplying doctrine to subagents

Doctrine does not silently cross a process boundary. These rules apply at every
fresh dispatch boundary, including steering messages that introduce doctrine,
worker results intended for onward use, and nested dispatches.

1. **Supply unit.** To have a worker apply a pillar, state its canonical name
   and a path reachable from the worker's working directory. That pair is the
   sanctioned unit. The worker loads the file before relying on it; the live
   file wins over any quotation.
2. **Quotes are hints.** An index sentence copied into a brief may travel only
   labelled as a parent-context quote, unverified against the worker's
   checkout. It is a retrieval hint and a drift detector, never the applied
   text.
3. **Name-only fallback.** A parent that cannot supply a path names the pillar
   with its type word (principle, pattern, heuristic) plus canonical name. The
   worker locates the live entry through the inventory before relying on it.
4. **Absent mode.** Check once whether the corpus is reachable. When it is
   not, do not load corpus paths and do not invent content; treat affected
   pillars as unknown and say so. Absence of corpus files is not evidence that
   no pillar applies.
5. **No silent inheritance.** A brief that neither supplies a pillar nor asks
   the worker to apply or check doctrine creates no consultation obligation.
   Supply, or an explicit request to apply or check doctrine, opens the
   consultation procedure against the live corpus. Which pillars the parent
   lists is coordinator judgment under item 7 of the application contract;
   this block does not close the sibling set, and omission is never evidence
   the corpus lacks a pillar.
6. **Pasted prose is not supply.** Text without a canonical name or reachable
   path carries no doctrinal authority inside the worker. A name that resolves
   nowhere is unknown, not a new pillar; derivation follows the mutation rules.
7. **Graders re-derive.** A worker grading compliance with doctrine derives
   the relevant-pillar set itself from the artifact and the live inventory. It
   treats a supplied list as a starting hypothesis from one posterior, not as
   the audit universe.
8. **Source envelope.** Work that quotes another revision, grades citations,
   or reviews a changing target names its doctrine snapshot (commit, tree, or
   "pasted draft in this task") and its delivery profile (named-file read,
   quoted excerpt, bounded-head shortlist, armory-only). Results intended for
   onward use return the complete unit and envelope; every nested fresh
   dispatch resupplies them. A continued worker rereads named files before
   making current-corpus claims.
9. **Pillar application requires the body.** The detachable unit identifies
   and locates an entry; conditions, moves, exceptions, negotiations, and
   relationships live in the body and must be read before application. Where
   repository access is impossible, the parent supplies the load-bearing body
   text explicitly labelled as pasted.

## Contradiction Handling

When an implementation or decision appears to violate a pillar, classify the difference.

### Acceptable

| Type | Meaning |
|---|---|
| Escape hatch | A deliberate, bounded override for a special case. |
| Different concern | The implementation tracks a dimension the pillar does not govern. |
| Genuine ambiguity | The situation requires judgment and the chosen trade-off is documented. |

### Requires Action

| Type | Action |
|---|---|
| Bug | Fix the implementation. |
| Design drift | Realign or document an explicit decision to diverge. |
| Missing pattern | Derive the structural rule that resolves the recurring tension. |
| Doctrine defect | Revise the pillar through operator-approved mutation rather than rationalizing around it. |

### Falsification

A recorded application that contradicts a pillar's prediction defeats the pillar. The contradiction is evidence, not rationalization material: respond through the doctrine-defect row above and revise the pillar through operator-approved mutation. The corpus keeps no application-incident log; falsification evidence must come from operator-recorded applications or a named delivery profile. Doctrine is normative by operator authority; predictive verification is not yet established.

## Common Composition Paths

### Research and Synthesis

1. **Triangulated Truth** asks which independent facets the conclusion requires.
2. **Epistemological Grounding** classifies defining versus claiming sources within those facets.
3. **Grounding Preflight** sequences the applicable conclusion checks before delivery.
4. **Verification Reach** ensures each check reaches the defining layer of its claim.
5. **Coverage Calibration** calibrates claim strength to the examined share of each reached layer.

### Proposal and Design

1. **Context Calibration** tests inherited defaults.
2. **Frame Inspection** tests the option frame.
3. **Category Lock-In** fires when iteration stays inside one category.
4. **Failure Cost Calibration** matches mechanism caliber to real consequences.
5. **Compositional Simplicity** evaluates the whole system rather than one component.

### Prose Repair

1. **Unearned Prose** supplies the register core (Position and Portability); **Tell Laundering** repairs the rhetorical move above a flagged surface form.
2. **Committed Contribution** checks claim ownership and correction posture.
3. Verification pillars handle unsupported claims separately from style quality.

### Shared Mutable State

1. **Phantom Stewardship** verifies whether the prior author is truly absent and reads lineage from the substrate.
2. **Survival Selection** identifies which structures remain load-bearing after transition.
3. **Governing Context** preserves the frame needed by later workers.

## Mutation Rules

- Do not invent ad hoc pillars in task prose.
- Search live entries before drafting.
- Prefer a clause extension when an existing pillar owns the mechanism.
- Every entry begins with frontmatter carrying exactly `title` and `index`.
  Revisit both whenever a mutation changes recognition scope, and keep the
  README row byte-identical to `index` — the checker prints corrections when
  they diverge.
- Generalize incidental products and services to their functional roles.
- Keep raw private evidence outside this directory. Use relative links and
  stable section names, never personal paths or mutable line citations.
- After adding, renaming, or removing an entry: update the filename,
  frontmatter, body heading, README row as a quote rather than a paraphrase,
  every cross-reference, the skill pointers, and any armory mapping — together.
- Close every mutation by running the checker and applying its printed
  corrections.
- Operator approval is the final mutation boundary.

## Provenance Policy

The corpus retains transferable mechanisms, not private provenance. Examples and records must omit personal names, employer context, internal project names, vendor-specific work stacks, private paths, and session identifiers. Public standards or technologies may be named only when the name is load-bearing to the doctrine rather than incidental to an originating example.

Custody of the corpus record is layered: this repository holds current text and recent history; the operator's memory corpus and external backups hold lineage that predates any repository baseline. Neither belongs inside individual entries.

## Summary

Consult the smallest matching set, read full bodies before applying, quote
rather than paraphrase when supplying doctrine outward, classify real
contradictions honestly, and change the corpus only through these rules with
operator approval. Pillars govern decisions when their recognition conditions
match and survive rebuttal; they are doctrine, not ritual.
