# Findings

This file is generated from `data/rules.json` by `scripts/render-references.mts`. Do not edit it by hand: change the data and run the script.

Every rule the meter can report, with its severity, what it means and one direction for repair. Hard findings are absolute rules. Scored findings feed the weighted score. Advisory findings are reported and carry no weight. Repair above the form: swapping a flagged symbol for a neighbour keeps the same move.

## Contents

- [Lexical](#lexical)
- [Geometry](#geometry)
- [Epistemic](#epistemic)
- [Laundering](#laundering)
- [Punctuation](#punctuation)
- [Structure](#structure)
- [Links](#links)
- [Spelling](#spelling)
- [Times](#times)
- [Commit and review text](#commit-and-review-text)

## Lexical

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `lexical.tier-one` | scored, lexical, weight 2.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.beacon` | scored, lexical, weight 2.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.pivotal` | scored, lexical, weight 2.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.underscore-verb` | scored, lexical, weight 2.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.tier-two` | scored, lexical, weight 1.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.resonate` | scored, lexical, weight 1.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.foster` | scored, lexical, weight 1.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.navigate` | scored, lexical, weight 1.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.harness-verb` | scored, lexical, weight 1.5 | Verb use of 'harness' as a power metaphor. | Say what the thing does: use, run, or apply. |
| `lexical.elevate` | scored, lexical, weight 1.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.landscape` | scored, lexical, weight 1.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.realm` | scored, lexical, weight 1.5 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.tier-three` | scored, lexical, weight 1 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.imperative-paradigm` | scored, lexical, weight 1 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.robust` | scored, lexical, weight 1 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.dynamic` | scored, lexical, weight 1 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.align` | scored, lexical, weight 1 | Stock vocabulary that adds tone but no fact. | Name the specific thing, or cut the word. |
| `lexical.emphasis-swap` | scored, lexical, weight 1 | Portable emphasis word that stands in for a reason. | Say what depends on it, or what fails without it. |
| `lexical.agent-speak` | scored, lexical, weight 1 | Stock agent vocabulary. | Use the plain word: part, join, base, stuck, depends on. |
| `lexical.agent-speak-mild` | scored, lexical, weight 0.5 | Overused agent vocabulary. | Use the plain word: how often, origin, official, based on, stop. |
| `lexical.developer-term` | advisory | Use 'operator' for the person who runs the harness. | Say operator, user or maintainer, whichever is true. |
| `lexical.coined-compound` | scored, lexical, weight 1.5 | Coined hyphenated compound. | Say it in ordinary words, or define the compound where it first appears. |
| `lexical.coined-curated` | scored, lexical, weight 2 | Known coined phrase. | Say it in ordinary words. |
| `lexical.business-buzz` | scored, lexical, weight 2 | Business buzz phrase. | Say the concrete thing: the task, the number, the date. |

## Geometry

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `geometry.triad` | scored, geometry, weight 2 | Three-item list of single words with a closing 'and' or 'or'. | List the true count, or keep only the item that matters. |
| `geometry.negative-parallelism` | scored, geometry, weight 2.5 | Negative parallelism: a view nobody held, knocked down. | State the positive claim directly. |
| `geometry.copula-avoidance` | scored, geometry, weight 2 | Verb that avoids 'is'. | Write 'is' or the exact verb. |
| `geometry.individually-collectively` | scored, geometry, weight 2 | Individually/collectively two-step. | Say the one claim the two halves support. |
| `geometry.punch-fragment` | scored, geometry, weight 1 | Short fragment after a long sentence. | Merge the fragment into the sentence it belongs to. |
| `geometry.pendulum-block` | scored, geometry, weight 1.5 | One very long paragraph. | Split at the change of topic. Keep each paragraph to one point. |
| `geometry.bold-density` | scored, geometry, weight 2 | Heavy use of bold in running text. | Remove most bold. Keep it for a term the reader must find again. |
| `geometry.heading-density` | scored, geometry, weight 1.5 | Many headings for the amount of text. | Remove headings from short text. Use them to navigate long documents only. |

## Epistemic

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `epistemic.candour-frame` | hard | Candour frame that splits the message into spin and truth. | Delete the frame and state the plain fact. |
| `epistemic.scaffold-frame` | scored, epistemic, weight 2 | Frame that announces a point instead of making it. | Cut the frame and state the point. |
| `epistemic.connector-filler` | scored, epistemic, weight 1 | Sentence-opening connector with no relation to build. | Start with the claim or name the real relation. |
| `epistemic.signpost` | scored, epistemic, weight 2 | Signpost that announces structure. | Say the thing. Let the order show the structure. |
| `epistemic.root-cause-reveal` | scored, epistemic, weight 2 | Staged reveal of a cause. | State the cause and the evidence in one sentence. |
| `epistemic.stock-opener` | scored, epistemic, weight 2.5 | Chat pleasantry or apology opener. | Start with the answer or the correction. |
| `epistemic.closing-offer` | scored, epistemic, weight 2 | Closing offer that adds no fact. | End on the last substantive fact or the one decision you need. |
| `epistemic.closing-menu` | scored, epistemic, weight 1.5 | Closing menu built on context the reader may not have. | Recommend one option and say why. Ask only for a decision you cannot make. |
| `epistemic.vague-authority` | scored, epistemic, weight 2 | Authority claimed without a source. | Name the source and what it found, or drop the claim. |
| `epistemic.performed-precision` | scored, epistemic, weight 3 | Precision asserted without naming the check. | Name the check you ran and its result. |
| `epistemic.hollow-emphasis` | scored, epistemic, weight 1 | Emphasis word with nothing behind it. | Give the evidence or the number that shows it matters. |
| `epistemic.hedge-stack` | scored, epistemic, weight 1.5 | Stacked or unearned hedge. | State the claim at the strength the evidence supports, once. |
| `epistemic.false-balance` | scored, epistemic, weight 1.5 | Balance staged where the evidence is settled. | State the fact and the constraint. |
| `epistemic.agent-narration` | scored, epistemic, weight 2 | Tool or edit narration in the reply. | Report the result, not the mechanics. |
| `epistemic.unexplained-code` | advisory | Coded reference with no definition nearby. | Define the code at first use, or say the plain thing. |
| `epistemic.evaluative` | scored, epistemic, weight 1 | Vacuous evaluative word. | Replace the praise with the measurable fact. |
| `epistemic.presumed-context` | scored, epistemic, weight 1.5 | Wording that assumes the reader saw earlier work. | Write for a reader who arrives cold: name the thing and restate the one fact they need. |
| `epistemic.recap-opener` | scored, epistemic, weight 1.5 | Recap opener that repeats instead of adding a fact. | End on the last substantive fact. |
| `epistemic.hedge-sibling` | scored, epistemic, weight 0.75 | Hedge that may not match the evidence. | State the claim at the strength the evidence supports, or say what you did not check. |
| `epistemic.vacuous-praise` | scored, epistemic, weight 2 | Praise with no finding behind it. | Name the line or behaviour you checked and what you found. |
| `epistemic.canned-ops` | scored, epistemic, weight 2 | Operations guidance with no executable step. | Give the command, the check, and the threshold that triggers a rollback. |

## Laundering

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `laundering.compliance-narration` | hard | Narration of rule compliance instead of the content. | Remove the narration. Deliver the content and let it stand. |
| `laundering.substitution` | scored, laundering, weight 2.5 | Thesaurus swap for a flagged phrase. | Say the plain thing the phrase stands for, with its evidence. |
| `laundering.false-colloquial` | scored, laundering, weight 2 | Fake informality at the start of a sentence. | Start with the claim. |

## Punctuation

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `punctuation.em-dash` | hard | Em dash or horizontal bar used as a clause connector. | Split into two sentences, or pick the real relation (because, so, but) and say it in words. |
| `punctuation.en-dash` | hard | En dash or figure dash in prose. | Write ranges with the word to (2020 to 2024), and split clauses into sentences. |
| `punctuation.middle-dot` | hard | Middle dot used as a separator. | Use a comma, a new sentence, or a list. |
| `punctuation.zero-width` | hard | Zero-width character in text. | Delete the character. |
| `punctuation.quoted-name-parenthetical` | hard | Parenthetical that holds a quoted entity name. | Name the entity in the sentence, or define it once in its own sentence. |
| `punctuation.semicolon` | scored, laundering, weight 1; hard with --strict-semicolons | Semicolon joining clauses in prose. | Make two sentences, or state the relation (because, so, but). |
| `punctuation.spaced-hyphen` | scored, laundering, weight 1.5 | Spaced hyphen used as a dash. | Split into two sentences or name the relation in words. |
| `punctuation.double-hyphen` | scored, laundering, weight 1.5 | Double hyphen used as a dash. | Split into two sentences or name the relation in words. |
| `punctuation.colon-label` | scored, laundering, weight 1.5 | Colon label at the start of a text unit. | Write the sentence the label stands for. |
| `punctuation.parenthetical-aside` | scored, laundering, weight 1.5 | Long parenthetical that demotes a fact. | Promote the fact to its own sentence, or cut it. |

## Structure

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `structure.bold-label` | hard | Bold label at the start of a list item. | Write the item as a plain sentence that states the point. Drop the label. |
| `structure.see-also-top` | hard | 'See Also' heading near the top of the document. | Put related links at the end under a plain heading, or weave them into the text. |
| `structure.truncated-hex-id` | hard | Truncated identifier ending in an ellipsis. | Give the full identifier, or a name the reader can look up. |
| `structure.meta-opener` | hard | Opener that describes the text instead of starting it. | Start with the first fact or the decision. |
| `structure.bold-lead` | scored, geometry, weight 1.5 | Paragraph that opens with a bold label. | Open with the sentence. Drop the label. |
| `structure.bot-heading` | scored, geometry, weight 2 | Template heading with no content of its own. | Use a heading that names the topic, or none. |

## Links

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `link.bare-url` | hard | Bare URL in prose. | Link a short descriptive anchor, or put a literal endpoint in code ticks. |
| `link.autolink` | hard | Autolink in angle brackets. | Link a short descriptive anchor instead. |
| `link.url-anchor` | hard | Link whose anchor text is a URL. | Use words that say where the link goes. |

## Spelling

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `spelling.ize-yze` | advisory | American -ize/-yze spelling. | Use the Australian form: -ise, -isation, -yse. |
| `spelling.our` | advisory | American -or spelling. | Use the Australian form: -our. |
| `spelling.centre` | advisory | American spelling. | Use the Australian form: centre, fibre, theatre, defence, offence, grey, catalogue. |

## Times

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `time.twenty-four-hour` | advisory | 24-hour time in prose. | Write a 12-hour time with am or pm. |
| `time.utc-suffix` | advisory | UTC or GMT time in prose. | Write the local 12-hour time with its zone. |

## Commit and review text

| Rule | Severity | Meaning | Repair direction |
|---|---|---|---|
| `commit.subject-length` | hard | Commit subject is longer than 72 characters. | Shorten the subject to the resulting state in imperative form. Move detail to the body. |
| `commit.subject-period` | hard | Commit subject ends with a period. | Remove the final period. |
| `commit.subject-generic` | hard | Commit subject names no change. | Name the resulting state: what the code does now. |
| `commit.subject-narrated` | hard | Commit subject narrates the author's action. | Describe the resulting state in imperative form. |
| `commit.apologetic-leak` | hard | Review chat or apology recorded in commit history. | Squash or amend, and describe the change instead. |
| `commit.buzzword` | scored, epistemic, weight 2.5 | Commit text states a virtue instead of the change. | Name the identifier, value or behaviour that changed. |
| `commit.speculative-value` | scored, epistemic, weight 1.5 | Unfalsifiable value claim. | State the observed change and how it was checked. |
