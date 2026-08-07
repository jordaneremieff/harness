---
name: memory
description: >
  Manage durable operator memory as curated plain Markdown under the corpus root configured by PI_MEMORY_DIR. Use when the operator invokes the standalone term "memo" to create or update memory. Also use whenever the operator states information intended to remain true after the current session, even without mentioning memory. This includes preferences, corrections to durable assumptions, standing rules, approved decisions, verified environment facts, and reusable lessons; signals include "from now on," "always," "I prefer," and "for future sessions." Also use to remember, recall, update, or forget prior knowledge. Do not use for information scoped to the current task or next session, handovers, TODOs, logs, repository-defined facts, secrets, or speculation.
compatibility: Requires PI_MEMORY_DIR to contain an absolute path to the operator-local memory corpus, plus ordinary file search, read, and write tools.
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

Search memory when a request depends on prior operator preferences, decisions, corrections, environment facts, or lessons.

1. List candidate Markdown files and search filenames, frontmatter, headings, tags, and body text with ordinary file tools.
2. Read each likely source note before relying on it. A search match is only a candidate.
3. Prefer an active note over a superseded note. Follow `supersedes` links when notes conflict.
4. State uncertainty when no note answers the question. Do not invent an operator preference or past decision.
5. Read only relevant notes. Do not load the full corpus at session start.

Retrieval is complete when the answer cites or clearly identifies the source note, or reports that no relevant memory exists.

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
