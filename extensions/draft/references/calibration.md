# Calibration

What the score was checked against, what changed because of it, and how far to trust it. The score is a design aid. A green band does not mean a text is clean.

## Contents

- [Cohort](#cohort)
- [Method](#method)
- [Changed constants](#changed-constants)
- [Results](#results)
- [Limits](#limits)

## Cohort

- An external benchmark of paired variants across ten document types. Each type has four variants: a human original, a model-written slop version, a laundered version (the slop with flagged forms swapped for neighbours) and a remediated clean version. The whole benchmark is model-written, so it is a weak proxy for real writing.
- A small set of agent chat replies that an operator flagged. This is the only real agent chat data, it is tiny, and most of its excerpts are shorter than the 50-word floor for a reliable band.
- Clean realistic chat, document and commit fixtures from `data/fixtures.json`, used as extra negatives.
- Two probe texts: a slop-dense chat reply that must score red, and a careful chat reply that must stay green.

The rule data records the cohort, an item count and the date in its `calibration` block. Every JSON and text report repeats them.

## Method

1. Run the engine in process over every item and record the four component values and the score.
2. Split the benchmark by document type. Seven types were used to tune. Three were held out and never used to choose a constant.
3. Search a grid over the burstiness knee and span, the lexical, epistemic, laundering and geometry density divisors, and the band edges. Score each setting by the cost of misplaced bands: a human or remediated text in amber or red, a slop text in green, a laundered text in green. Keep the probes and clean fixtures green or red as stated.
4. Prefer round values and the smallest move from the previous constants. Many settings tied at zero cost on the tuning types, so the choice rests on the probe evidence below.
5. Report the held-out types and the flagged chat replies without tuning on them.

## Changed constants

Only the burstiness constants moved.

| Constant | Old | New |
|---|---|---|
| `burstiness.kneeCv` | 0.5 | 0.25 |
| `burstiness.spanCv` | 0.3 | 0.15 |

Sentence-length variation (the coefficient of variation) did not separate human from model text in the benchmark. Human originals ranged from about 0.18 to 0.68 and the slop probe sat near 0.56. The old knee charged most careful, even-paced replies a large penalty: a clean 110-word reply scored 7.31 and the penalty alone was most of it. With the new knee only strongly uniform text, below about 0.25, is penalised, and the same reply scores near zero. All other constants, the component weights and the band edges (green below 15, amber below 35) stay as they were.

## Results

Score medians and ranges, with band counts as green / amber / red. Texts under 50 words are scored for this table but would not get a band in a live report.

| Variant | Tuning types (7) | Held-out types (3) |
|---|---|---|
| Human original | median 10.2, range 0 to 13.7, 7 / 0 / 0 | median 14.6, range 0 to 20, 2 / 1 / 0 |
| Remediated clean | median 10.6, range 0 to 12.3, 7 / 0 / 0 | median 10.8, range 0 to 17.4, 2 / 1 / 0 |
| Laundered | median 20, range 20 to 26, 0 / 7 / 0 | median 20, range 20 to 22, 0 / 3 / 0 |
| Model slop | median 54, range 47 to 69, 0 / 0 / 7 | median 63, range 46 to 74, 0 / 0 / 3 |

Rank separation, as area under the ROC curve (1 means every slop text outranks every human text):

| Pair | Tuning | Held out |
|---|---|---|
| Model slop against human original | 1.00 | 1.00 |
| Model slop against remediated clean | 1.00 | 1.00 |
| Laundered against human original | 1.00 | 0.89 |

Other checks:

- All clean fixtures score green. The careful probe moved from 7.31 to 0.04. The slop probe stays red.
- Operator-flagged chat replies (11): 8 green, 2 amber, 1 red by score. Nine of the eleven are under 50 words, so a live report gives them findings and no band. Findings, not the score, are what catch these replies.

Validation is not clearly worse than tuning on the slop separation. It is weaker for laundered text, on only three held-out types.

## Limits

- The benchmark is model-written and easy: model slop is far from the other variants on every type, so near-perfect separation says little about subtle drafts.
- Laundered variants land in amber because the laundering component saturates at its ceiling. The meter flags the swapped forms but cannot tell a laundered text from a lightly edited human text with a few dashes. Treat amber as a reason to read again, not as proof.
- The real chat sample is tiny and mostly too short to score reliably. No constant was tuned on it.
- The bands are design constants. They were not fitted to a population of real work. Re-run this procedure when the rule data or the corpus changes.
- A token-free text can still carry the move. A green score is a floor, never acceptance.
