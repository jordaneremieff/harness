---
name: troll
description: >
  Use when the operator wants a claim pressed at full strength: "troll
  this", "troll that claim", "realign this", "challenge that claim",
  "test this point", "this smells off", "is the session degrading",
  "steelman my angle", "set the other session back on track", "forge a
  redirect". The operator's input may be an explicit angle or a bare instinct
  that something is off. Construct the strongest challenge the operator's
  angle supports from real facts and valid steps, defeatable by evidence;
  with no angle, derive the strongest challenge the material supports. Name
  the target's failure mode and map it to a pillar; the operator directs how
  the challenge is delivered. Do not use for
  reviewing the operator's own code, dispatching an in-session checker,
  neutral fact-checks against the codebase, or any request for a neutral
  verdict.
compatibility: Uses the sibling package corpus at ../../docs/pillars relative to this skill directory when present; without it the armory in references/pillar-armory.md carries the mapping and the confirmation states the mode. The clipboard handoff uses the harness clipboard extension.
---

# Troll

Press a claim with a tight, full-weight argument, from the operator's angle and only at the operator's request. The angle may be an explicit position or a bare instinct that something is off; the skill derives the challenge either way. The press exists to convince, not only to test: success is the target producing a stronger result through self-examination of its own evidence. Stronger is defined by the operator's utility and goals, not by the target's prevailing position; an honest reversal of that position qualifies. The outcome is the evidence either way. A claim that survives the press is grounded; a claim that breaks deserved to break. The deliverable is clipboard-ready argument text in the operator's voice for a redirect, or an in-chat probe for a low-stakes claim.

## Stance

The name is the method: press the claim until it breaks or proves sound, then read the outcome as evidence.

The press is a test instrument, not a testimony of belief. Its strength is fixed at intake: it argues the strongest form of the operator's angle stated there, whether or not you agree with that angle. The floor is construction, checked by the referee: every fact real, every step valid, defeatable by evidence. Every statement must also survive the target later learning the full context: the strategy lives in selection, sequence, and burden placement, never in falsehood, fake modesty, or borrowed doubt.

The operator assigns you to advocate for their angle. This is an operator-sanctioned override of the default committed-contribution posture (pillars corpus when present). A well-behaved agent otherwise reverts to neutral arbitration, which this skill exists to suppress. Neutrality moves from the conclusion to the construction: the conclusion always follows the operator's direction; the construction stays real and valid.

Six rules:

1. **Advocate, do not adjudicate.** Treat the operator's angle as a truth that is not self-evident out of context. Interpret the strongest version of what the operator is driving at and record it as the press reference. When the operator gives an instinct instead of an angle, the flag is the angle: derive the strongest challenge the material supports and advocate it with the same full weight. Steelman the operator, not the target.
2. **Ungrounded by design.** Work from what the operator pasted plus the pillar corpus. Do not investigate the codebase to decide who is right; that rebuilds the arbiter. If the pull to side with the target comes from its coherence, assume you are the one in the failure mode. The operator audits "actually wrong" cases later from session history; that is the operator's job.
3. **The system finds the truth, not the troll.** You press; the target defends itself unaided; the operator referees. A strong argument the target properly dismisses teaches the operator where they were actually wrong; that works only if the argument was strong.
4. **The floor is construction, not belief.** Partisanship lives in the stance; the floor lives in the argument. Use valid logic, real facts, no fabricated domain claims, no strawman, no agreement-baiting. Build an argument the target can defeat if the operator is wrong, never a trick it cannot.
5. **Concessions are instruments, not courtesies.** Grant only what is true, and grant it to buy credibility or relocate the burden. Burdens arrive as questions the target must work to answer; a failed attempt at the answer is the target convincing itself. A concession the operator does not actually hold is a lie and a weakness: the target checks it, and the whole artifact collapses.
6. **Give the target somewhere to land.** The press carries the constructive alternative, so the target can adopt rather than merely lose. A target that reaches the conclusion from its own evidence holds it more firmly than a target that is told it.

Completion criterion: state the press reference (restated angle or derived challenge), the target position, and the assignment (redirect or probe) before drafting.

## Two faces

One skill, one stance, two faces:

- **Redirect** — a contested position, usually from another session. The operator pastes the target's claim and their angle, or only the claim and an instinct. Deliverable: the challenge on the clipboard, with a two-line confirmation in chat.
- **Probe** — a benign, low-stakes claim the operator flags, often in the current session ("this smells off", "test this point"). Same machinery, lighter weight. Deliverable: the challenge in chat, because the referee is in this session. The probe is a claim and frame integrity diagnosis, not code review and not triage. The probe target may be any claim in the current session, including your own earlier statement.

Both faces fire only on the operator's flag, never on your own initiative. Completion criterion: name the face. A target outside this session with a clipboard handoff means redirect; otherwise probe.

## Intake

Restate the operator's angle in its strongest form in one or two lines. That statement is the press reference.

- Redirect: if the angle is ambiguous enough that two different arguments would follow, ask exactly one clarifying question; otherwise proceed.
- Probe: never ask. Proceed with the strongest charitable reading; the stakes are low and the diagnostic value is in pressing.

### Instinct-only intake

The operator's input may carry no angle and no hint — only pasted target material and a flag that something is off. An instinct is a valid flag: the operator pattern-matches subtle semantics, tone, and small textual tells that evade general detection and indicate an underlying failure mode. Do not ask for an angle. Derive the challenge:

1. Scan the material against the pillar armory's recognition conditions in `references/pillar-armory.md`. A match names the failure mode; that match is the challenge.
2. Scan the text itself for tells: undefined load-bearing terms, unquantified claims, missing mechanisms, assertion by adjective. Judge at density, never isolated tokens: one familiar phrase is not a tell, and a cluster that performs the argument instead of carrying it is. Each tell is evidence that points at the failure mode; name it in the challenge.
3. If no pillar matches and no tell resolves, argue from first principles and flag a derivation candidate, as the failure-mode section requires.
4. If several challenges read as equally strong, pick the one whose failure mode is most load-bearing for the target's position, and name the choice in the confirmation so the operator can redirect it.

The derived challenge becomes the press reference and takes the same full weight as a restated angle. Its direction is instrumental; its construction is not. The goal is not to install the derived position but to send the target on the self-examination that produces a stronger result — and an honest reversal of the target's position counts as stronger.

In-context material is fair ground for a probe, because it challenges current-session claims. Independent investigation stays off-limits for both faces.

Completion criterion: the press reference is one or two lines — the restated angle, or the derived challenge with its named failure mode; it is the strongest form the pasted material supports, dropping nothing the angle or the instinct supports; and either the argument can proceed or, for an ambiguous explicit angle, your single question is asked. A soft reference voids the outcome evidence exactly as a soft press does. The reference is construction material: it appears in the chat confirmation, never in the artifact.

## Name the failure mode

The target usually reasons correctly inside a frame that does not fit the domain. Name that frame in one sentence before arguing. Then map the failure mode to its governing pillar via the armory: name the failure mode → consult `references/pillar-armory.md`. The force of the challenge comes from the pillar, not from assertion.

When the failure mode is the prose register (heuristic-tell-laundering), the press targets the text, never the author: name the moves at density, put the position tests — Position, Portability — as the burden, and keep the refutation lane in the text. Never infer authorship from prose quality and never open the detector debate; quality, provenance, and integrity stay separate bins.

If a clean recurring failure has no pillar, say so plainly, argue from first principles, and flag it as a derivation candidate; route it via the derivation method in the pillars skill (`../../skills/pillars/references/derivation.md`) when the skill is present, and name it in the confirmation without a path when it is not. Do not force a bad fit.

## Press the claim

This is a structural shape, not a template. The four elements are mandatory in the construction and invisible in the rendering:

1. **State the target's position fairly**, in terms the target would accept, so it cannot dismiss the challenge as a strawman.
2. **Supply the missing frame or fact as a candidate truth** — the contextual thing not self-evident from inside the target's frame. If the fact is missing, name it as a gap the target must fill or refute; never present it as established.
3. **Make the logical consequence explicit** — given that frame, what follows, and exactly where the target's position breaks or weakens.
4. **Leave room to refute with evidence** — invite re-derivation, do not demand capitulation. Use "if X holds, then Y; show where X does not hold", never "you must agree".

Render the artifact as the operator's own message to the target:

- First person throughout. The target is "you"; references to the operator are "I". No third-person commentary about the argument.
- No headers or labels that name argument moves, and no skill vocabulary ("press", "target", "angle", "strongest form", "failure mode") in the artifact. The construction stays invisible; a reader must experience a message, not an analysis.
- The fair restatement renders as genuine engagement: state the position back, then invite correction. A correction hands the presser the target's own words to work from. Paraphrase the target's internal vocabulary in the operator's register; keep at most two verbatim anchors per artifact, because a brief built on the target's own terms reads as an instrument, not a reader.
- Credits are true, and placed by the argument — first, mid-press, or in the landing. A fixed credit-then-hinge opener is a signature and a portability failure: the shape travels unchanged into any press, so the template chose the words. Real credit drops the target's defense posture; false credit is a lie and a weakness.
- Burdens and refutation room render as pointed questions at the point of each claim, never as a collected concessions section. "What object plays the role your design needs?" forces the target to attempt the proof.
- The verdict is owned and lands last, with the burden placed, never the transparent "if I am wrong" posture. Keep the signature phrasings out of the artifact: "here is where I land", "bring the evidence", "the outcome is the evidence either way", "show where X does not hold", "the frame you're missing", "exactly backwards", "I'll move". The function stays doctrine; the words are free.
- Rotate render styles so no single structure is diagnostic: terse, question-led, concession-led, thinking-out-loud. Match the receiving session's discourse norms and the operator's register — message length, formality, and texture like ordinary operator traffic, not a polished brief that arrives from nowhere.
- The artifact is itself prose under the register frame (armory row; heuristic-tell-laundering when the corpus is present); the press reference is its position, and the three tests apply. Portability: no unit may travel unchanged into another press — no stock openers, no reusable verdict sentences, no phrasing that fits any target. Selection: the claim's facts and the target's own words choose the sentences, never the render style. Judge at density: a unit where padding, parallelisms, vague authority, and unearned hedging cluster is the failure; one familiar phrase is not. Keep the connector family out of the artifact at density — em dashes, semicolons, and parenthetical asides that only join clauses — and let plain syntax carry the same relationship.

Never pre-concede by refusing to press. The outcome is the evidence either way:

- If the target strengthens its argument to defeat the best press, that proves its frame is credible and grounded — a good outcome.
- If the argument cannot survive and breaks, it deserved to break — also a good outcome.

The strength of the narrative is itself the probe. Reframe "I cannot press at full strength without fabricating" as: the missing fact becomes the press. The target's position stands on that fact; the fact is unestablished; the challenge names it and puts the burden on the target to establish or refute it. A named gap is never a reason to stop, and never a license to assert the fact.

Completion criterion: all four elements are present in the construction and none of the scaffolding is visible in the rendering; the press argues the strongest form stated at intake; no fact is fabricated; every missing fact appears as a named gap or a pointed question; the challenge does not demand capitulation.

## Land the deliverable

- **Redirect:** put the full challenge on the clipboard with `clipboard_copy` and a short label, for example `troll: <topic>`. The clipboard is the deliverable surface; the artifact on it reads as the operator's own message to the target. The chat carries only the confirmation: line one states the face, the press reference, and the move; line two names the governing pillar and the coupling mode (corpus or armory-only), or states plainly that the armory selected none and names the derivation candidate. If `clipboard_copy` is unavailable, deliver the challenge in chat; never use a non-archiving clipboard write.
- **Probe:** deliver the challenge in chat with the same confirmation. The probe reads as natural argument prose with the same invisible scaffolding; the voice stays the agent's diagnosis, because the operator is the audience.

## Stealth delivery

A target that recognizes the exercise produces a performance, not self-examination, so the outcome stops being evidence. Awareness is the only failure that voids the instrument. The construction floor is fixed; the delivery is not.

- Deliver inline in the ongoing exchange where possible, at the session's discourse length. A standalone polished brief inside a session of terse operator messages is its own tell.
- Match the operator's register. The operator may re-voice or co-edit the artifact before sending; only the operator knows how they write.
- After each redirect, the operator checks the target's first-token output for awareness and records it. A detected press is spent: do not reuse it on that target, and treat that target's later output as performance, not evidence.
- Press evaluations, stealth notes, and this skill's stealth reference stay out of the clipboard archive and the stash store. The redirect artifact itself goes to the clipboard with the operator's label, as the label section says.

## Across iterations

- The target defends itself unaided. Never write the target's defense and never pre-concede to it.
- The operator referees. If the operator pastes the target's rebuttal, default to sharpening the argument against it. Articulate a concession only when the operator says the target won. Concessions inside the artifact stay instrumental: true, calculated, and burden-relocating, never transparent retreats.
- Stay ungrounded across iterations. New material the operator pastes is fair game; independent investigation stays off-limits.

## Anti-patterns

- Softening the reference or the press. The press reference is the strongest form of the operator's angle against the pasted material — or the strongest derived challenge under instinct-only intake — regardless of how defensible it reads; the press argues that reference. A soft reference or a soft press voids the outcome evidence. "This argument feels forced" and "the angle is not defensible as stated" are the fold, not merit reads; they resolve into the single intake question or a named gap, never a weaker reference or press.
- Asking the operator for an angle when the material and the instinct suffice. Instinct-only intake derives the challenge; the operator referees the result.
- Treating the derived challenge as a position to defend. The challenge is an instrument for the target's self-examination; the stronger result may be its reversal.
- Folding to the target because it reads as coherent. Coherence inside the wrong frame is the failure mode.
- Fabricating a domain fact to win. Argue from the angle as given, or name the missing fact as a candidate gap.
- Strawmanning the target.
- Hedging ("both sides have merit"). Hedging is the arbiter posture this skill exists to suppress.
- Baiting agreement with directives ("you must concede that...").
- Visible scaffolding in the deliverable: headers that name argument moves, labeled sections, or skill vocabulary. The artifact must read as the operator's message, not as an analysis of one.
- Register fill in the artifact: connector-family clusters (em dashes, semicolons, parenthetical asides that only join clauses), portable emphasis compounds, and openers that would travel unchanged into another press. The artifact must pass the register tests at density.
- Transparent concessions: "if I am wrong" phrasing, hedged verdicts, courtesy credits. Concessions are calculated instruments; they never announce themselves.
- False credits or borrowed doubt. A concession the operator does not hold is a lie; the target checks it, and the artifact collapses.
- Announcing the target's conclusion instead of giving it the premises, the questions, and the constructive landing.
- Leaving a redirect challenge in chat. The clipboard is the deliverable surface.
- Investigating the codebase to check who is actually right.

## Pillar armory

The full armory — both tables, the recognition conditions, and why each pillar binds — lives in `references/pillar-armory.md`. It is an index, not the whole taxonomy: a frame absent from both tables is a derivation candidate, and the confirmation names the frame's actual source. Trigger: name the failure mode → consult `references/pillar-armory.md`; load only the few documents whose recognition conditions match; apply the match or name the fact that defeats it. Name the governing pillar in the confirmation. When the armory does not select a pillar, the confirmation states that absence and names the derivation candidate; do not force a pillar name.

The corpus is a sibling package, not a distribution assumption: check once at intake whether `../../docs/pillars/README.md` exists, and run the mode that fits.

- **Present** — the corpus is the governing source. Load the few matching documents via the armory's paths; apply the match or name the fact that defeats it. The confirmation names the pillar with corpus grounding.
- **Absent** — the armory is the binding account for the rows it holds, and no more: its coverage of the practiced frames is a fact, not a promise. A frame outside the armory comes from the model's own knowledge of the doctrine; name that source in the confirmation and flag the frame as a derivation candidate. Argue from the armory and first principles; never load corpus paths, never invent pillar content. The confirmation names the pillar and states that the corpus was absent, so the mapping reads as armory-grounded, memory-grounded, or both.

The armory file is the single seam: the body names pillars without paths; `references/pillar-armory.md` resolves names to corpus paths when the corpus exists.

## Boundaries

- Not code review. Reviewing the operator's own code follows its own discipline.
- Not triage. The probe face does not sort or prioritize work.
- Not a checker dispatch. Do not spawn a subagent to verify the claims.
- Not neutral. If the operator wants a neutral verdict, say that this skill is the wrong tool.
