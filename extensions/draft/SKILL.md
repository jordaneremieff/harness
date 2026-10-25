---
name: draft
description: >
  Prevent AI slop in agent-written text: prose written from no position, for a
  scorer or another model instead of a human reader, and the surface tells that
  come with it (dashes as connectors, bold-label bullets, stock buzzwords,
  coined compounds, unexplained codes, meta-openers, signposts, closing offers).
  Use on final text that leaves the chat after facts, evidence and position
  are settled: documents, tickets, commit messages, pull request descriptions
  and questions for other people outside the chat. Also use when such text is
  flagged as slop, AI-sounding or too long and needs repair. Do not call the
  draft tool on chat replies or status reports; the reply check checks final
  chat replies automatically. After a reply-check repair, send the repaired
  reply without another draft call. Do not use on notes, intermediate drafts,
  work in progress, code review, factual research or text that must stay
  verbatim. The draft tool reports findings and never rewrites text.
compatibility: >
  Requires the draft extension and its draft tool in Pi. The optional shell CLI
  needs Node.js 22.19 or newer. Repository instructions govern local reporting
  and commit-message rules.
---

# Draft

Slop is text written from no position. Nothing in it could be wrong, so the reader learns nothing and must reorganise it before using it. Its surface tells are symptoms: dashes joining unrelated clauses, bold-label bullets, stock importance words, coined terms, signposts and closing offers. Removing a symptom without finding the position leaves the cause, and the cause returns in a neighbouring form. The meter finds symptoms. You supply the position.

A clean meter result is a floor, never acceptance.

## 1. Check the final text

Use the `draft` tool once after facts, evidence and position are settled. Pass
exactly one of `text` or a saved file `path`, with `kind` set to `prose`,
`commit`, or `diff`. Check only text the automatic reply check does not see:
documents, tickets, commit messages, pull request descriptions and other text
that leaves the chat. Do not call the tool on chat replies or status reports.
The reply check checks final chat replies automatically. After a reply-check
repair, send the repaired reply without another draft call. Do not check notes,
intermediate drafts or work in progress.

The tool never rewrites text. Shell workflows outside Pi retain the CLI for
commit messages and unified diffs; see [README.md](README.md#shell-use).

| Output | Meaning | Required action |
|---|---|---|
| Hard findings | Rules with no exceptions: dashes as connectors, bold-label bullets, bare URLs and URL anchors, truncated ids, meta-openers, candour frames, compliance narration, and the mechanical commit rules. Each carries a line number. | Remove every one. Repair above the form (section 3). |
| Scored findings and score | Tells judged at density. A single common word costs little. A cluster, or a pattern repeated, dominates. The band is a design constant, not a property of prose. | Read the findings. Fix clusters. Do not chase a number. |
| Calibration line | States the cohort the score was tuned on, or that it is uncalibrated. | Quote the cohort whenever you quote a score. |
| Under 50 words | Findings only. No score gate. | Fix the findings. |

## 2. Know the rules

Every rule has an id, a severity, a plain-words meaning and one repair direction. Read what you need, not everything.

- `references/findings.md`: every rule id, what it means and how to repair it. Read it when a finding's meaning or repair is not obvious.
- `references/lexicon.md`: every flagged word and phrase, with the legitimate technical sense that exempts it. Read it before you dismiss a lexical finding or defend a word.
- `references/repair.md`: the repair procedure, claim diff and laundering families. Read it before you repair a flagged draft.
- `references/judgement.md`: failures the meter cannot detect. Each item names the procedure step that handles it. Read it before you declare a draft done.
- `references/calibration.md`: the cohort the score was tuned on, the method and the limits. Read it before you quote or rely on a score.

The generated files come from `data/rules.json`, the single rule source the meter also reads. To change a rule, edit the data and regenerate with `node extensions/draft/scripts/render-references.mts`.

Judge at density. An isolated token is not the failure. A unit where several tells cluster, or where rhythm and structure perform an argument no sentence makes, is. A word in its ordinary technical sense (a test harness, dynamic dispatch) is not a tell.

For the reasoning behind these rules, consult the Pillars entries `principle-unearned-prose`, `heuristic-tell-laundering` and `heuristic-metric-reification` through the `pillars` tool. Do not restate them here or in your output.

## 3. Procedure

1. Write the position first. Before drafting, state in one sentence what the reader should believe, decide or do, and what evidence supports it. If you cannot, you have no position yet. Get one: read the source, run the check, or ask.
2. Draft for a reader who arrives cold. Lead with the answer, the state or the decision. Define each project term at first use, or use an ordinary word. Include only what changes the reader's understanding or next move.
3. For text that leaves the chat, run the meter once (section 1). For chat replies and status reports, let the automatic reply check run.
4. Repair above the form. Follow `references/repair.md`. Rebuild each flagged unit from its claim and evidence, or delete it. Never swap one tell for its neighbour. A dash becoming a semicolon, `pivotal` becoming `crucial` and three items becoming four are all the same tell. Never narrate the repair.
5. Diff your claims against the earlier draft. A claim that got weaker or lost its owner needs a stated reason.
6. Remove every hard finding. Reread the text once for position: could a sentence be wrong, and would the reader act on it? After a reply-check repair, send the repaired reply without another draft call.

## 4. By surface

This skill owns the universal standard. Instruction files own register, spelling and reporting rules for their project, and the repository's `AGENTS.md` governs commit messages. This skill adds the meter's checks and does not replace those rules.

- Chat replies and status reports: answer first. Select content for the reader's current task, not the work log. Describe a designed state as expected behaviour, not as a failure. Stop when the answer is complete: no closing menu, no offer.
- Questions to stakeholders: state the decision needed, your recommendation, and the cost of each side. Give the context the reader lacks in two or three sentences.
- Documents and tickets: open with the purpose or the current state, not a statement about the document. Use headings only where the content has parts. Prefer sentences to bold-label bullets.
- Commit and pull request text: pass the message with kind `commit` and the diff with kind `diff`. Explain why the change was needed. Do not narrate steps or restate the diff.

The meter checks Australian spelling in prose, but not in code, identifiers, quoted literals or URLs. The CLI exposes optional spelling and time-format flags.
