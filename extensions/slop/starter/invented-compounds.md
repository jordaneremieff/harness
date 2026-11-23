---
id: invented-compounds
title: Invented hyphen compounds
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Invented hyphen compounds

## Recognition

Words glued together with hyphens for the occasion, such as `silent-narrow` or `owner-scoped retry-budget`, stand where an ordinary phrase exists. Established compounds are a different thing. Credential, sector and grammatical compounds such as `person-centred`, `read-only` or `third-party` are normal English and stay.

## Cost

The reader has to decode a private term that the writer never defined. A cluster of them makes a sentence sound technical while it hides what happens. In letters and applications, the coinages make the text read as generated.

## Repair

Replace each coined compound with the plain words it stands for, even when the sentence gets longer. If the reader needs an exact name that exists outside the text, such as a command, a flag or a file, put it in backticks. Swapping the hyphen for a space or a slash keeps the coinage.

## Examples

Slop:

```reply
The silent-narrow path keeps the owner-scoped retry-budget logic in a single-writer lane.
```

Better:

```reply
When the check fails, the path quietly drops the extra results. Only one process writes the retry count, and the read-only view shows it.
```

Slop:

```document
I bring a people-first, results-driven approach to cross-team delivery.
```

Better:

```document
I lead small teams and judge progress by what ships. I have run three product launches.
```

## Detectors

```json
[{ "id": "coinages", "in": ["reply", "document"],
   "pattern": "(?<![\\p{L}\\p{N}_./@#$-])(?!(?:non|pre|re|multi|co|sub|semi|anti|un|post|mid|inter|intra|counter|de)-\\p{L}+(?![\\p{L}\\p{N}_-]))(?!(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|first|second|third|fourth|fifth|half|single|double|triple|zero)-)(?!(?:option|control|command|shift|alt|ctrl|cmd|fn|meta)-)(?!out-of-)(?!\\p{L}-)(?!\\p{L}+-(?:like|only|specific|wide)(?![\\p{L}\\p{N}_-]))\\p{L}+(?:-\\p{L}+){1,12}(?<!-\\p{L})(?![\\p{L}\\p{N}_/-]|\\.\\p{L})",
   "limit": 2, "per": 200, "distinct": true, "lexicon": true,
   "allow": ["read-only", "built-in", "follow-up", "follow-ups", "one-off", "real-time", "third-party", "open-source", "end-to-end", "up-to-date", "out-of-date", "well-known", "long-running", "long-lived", "short-lived", "high-level", "low-level", "top-level", "self-contained", "cross-platform", "case-insensitive", "case-sensitive", "full-text", "plain-text", "e-mail", "co-author", "co-authored-by", "re-run", "re-read", "pre-commit", "commit-msg", "post-commit", "non-empty", "non-zero", "opt-in", "opt-out", "sign-in", "log-in", "add-on", "add-ons", "check-in", "check-ins", "hand-off", "set-up", "front-end", "back-end", "day-to-day", "so-called", "first-class", "user-facing", "multi-line", "single-line", "step-by-step", "side-by-side", "line-by-line", "well-formed", "dry-run", "drag-and-drop", "copy-paste", "fast-forward", "force-push", "person-centred", "person-centered", "child-centred", "trauma-informed", "evidence-based", "full-time", "part-time", "long-term", "short-term", "year-old", "x-ray", "know-how", "in-house", "on-site", "off-site", "face-to-face", "hands-on", "decision-making", "problem-solving", "well-being", "co-operate", "co-ordinate", "self-hosted", "open-ended", "one-time", "in-flight", "in-memory", "wall-clock", "no-op", "non-null", "exactly-once", "at-least-once", "round-trip", "trade-off", "trade-offs", "sign-off", "write-up", "lock-in", "follow-on", "built-ins", "how-to", "to-do", "right-click", "plain-language", "state-of-the-art", "proof-of-concept", "end-of-life", "mixture-of-experts", "man-in-the-middle", "point-of-view", "line-of-sight", "single-sign-on", "long-standing", "old-fashioned", "self-explanatory", "cost-effective", "time-consuming", "error-prone", "open-minded"] }]
```

## Notes

Judge at density. One established compound in a paragraph is ordinary writing, while three coinages in two sentences are the tell. Add terms that are normal in the operator's field to the configured lexicon rather than to this entry. The detector leaves out a common prefix such as `non` or `re` before one word, compounds that start with a number word or a key name such as `Option-Return`, terms with a single letter at either end, and parts of paths and file names.
