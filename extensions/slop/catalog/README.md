# Slop catalog

Each file in this directory describes one slop tell: a habit that makes prose, code or an interface read as generated, and that a person has to undo by hand. Agents read these entries before and while they write or review. The `slop_check` tool runs the detectors that some entries carry over text, files and diffs.

## How to read an entry

Recognition says how to spot the tell. Cost says what it does to the reader. Repair says how to fix the move behind it, and its first sentence is the short form that the system prompt and check results show.

An entry with a Detectors block has deterministic checks. Its Slop examples must match a detector and its Better examples must match none, so the examples are also its tests. An entry without detectors is a judgment entry: no check reports it, and agents apply it by reading.

## Judge at density

A single familiar word or mark is rarely the failure. The failure is a passage where several tells cluster, or where the shape of the text performs an argument that no sentence makes. Most detectors carry a limit for this reason, and a finding below the limit is not reported. Detectors with no limit cover forms that are slop at any count, such as claims of exactness with no check behind them, or lines that tell the reader they have nothing to do.

A finding is a prompt to reread the passage. Repair the move, not the token. A synonym, a punctuation swap or a change of format keeps the tell and usually clears the detector, which makes the check useless.

## Entries

Prose:

- `performed-precision`: claims of exactness in place of the check that was run.
- `pseudo-state-lines`: lines that tell the reader nothing is needed.
- `invented-compounds`: hyphen compounds glued together for the occasion.
- `stock-vocabulary`: stock metaphors and emphasis words.
- `negative-parallelism`: defining a thing by what it is not.
- `clause-glue`: semicolons and colons that chain clauses.
- `dashes`: dashes that join clauses.
- `label-lines`: bold labels, label lines and bold headings.
- `signposts`: sentences and openings that announce instead of say.
- `sincerity-markers`: words that vouch for candour.
- `closing-offers`: offers and handbacks at the end of a reply.
- `hollow-emphasis`: stress words with no content.
- `insider-language`: jargon, raw ids and code names the reader cannot place.
- `essay-replies`: long structured replies to short questions.
- `context-free-decisions`: choices built on facts the reader has not seen.
- `padded-triplets`: lists of three built for rhythm.
- `figurative-flourish`: metaphors that stand in for a claim.
- `formatting-display`: tables and taxonomies that the content does not need.
- `process-narration`: a diary of the work in place of the result.
- `vague-commit-subjects`: commit subjects that name no change.
- `hardcoded-counts`: counts of tests, tools or files in durable documents.

Code:

- `history-comments`: comments that tell how the code came to be.
- `agent-attribution`: credit to the agent or model in commits and comments.
- `narrating-comments`: comments that restate the next line.
- `compatibility-shims`: support for old forms that nobody needs.
- `speculative-fallbacks`: branches and guards for cases nobody named.
- `type-escape-hatches`: casts and `any` that switch off the type checker.
- `swallowed-errors`: empty error handlers.
- `leftover-vocabulary`: words of an old behaviour left after a change.
- `over-built-scaffolding`: frameworks for a single case.
- `foreign-names`: files that name callers or siblings they do not depend on.
- `wasteful-tests`: tests that cannot fail for a real defect.

Interface:

- `side-stripe-accent`: a coloured stripe on one side of a card or block.
- `generic-chat-chrome`: bubbles, glows, pills and boxes around the work.
- `open-labels`: controls labelled open, as a cue to review the interaction.
- `symbol-noise`: decorative symbols, hidden actions and raw ids.

The `slop` tool lists the active catalog on this machine, including local entries and the state of each entry.

## Related doctrine

The Pillars entries Unearned Prose (`pillars/principle-unearned-prose.md`) and Tell Laundering (`pillars/heuristic-tell-laundering.md`) hold the judgment behind the prose entries. Read them when a passage reads as generated but no single entry names why, or when a repair keeps failing.
