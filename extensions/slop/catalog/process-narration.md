---
id: process-narration
title: Process narration
domain: prose
applies: ["document", "commit"]
prompt: false
---

# Process narration

## Recognition

A document or a commit message tells the story of the work, such as `I checked the config, then I ran the tests, then I read the logs`, instead of the result. The steps fill the space where the finding should be.

## Cost

The reader has to read the diary to find the conclusion. Commit messages that list actions do not say what the repository now does or why.

## Repair

Say what you found and why it matters. Mention a step or a check only when the reader needs it to trust the result, and then name the check and its outcome.

## Examples

Slop:

```document
First I checked the config. Then I ran the tests. I also looked at the logs and I searched the issue tracker.
```

Better:

```document
The importer fails on files over 2 MB because it reads the whole file into memory. A streaming read fixes it, and the import test now covers a 10 MB file.
```

## Detectors

```json
[{ "id": "first-person-steps", "in": ["document", "commit"],
   "pattern": "(?:^|[.!?]\\s+)(?:(?:first|then|next|after that|finally|also),?\\s+)?(?:I|we)\\s+(?:then\\s+|first\\s+|also\\s+|next\\s+)?(?:checked|ran|read|reread|looked|opened|inspected|searched|reviewed|verified|traced|grepped|scanned|examined|went\\s+through|tested)\\b",
   "limit": 2, "per": 300 }]
```

## Notes

A reply to a person can name what was checked, because the reader needs it to judge the claim. This entry applies to documents and commit messages, where the result is what lasts.
