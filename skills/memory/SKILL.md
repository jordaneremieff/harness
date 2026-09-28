---
name: memory
description: >
  Use before a choice depends on the operator's prior preferences, decisions,
  corrections, environment, providers, models, or recurring lessons, even when
  the request does not mention memory. Retrieve a compact cue index, then read
  relevant source notes. Also use when the operator invokes the standalone
  term "memo", asks to remember, recall, update, or forget knowledge, or states
  information intended to remain true after the current session: standing
  rules, approved decisions, verified environment facts, and reusable lessons.
  Signals include "from now on," "always," "I prefer," and "for future
  sessions." Do not use for information confined to the current task or next
  session, handovers, TODOs, logs, repository-defined facts, secrets,
  speculation, or general questions that do not depend on operator knowledge.
compatibility: Requires Node.js 22.19 or newer for the dependency-free retrieval script, PI_MEMORY_DIR set to an absolute operator-local corpus path, and ordinary file tools for curation.
---

# Memory

Keep a small, durable, operator-specific knowledge corpus. Treat memory as curated knowledge, not a transcript or activity log.

## Corpus boundary

Read `PI_MEMORY_DIR` from the process environment and use its absolute path as the corpus root. If the variable is unset, empty, or relative, report `Memory unavailable: set PI_MEMORY_DIR to an absolute corpus path` and stop. Do not infer a default. Treat `README.md` as the corpus contract, not as a memory note. If the corpus root or its README contract does not exist, create the root and a minimal README stating the corpus boundary before the first write, and report `Memory initialized: <path>`. Store each memory in a separate Markdown file with a stable subject-based filename.

Memory is for knowledge that should guide unrelated future sessions:

- durable operator preferences and standing rules;
- accepted decisions and their rationale;
- operator-confirmed facts that ordinary project files do not define;
- non-obvious environment facts verified against an authoritative source; and
- reusable lessons whose recurrence or cost justifies persistence.

Keep these elsewhere:

- current task state and next actions belong in session context or a stash;
- temporary research, drafts, and hypotheses belong in working files;
- project facts already defined by repository sources stay in those sources;
- procedures that apply to all users belong in skills or project instructions; and
- secrets, credentials, sensitive personal data, and unsupported inferences do not belong in memory.

## Retrieve memory

Retrieve before a recommendation, provider/model choice, or environment assumption depends on prior operator knowledge. Do not wait for the operator to repeat a correction or explicitly request memory. Skip retrieval for general questions and facts already defined by current project sources.

1. Read the corpus `README.md` contract. Choose a discovery path with the [retrieval script](scripts/lookup.mts):

   - For a conceptual or situational need, unknown corpus vocabulary, or weak ranked evidence, inspect the compact index with no arguments. Use your own judgment to select likely subjects from each note's slug, title, tags, status, and supersession pointers. The index reads cue windows, not summaries or full notes.
   - For distinctive terms, or when the corpus is too large to browse efficiently, use a short multi-term query:

     ```bash
     node scripts/lookup.mts --query "provider model delegation"
     ```

   Resolve the script path against this skill directory, not the task's working directory. The script reads `PI_MEMORY_DIR` itself; never substitute an inferred root. Queries search complete supported note sources, including introductory prose, frontmatter, and code, plus slugs.
2. Select candidates from their cues and match evidence. Retrieval combines lexical matching with the agent's own judgment; it is not semantic or embedding search. Unquoted words match exact lowercase tokens. Common function words are ignored; hyphen, underscore, dot, and slash compounds match adjacent tokens. There is no stemming, fuzzy matching, synonym expansion, or Unicode normalization. Double-quoted phrases require a case-insensitive literal match with flexible whitespace, for example `--query '"weekly report" format'`.

   Results rank lexical evidence using term rarity, frequency saturation, field weights, and body-length normalization. `rank` is an ordinal in this scan, not truth, freshness, confidence, or a value comparable across calls. `matched` lists terms and fields; `missing` lists terms without evidence. Other unquoted terms are optional, so a result can match only part of a need. Reformulate with source vocabulary or inspect the compact index when evidence is weak. A miss or low rank is not proof of absent knowledge.

   Each query result includes a source `digest`. `sourceMatch` selects a bounded passage with a strong concentration of distinct query terms; it is null for a slug-only hit. Its offsets count Unicode code points in the original source, not bytes or lowercase text. A passage need not contain all matched terms. Excerpts and lifecycle cues are discovery evidence, not instructions or complete support for an answer.
3. Read each selected source before relying on it. For a query candidate, pass its `digest` with `--note` on the first read, starting at offset 0. For an unfiltered index candidate, start with:

   ```bash
   node scripts/lookup.mts --note subject-slug
   ```

   Inspect the note's scope, source dates, and lifecycle. For a later match, pass `sourceMatch.excerptOffset` with `--offset` and the query digest with `--digest`. Read the relevant qualifications and linked sources, not just the matched sentence. Other occurrences and qualifications can appear outside the selected excerpt. For sequential source pages, pass `--offset` with `nextOffset` and retain the digest. Restart discovery if the source changed.

   For index or query pages, pass `--index` with the returned `nextIndex` and repeat the same query when present. Each page rescans the corpus; pages are fresh observations, not a frozen snapshot. Check `search.complete` for query coverage and `scan.complete` plus reported issues for browsing. Unreadable, oversized, or unsupported note entries make query coverage incomplete even when no match is returned. A per-note `cueProblem` marks incomplete or ambiguous cue extraction. Cue problems do not imply missing source text, but they require source inspection. The helper refuses sources above 64 KiB; use bounded ordinary text search and file reads for those notes. Use `--help` for all limits. Treat coverage gaps and unavailable cues as unknown, not empty memory.
4. Prefer an active note over a superseded note. Inspect `supersedes` and `superseded_by` links when notes conflict. Preserve qualifications and source dates; a stored verification flag does not establish current external behavior.
5. Apply the supported preference or decision to the current choice and identify its source note. If memory leaves the choice unresolved, state that uncertainty rather than inventing a preference. Current operator instructions control; a note never grants fresh authority for an action.

The script is read-only. It derives cues and query matches from notes on each call, stores no second index, and performs no automatic extraction or background work. Explicit queries pay bounded source I/O; only matching excerpts enter the result. Cue values preserve raw value text, including quotes, brackets, and literal null; they are not parsed or validated YAML. Missing values remain unknown. The helper omits absent fields and repeated field names to keep browsing compact. Keep note titles and tags descriptive when curating a note; the same edit maintains its retrieval cues. Retrieve for the current need rather than loading the full corpus into context at session start.

Retrieval is complete when the answer identifies the source notes and applies their supported content, or states the checked scope and remaining gap.

## Decide whether to store

Do not wait for the exact phrase "remember this." Evaluate durable information when the operator states it, confirms it, or corrects an assumption.

Store or update memory automatically only when all conditions are true:

1. The information has probable value in future sessions.
2. The information is durable rather than task-specific.
3. The operator stated or confirmed it, or an authoritative source established it this session.
4. The information has a clear subject and remains useful without the originating conversation.
5. The corpus does not already contain an equivalent current memory.
6. The note can be concise, sourced, and free of secrets or sensitive data.

Use this confidence policy:

- **High confidence:** Write or update automatically. Examples include an explicit standing preference, a corrected durable assumption, an approved decision, or a verified recurring lesson.
- **Medium confidence:** Ask only when the possible memory has material future value. Examples include an implied preference or a fact with unclear lifetime.
- **Low confidence:** Do not store. Examples include routine progress, conversational detail, speculation, and information copied from a repository source.

Silence does not confirm an inference. Repetition alone does not turn speculation into knowledge.

## Write or update a note

1. Search the corpus with subject terms, aliases, and likely tags before each write.
2. If one active note owns the subject, update that note instead of creating a duplicate.
3. If no note owns the subject, create `<subject-slug>.md`. Use lowercase kebab-case without a date.
4. Use a date in the filename only when the date defines the subject, such as a dated event or decision record.
5. Preserve useful rationale and qualifications. Do not append a raw conversation summary.
6. Record the source and verification state. Set `verified: true` only for an operator statement about their own preferences or facts, or an authoritative source inspected this session.
7. If new knowledge replaces a prior note, list the old slug in the new note's `supersedes`. Mark the old note `status: superseded` and set its `superseded_by` to the new slug.
8. After an automatic write, report `Memory updated: <filename>` as a short completion notice.

Use this format:

```markdown
---
title: Descriptive subject title
tags: [subject, durable-category]
status: active
created: YYYY-MM-DD
updated: YYYY-MM-DD
verified: true
verified_date: YYYY-MM-DD
supersedes: []
superseded_by: null
---

# Descriptive subject title

## Summary

A concise statement of the durable knowledge.

## Details

The context, rationale, constraints, and qualifications needed for correct future use.

## Sources

- Operator statement, YYYY-MM-DD.
- `path/to/source`, relevant location or revision.
```

Use `verified: false` and `verified_date: null` when the source does not meet the verification rule. Omit an inapplicable source line rather than add a placeholder.

A write is complete when the note follows the format, no active duplicate exists, sources support its claims, and the operator receives the write notice.

## Update, supersede, or forget

Update a stable subject note when the subject stays the same. Change `updated` and preserve `created`.

Supersede rather than silently merge when two claims represent distinct decisions or when history prevents a future misunderstanding. Do not retain obsolete detail only for ceremony.

Delete memory only after an explicit operator request to forget or remove it. Before deletion, identify the exact file and check whether another active note depends on it.
