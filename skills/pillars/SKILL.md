---
name: pillars
description: >
  Consult and apply the pillars: the doctrine corpus (principles, patterns,
  heuristics) that governs agent judgment in this environment. Use at any
  judgment moment where a governing principle might bind, for example:
  architectural or design decisions, trade-offs, option menus and
  comparisons, whether infrastructure is warranted, where information belongs,
  how much verification a claim needs, flagging or repairing prose tells. Also
  use when the operator says "check pillars", "what do the pillars say", "apply
  pillars", asks for a decision to be evaluated against principles, patterns, or
  heuristics, or proposes, derives, revises, or challenges corpus entries.
compatibility: Requires the sibling package corpus at ../../pillars relative to this skill directory.
---

Pillars are portable, defeasible doctrine for agent judgment in this
environment. The canonical corpus is the package-level `../../pillars/`
directory, resolved relative to this skill directory. A matching pillar
governs the decision procedure; it does not override facts, permissions, or
explicit higher authority.

Start at `../../pillars/README.md`: its rows quote each entry's own `index`
sentence and are the shortlist surface. The full consultation procedure,
application contract, contradiction handling, composition paths, subagent
supply rules, and mutation rules live in
`../../pillars/GOVERNANCE.md` — Consultation Procedure first.

Nothing is written to the corpus until the operator approves it; corpus
changes follow the Mutation Rules in GOVERNANCE.md.
