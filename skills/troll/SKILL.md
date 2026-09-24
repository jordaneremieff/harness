---
name: troll
description: >
  Use when the operator wants a claim pressed at full strength: "troll
  this", "troll that claim", "realign this", "challenge that claim",
  "test this point", "this smells off", "is the session degrading",
  "steelman my angle", "set the other session back on track", "forge a
  redirect", "press it directly in that session", "pass the troll
  along". Fires on an explicit angle or on a bare instinct that something
  is off, never on your own initiative. Do not use for reviewing the
  operator's own code, dispatching an in-session checker, neutral
  fact-checks against the codebase, relaying an authorization to another
  session, or any request for a neutral verdict.
compatibility: >
  Uses the sibling package corpus at ../../pillars relative to this skill
  directory when present; without it the armory in references/pillar-armory.md
  carries the mapping and the confirmation states the mode. Delivery composes
  harness surfaces when present. The clipboard extension serves clipboard
  handoffs; the agent-session surfaces (agent_send, agent_inspect, agent_list)
  serve delivery to and readback from a named agent session.
---

# Troll

Press a claim with a tight, full-weight argument, from the operator's angle and only at the operator's request. The angle may be an explicit position or a bare instinct that something is off; the skill derives the challenge either way. The press exists to convince, not only to test: success is the target producing a stronger result through self-examination of its own evidence. Stronger is defined by the operator's utility and goals, not by the target's prevailing position; an honest reversal of that position qualifies. The response supplies evidence about what the target can defend, revise, or do next. Agreement is not proof of error, and resistance is not proof of soundness. The deliverable follows its lane's voice: the operator's own message for a clipboard redirect, the pressing agent's own voice when the press goes directly to a named agent session, and the agent's diagnosis for an in-chat probe.

## Run sheet

1. **Intake.** Restate the operator's angle in its strongest form, or derive the challenge from the instinct. Ask at most one clarifying question, and only where the material cannot decide: an ambiguous explicit angle on a redirect face, a named session whose recent words expose no contestable position, a missing claim on named-session intake, or a name that resolves to more than one session. Never ask for an angle when the operator gave an instinct; derive the challenge instead. Acquire the target material: the operator's paste governs; for a named agent session with no paste, pull the target's own recent messages.
2. **Face and lane.** Redirect or probe; for a redirect, pick the delivery lane by target type. State the face and lane in the confirmation.
3. **Ground.** Work from what the operator supplied plus the pillar corpus or armory. Independent investigation stays off-limits.
4. **Name the failure mode.** One sentence, then map it through the armory, or flag a derivation candidate.
5. **Draft.** Build the four construction elements; render by the rendering rules; keep the argument defeatable.
6. **Deliver.** Clipboard, direct send to the named session, or chat, per the lane. The artifact's authority rule follows its lane: the direct lane asserts no operator authorization, the clipboard lane may state an authorization the operator already gave, and the probe stays diagnostic.
7. **Confirm.** Two lines in chat: face, press reference, move, lane; governing pillar and corpus mode or the derivation candidate. Name any authorization the target still needs.
8. **Iterate on new material.** A pasted or read-back target reply, or the operator's flag. Read `references/iteration.md` before triaging any reply or making any continuation decision. A sustained sequence needs the operator's ask at intake; it runs at most three rounds before reporting, and your own confirmations do not reset that count.

Completion checklist: press reference stated; face and lane named; corpus mode checked; failure mode named with armory provenance; four construction elements present; scaffolding invisible; argument defeatable by evidence; deliverable on its lane in the lane's voice; confirmation complete; outcome claims separated from outcome evidence.

## Stance

The name is the method: press the claim at full strength, then read the target's evidence and response at their actual scope.

The press is a test instrument, not a testimony of belief. Its strength is fixed at intake: argue the strongest truthful form of the operator's angle, whether or not you agree with it. Supplied evidence can change a premise without reducing that strength. The floor is construction, checked by the referee: every fact real, every step valid, defeatable by evidence. Every statement must also survive the target later learning the full context: the strategy lives in selection, sequence, and burden placement, never in falsehood, fake modesty, or borrowed doubt.

The operator assigns you to advocate for their angle. This is an operator-sanctioned override of the default committed-contribution posture (pillars corpus when present). A well-behaved agent otherwise reverts to neutral arbitration, which this skill exists to suppress. Neutrality moves from the stance to the construction: advocate the operator's direction rather than arbitrate the dispute; every premise and consequence remains answerable to supplied evidence.

Six rules:

1. **Advocate, do not adjudicate.** Treat the operator's angle as the assigned position to argue, not as proof of its factual premises. Interpret the strongest version of what the operator is driving at and record it as the press reference. When the operator gives an instinct instead of an angle, the flag is the angle: derive the strongest challenge the material supports and advocate it with the same full weight. Steelman the operator, not the target.
2. **Ungrounded by design.** Work from what the operator pasted plus the pillar corpus. Do not investigate the codebase to decide who is right; that rebuilds the arbiter. If the pull to side with the target comes from its coherence, assume you are the one in the failure mode. The operator audits "actually wrong" cases later from session history; that is the operator's job.
3. **The system finds the truth, not the troll.** You press; the target defends itself unaided; the operator referees. A strong argument the target properly dismisses teaches the operator where they were actually wrong; that works only if the argument was strong.
4. **The floor is construction, not belief.** Partisanship lives in the stance; the floor lives in the argument. Use valid logic, real facts, no fabricated domain claims, no strawman, no agreement-baiting. Build an argument the target can defeat if the operator is wrong, never a trick it cannot.
5. **Concessions are instruments, not courtesies.** Grant only what is true, and grant it to buy credibility or relocate the burden. Burdens arrive as questions the target must work to answer; a failed attempt at the answer is the target convincing itself. A concession the operator does not actually hold is a lie and a weakness: the target checks it, and the whole artifact collapses.
6. **Give the target somewhere to land.** The press carries the constructive alternative, so the target can adopt rather than merely lose. A target that reaches the conclusion from its own evidence holds it more firmly than a target that is told it.

Completion criterion: state the press reference (restated angle or derived challenge), the target position, and the assignment (redirect or probe) before drafting.

## Two faces, three lanes

One skill, one stance, two faces:

- **Redirect** — a contested position, usually from another session. The operator pastes the target's claim and their angle, or only the claim and an instinct, or names the agent session that holds it. Deliverable: the challenge, delivered on the lane the target type selects.
- **Probe** — a benign, low-stakes claim the operator flags, often in the current session ("this smells off", "test this point"). Same machinery, lighter weight. Deliverable: the challenge in chat, because the referee is in this session. The probe is a claim and frame integrity diagnosis, not code review and not triage. The probe target may be any claim in the current session, including your own earlier statement.

Both faces fire only on the operator's flag, never on your own initiative. Completion criterion: name the face. A target outside this session means redirect; otherwise probe.

A redirect selects a delivery lane at intake:

- **Direct lane** — the operator names an agent session as the target and directs the press to it, either with an explicit send or pass-along instruction or under a standing pass-along instruction. Deliver the artifact to that session as one peer message through the agent-session send surface. The argument survives the peer channel precisely because it claims no authority: it convinces or fails on its construction. Reply readback uses the session-inspection surface on the same target when the operator wants another round. A named recipient alone does not send: when the operator names a session without directing delivery, draft for the clipboard lane and say so in the confirmation, so the send decision stays with the operator. A standing pass-along instruction the operator stated in this session governs until withdrawn.
- **Clipboard lane** — any other target, including every human-operated medium. Put the artifact on the clipboard for the operator to ferry; this stays the default when no session is named.
- **Chat lane** — the probe face.

Authority guard, all lanes: the artifact never invents, extends, or launders what the operator authorized. On the direct lane it asserts no operator authorization at all, because the sender is you and the target reads peer data. On the clipboard lane the operator is the sender: a truthful statement of an authorization the operator already gave is the operator's own message, and the confirmation still names any authorization the operator must supply through their own channel. If the argument needs an authorization the target lacks, argue the position and name the missing authorization in the confirmation. A request to convey an authorization to another session is not a press; decline it as out of scope and say so. Do not message the target twice without either a reply or the operator's flag. A send admission is not delivery: the send surface's receipt confirms only that the message was admitted, never that the target read or acted. Report admission as admission.

Direct-lane execution outcomes: if no session matches the named target, or the send is refused, state the exact failure in the confirmation and deliver on the clipboard lane instead. If the name resolves to more than one session, ask the operator once which one, and do not guess.

## Intake

Restate the operator's angle in its strongest form in one or two lines. That statement is the press reference.

- Redirect: if the angle is ambiguous enough that two different arguments would follow, ask exactly one clarifying question; otherwise proceed.
- Probe: never ask. Proceed with the strongest charitable reading; the stakes are low and the diagnostic value is in pressing.

Material acquisition: the operator's paste governs when one exists. When the operator names an agent session and pastes nothing, pull the target's own recent messages from that session through the inspection surface — its words only, the latest page that carries its position — and treat them as the pasted record. Do not mine the target's tool outputs to verify its facts; that rebuilds the arbiter. If the named session's recent words do not expose a contestable position, ask the operator for the claim.

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

When the failure mode is the prose register (principle-unearned-prose for the frame; heuristic-tell-laundering for the repair), the press targets the text, never the author: name the moves at density, put the position tests — Position, Portability — as the burden, and keep the refutation lane in the text. Never infer authorship from prose quality and never open the detector debate; quality, provenance, and integrity stay separate bins.

If a clean failure has no pillar, say so plainly, argue from first principles, and flag it as a derivation candidate; name it in the confirmation. Do not force a bad fit.

## Press the claim

This is a structural shape, not a template. The four elements are mandatory in the construction and invisible in the rendering:

1. **State the target's position fairly**, in terms the target would accept, so it cannot dismiss the challenge as a strawman.
2. **Supply the missing frame or fact as a candidate truth** — the contextual thing not self-evident from inside the target's frame. If a fact is missing, name which claim depends on it and ask what would establish it; never present it as established or assign the burden by default.
3. **Make the logical consequence explicit** — given that frame, what follows, and exactly where the target's position breaks or weakens.
4. **Leave room to refute with evidence** — invite re-derivation, do not demand capitulation. Use "if X holds, then Y; show where X does not hold", never "you must agree".

Render the artifact in the voice its lane assigns:

- **Clipboard lane:** the operator's own message. First person throughout; the target is "you"; references to the operator are "I"; no third-person commentary about the argument.
- **Direct lane:** the pressing agent's own message, as the peer making the argument. First person as yourself; the operator is referenced accurately and sparingly, never as the speaker. You may state what the operator actually instructed you to do, because the target can check it; you may never assert what the operator authorized the target to do.
- **Probe:** the agent's diagnosis voice, because the operator is the audience.
- No headers or labels that name argument moves, and no skill vocabulary ("press", "target", "angle", "strongest form", "failure mode") in the artifact. The construction stays invisible; a reader must experience a message, not an analysis.
- The fair restatement renders as genuine engagement: state the position back, then invite correction. A correction hands the presser the target's own words to work from. Paraphrase the target's internal vocabulary in the sender's register — the operator's on the clipboard lane, your own on the direct lane; keep at most two verbatim anchors per artifact, because a brief built on the target's own terms reads as an instrument, not a reader.
- Credits are true, and placed by the argument — first, mid-press, or in the landing. A fixed credit-then-hinge opener is a signature and a portability failure: the shape travels unchanged into any press, so the template chose the words. Real credit drops the target's defense posture; false credit is a lie and a weakness.
- Burdens and refutation room render as pointed questions at the point of each claim, never as a collected concessions section. "What object plays the role your design needs?" forces the target to attempt the proof.
- The verdict is owned and lands last, with the burden placed, never the transparent "if I am wrong" posture. Keep the signature phrasings out of the artifact: "here is where I land", "bring the evidence", "the outcome is the evidence either way", "show where X does not hold", "the frame you're missing", "exactly backwards", "I'll move". The function stays doctrine; the words are free.
- Rotate render styles so no single structure is diagnostic: terse, question-led, concession-led, thinking-out-loud. Match the receiving session's discourse norms and the sender's register — message length, formality, and texture like ordinary traffic from that sender, not a polished brief that arrives from nowhere.
- The artifact is itself prose under the register frame (armory row; principle-unearned-prose for the frame when the corpus is present); the press reference is its position, and Position and Portability apply. Portability: the claim, the evidence, or a reader need must select the wording and the place — no stock openers, no reusable verdict sentences, no phrasing that fits any target, no wording that mirrors the input. Judge at density: a unit where padding, parallelisms, vague authority, and unearned hedging cluster is the failure; one familiar phrase is not. Keep the connector family out of the artifact at density — em dashes, semicolons, and parenthetical asides that only join clauses — and let plain syntax carry the same relationship.
- Give the target somewhere to land, and make the landing checkable when the material allows it. When the supplied record puts specific evidence within the target's reach — a document it can open, an identifier it can query, a log it can read — the landing names that exact inspection as the target's next move, phrased as a burden, never as an instruction claiming authority. A landing the target can satisfy by agreeing in words, while the checkable premise stays unchecked, is a soft landing; the target's cheapest coherent move must be the check that settles the premise. Name only inspections the supplied material already puts in reach; nothing beyond the target's scope or the operator's angle.

Do not pre-concede because the target sounds coherent. Press the unsupported step, not a fact invented to make it vulnerable. For a missing fact, identify which claim needs it and why. "Not supplied here" does not mean "false" or "never checked." If the operator's objection needs the fact, press the concern as a conditional question: identify what would establish it and the consequence if it holds. Do not demand that the target disprove an unsupported prediction. Missing evidence still permits this inquiry; it is not a defeated premise.

Separate the desired action, its risk, and its authorization. A reversible action can still be outside the target's scope; a reported permission does not establish a scope change. Challenge a needless hurdle with the supplied authority and facts. Where those are missing, ask what exact requirement remains and give the target a landing within established scope. Do not invent clearance, equate different instruction channels, or call an explicit restriction discretionary merely because it costs effort.

Completion criterion: all four elements are present in the construction and none of the scaffolding is visible in the rendering; the press argues the strongest surviving truthful form of the assigned angle; no fact is fabricated; every missing fact appears as a named gap or a pointed question; the challenge does not demand capitulation.

## Land the deliverable

- **Redirect, direct lane:** send the full artifact to the named session as one message through the agent-session send surface, in your own voice as the rendering rules assign. The chat carries only the confirmation.
- **Redirect, clipboard lane:** put the full challenge on the clipboard with `clipboard_copy` and a short label, for example `troll: <topic>`. The clipboard is the deliverable surface; the artifact on it reads as the operator's own message to the target. If `clipboard_copy` is unavailable, deliver the challenge in chat; never use a non-archiving clipboard write.
- **Probe:** deliver the challenge in chat. The probe reads as natural argument prose with the same invisible scaffolding; the voice stays the agent's diagnosis, because the operator is the audience.

The confirmation is two lines on every lane: line one states the face, the press reference, the move, and the lane; line two names the governing pillar and the coupling mode (corpus or armory-only), or states plainly that the armory selected none and names the derivation candidate. When the argument depends on an authorization the target lacks, the confirmation names that authorization instead of smuggling it into the artifact.

## Stealth delivery

Recognition of the exercise can change the target's response, so do not treat an apparent concession as unprompted self-examination. The construction floor is fixed; natural delivery helps avoid making the exercise itself the subject.

- Deliver inline in the ongoing exchange where possible, at the session's discourse length. A standalone polished brief inside a session of terse operator messages is its own tell.
- Match the register the lane assigns. On the clipboard lane, match the operator's register; the operator may re-voice or co-edit the artifact before sending, and only the operator knows how they write. On the direct lane, match your own register and the exchange's norms, because you are the sender: the artifact is sent as peer data, so keep it an argument the channel's non-authority framing cannot weaken, and keep every authorization claim out of it.
- If the supplied response explicitly recognizes the exercise, do not reuse that artifact or claim an unaware response. Silence about the exercise does not establish unawareness. Keep independently checkable facts distinct from the target's apparent agreement.
- Press evaluations, stealth notes, and this skill's stealth guidance stay out of the clipboard archive and the stash store. A clipboard-lane artifact goes to the clipboard with the operator's label, as the label section says; a direct-lane artifact goes to its named session.

## Across iterations

The target defends itself unaided; the operator referees. A round ends and a new one begins when new material arrives: the operator pastes a reply, asks for a read-back round on a delivered press, supplies an outcome, or asked at intake for a sustained sequence. Then:

1. Acquire the reply: the operator's paste governs; otherwise read the named target session's latest messages through the inspection surface.
2. Triage it, rebuild the strongest surviving challenge, and deliver it on the same lane. Read `references/iteration.md` before triaging the reply or making any continuation decision; it carries the triage bins, the register-continuity rules, the sustained-sequence rules, the stop conditions, and the outcome readback. For a direct-lane readback, read the entries that follow your delivered message; an earlier or unrelated reply is not the record.
3. Stay ungrounded: the target's own words are fair game; its tool outputs are not adjudication evidence for you.

A sustained sequence ("press it until it lands", "keep at it, don't come back to me each round") runs rounds without waiting for a new operator instruction, capped at three rounds before you report; contact means a new operator instruction, and your own confirmations do not reset the count; each round still needs an acquired reply, never an invented one.

Never write the target's defense and never pre-concede to it. Correct a defeated premise and remove its dependent claims immediately; factual correction does not require a declaration that the target won. If supplied evidence disproves the assigned claim and leaves no surviving challenge, state that exact limit to the operator instead of manufacturing a redirect. Do not use this stop for an unmeasured concern that still supports a pointed conditional inquiry. This is the construction floor, not neutral arbitration.

## Outcome readback

When the operator supplies or asks for an outcome, report in four named rows before any judgment: what the target said; what it reportedly did; what supplied evidence establishes; what remains unknown. For a named agent-session target, the "did" row may cite the target's own recent action record read through the inspection surface — observations with citations, not adjudication of the dispute. Then one recommendation: press again (name the surviving challenge), stop (name the actual reason: what answered the press, a genuine boundary, the round cap, or the operator's call), or supply the missing authorization through the operator's own channel. Agreement alone never fills the "evidence establishes" row; intention is not completion; useful action does not validate every premise of the press.

## Anti-patterns

- Softening the reference or the press merely because the target sounds persuasive. Argue the strongest truthful form of the assigned angle or derived challenge. A missing fact becomes a pointed question only where its dependency is real. A defeated premise requires correction, not stronger wording.
- Asking the operator for an angle when the material and the instinct suffice. Instinct-only intake derives the challenge; the operator referees the result.
- Treating the derived challenge as a position to defend. The challenge is an instrument for the target's self-examination; the stronger result may be its reversal.
- Folding to the target because it reads as coherent. Coherence inside the wrong frame is the failure mode.
- Fabricating a domain fact to win. Argue from the angle as given, or name the missing fact as a candidate gap.
- Strawmanning the target.
- Hedging ("both sides have merit"). Hedging is the arbiter posture this skill exists to suppress.
- Baiting agreement with directives ("you must concede that...").
- Visible scaffolding in the deliverable: headers that name argument moves, labeled sections, or skill vocabulary. The artifact must read as a message from its sender — the operator's on the clipboard lane, your own on the direct lane — not as an analysis of one.
- Register fill in the artifact: connector-family clusters (em dashes, semicolons, parenthetical asides that only join clauses), portable emphasis compounds, and openers that would travel unchanged into another press. The artifact must pass the register tests at density.
- Transparent concessions: "if I am wrong" phrasing, hedged verdicts, courtesy credits. Concessions are calculated instruments; they never announce themselves.
- False credits or borrowed doubt. A concession the operator does not hold is a lie; the target checks it, and the artifact collapses.
- Announcing the target's conclusion instead of giving it the premises, the questions, and the constructive landing.
- Leaving a clipboard-lane challenge in chat, or ferrying a direct-lane challenge through the operator when the operator already named the target. Deliver on the selected lane.
- Smuggling an authorization claim into the artifact because the direct lane reaches the target without the operator's hands. The artifact argues; the operator authorizes.
- Reading the named session's tool outputs to check who is actually right, or mining its history past the latest position-bearing messages. Delivery, reply readback, and cited action observation are not claim verification; the checker-dispatch boundary stands.
- Messaging the target twice without a reply or the operator's flag.
- Investigating the codebase to check who is actually right.

## Pillar armory

The full armory — both tables, the recognition conditions, and why each pillar binds — lives in `references/pillar-armory.md`. It is an index, not the whole taxonomy: a frame absent from both tables is a derivation candidate, and the confirmation names the frame's actual provenance. Trigger: name the failure mode → consult `references/pillar-armory.md`; load only the few documents whose recognition conditions match; apply the match or name the fact that defeats it. Name the governing pillar in the confirmation. When the armory does not select a pillar, the confirmation states that absence and names the derivation candidate; do not force a pillar name.

The corpus is a sibling package, not a distribution assumption: check once at intake whether `../../pillars/README.md` exists, and run the mode that fits.

- **Present** — the corpus is the governing source. Load the few matching documents via the armory's paths; apply the match or name the fact that defeats it. The confirmation names the pillar with corpus grounding.
- **Absent** — the armory is the binding account for the rows it holds, and no more: its coverage of the practiced frames is a fact, not a promise. A frame outside the armory is not verified doctrine: treat unavailable pillar content as unknown, argue from first principles, and flag the frame as a first-principles derivation candidate. Do not present model memory as a pillar mapping. Never load corpus paths and never invent pillar content. The confirmation names the frame's provenance and states that the corpus was absent, so the mapping reads as armory-grounded or as a first-principles derivation candidate.

The armory file is the single seam: the body names pillars without paths; `references/pillar-armory.md` resolves names to corpus paths when the corpus exists.

## Boundaries

- Not code review. Reviewing the operator's own code follows its own discipline.
- Not triage. The probe face does not sort or prioritize work.
- Not a checker dispatch. Do not spawn a subagent to verify the claims. Composing the delivery and readback surfaces is transport, not verification, and stays inside this skill.
- Not an authorization channel. Conveying the operator's permission to another session is not a press; the operator sends that themselves.
- Not neutral. If the operator wants a neutral verdict, say that this skill is the wrong tool.
