---
name: draft
description: >
  Prevent AI slop in agent-written text: prose written from no position, for a
  scorer or another model instead of a human reader, and the surface tells that
  come with it (dashes as connectors, bold-label bullets, stock buzzwords,
  coined compounds, unexplained codes, meta-openers, signposts, closing offers).
  Use before sending or saving any agent-written text: chat replies, status
  reports, questions to stakeholders, documents, tickets, commit and pull
  request text. Also use when a draft is flagged as slop, AI-sounding or too
  long and needs repair. Runs a prose meter that reports findings and never
  rewrites text. Do not use for code review, factual research, or text that
  must stay verbatim.
compatibility: >
  Needs Node.js 22.19 or newer to run the meter as TypeScript. Uses the sibling
  files `../../docs/conventions/prose-meter.md` for the meter's command and
  report contract and `../../AGENTS.md` for the owning repository's
  commit-message and reporting rules.
---

# Draft

Slop is text written from no position. Nothing in it could be wrong, so the reader learns nothing and must reorganise it before using it. Its surface tells are symptoms: dashes joining unrelated clauses, bold-label bullets, stock importance words, coined terms, signposts and closing offers. Removing a symptom without finding the position leaves the cause, and the cause returns in a neighbouring form. The meter finds symptoms. You supply the position.

A clean meter result is a floor, never acceptance.

## 1. Run the meter

Resolve `scripts/` against this skill's directory. In the repository that is `skills/draft/scripts/`. Run it on every draft that matters before sending or saving it.

```text
node skills/draft/scripts/meter.mts notes.md
printf '%s' "$REPLY" | node skills/draft/scripts/meter.mts --stdin
git diff --staged | node skills/draft/scripts/meter.mts --diff
printf '%s' "$MESSAGE" | node skills/draft/scripts/meter.mts --kind commit
node skills/draft/scripts/meter.mts --help
```

Add `--format json` for the report contract. The meter never rewrites text and has no fix mode.

| Output | Meaning | Required action |
|---|---|---|
| Hard findings (exit 1 or 3) | Rules with no exceptions: dashes as connectors, bold-label bullets, bare URLs and URL anchors, truncated ids, meta-openers, candour frames, compliance narration, and the mechanical commit rules. Each carries a line number. | Remove every one. Repair above the form (section 3). |
| Scored findings and score | Tells judged at density. A single common word costs little. A cluster, or a pattern repeated, dominates. The band is a design constant, not a property of prose. | Read the findings. Fix clusters. Do not chase a number. |
| Calibration line | States the cohort the score was tuned on, or that it is uncalibrated. | Quote the cohort whenever you quote a score. |
| Under 50 words | Findings only. No score gate. | Fix the findings. |

Exit codes: 0 clean, 1 hard findings, 2 score at or above the threshold, 3 both, 4 usage or input error.

## 2. Know the rules

Every rule has an id, a severity, a plain-words meaning and one repair direction. Read what you need, not everything.

- `references/findings.md`: every rule id, what it means and how to repair it. Read it when a finding's meaning or repair is not obvious.
- `references/lexicon.md`: every flagged word and phrase, with the legitimate technical sense that exempts it. Read it before you dismiss a lexical finding or defend a word.
- `references/repair.md`: the repair procedure, claim diff and laundering families. Read it before you repair a flagged draft.
- `references/judgement.md`: failures the meter cannot detect. Each item names the procedure step that handles it. Read it before you declare a draft done.
- `references/calibration.md`: the cohort the score was tuned on, the method and the limits. Read it before you quote or rely on a score.

Both generated files come from `data/rules.json`, the single rule source the meter also reads. To change a rule, edit the data and regenerate with `node skills/draft/scripts/render-references.mts`.

Judge at density. An isolated token is not the failure. A unit where several tells cluster, or where rhythm and structure perform an argument no sentence makes, is. A word in its ordinary technical sense (a test harness, dynamic dispatch) is not a tell.

For the reasoning behind these rules, consult the Pillars entries `principle-unearned-prose`, `heuristic-tell-laundering` and `heuristic-metric-reification` through the `pillars` tool. Do not restate them here or in your output.

## 3. Procedure

1. Write the position first. Before drafting, state in one sentence what the reader should believe, decide or do, and what evidence supports it. If you cannot, you have no position yet. Get one: read the source, run the check, or ask.
2. Draft for a reader who arrives cold. Lead with the answer, the state or the decision. Define each project term at first use, or use an ordinary word. Include only what changes the reader's understanding or next move.
3. Run the meter (section 1).
4. Repair above the form. Follow `references/repair.md`. Rebuild each flagged unit from its claim and evidence, or delete it. Never swap one tell for its neighbour. A dash becoming a semicolon, `pivotal` becoming `crucial` and three items becoming four are all the same tell. Never narrate the repair.
5. Diff your claims against the earlier draft. A claim that got weaker or lost its owner needs a stated reason.
6. Run the meter again. Hard findings must be zero. Then reread the text once for position: could a sentence be wrong, and would the reader act on it?

## 4. By surface

This skill owns the universal standard. Instruction files own register, spelling and reporting rules for their project, and the repository's `AGENTS.md` governs commit messages. This skill adds the meter's checks and does not replace those rules.

- Chat replies and status reports: answer first. Select content for the reader's current task, not the work log. Describe a designed state as expected behaviour, not as a failure. Stop when the answer is complete: no closing menu, no offer.
- Questions to stakeholders: state the decision needed, your recommendation, and the cost of each side. Give the context the reader lacks in two or three sentences.
- Documents and tickets: open with the purpose or the current state, not a statement about the document. Use headings only where the content has parts. Prefer sentences to bold-label bullets.
- Commit and pull request text: pass the message with `--kind commit` and the diff with `--diff`. Explain why the change was needed. Do not narrate steps or restate the diff.

The meter checks Australian spelling in prose by default (`--spelling off` disables it) and never in code, identifiers, quoted literals or URLs. Time-format checks are off unless asked for (`--times 12h`).
