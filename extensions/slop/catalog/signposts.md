---
id: signposts
title: Signposts and announced structure
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Signposts and announced structure

## Recognition

A sentence announces what comes next instead of saying it, such as `Here's the thing`, `Here is the problem as I understand it`, `Underneath all of it is one mistake` or `In summary`. A document that opens with `This document describes` does the same at the top.

## Cost

The reader reads a promise and then has to wait for the content. A reveal such as `one mistake underneath it all` turns a plain answer into an essay with a thesis moment.

## Repair

Delete the signpost and start with the content it announced. Open a document with the answer, the result or the decision. Replacing one signpost with a synonym keeps the same move.

## Examples

Slop:

```reply
Here's the thing. Underneath all of it is one mistake: the cache key ignores the lockfile.
```

Better:

```reply
The cache key ignores the lockfile, so an update keeps the old packages.
```

Slop:

```document
This document describes the release steps for the reader app.
```

Better:

```document
Build the reader app with the release script, then copy it to the Applications folder.
```

## Detectors

```json
[{ "id": "signpost-phrases", "in": ["reply", "document"],
   "phrases": ["here's the thing", "here is the thing", "here is the problem as I understand it", "here's the problem as I understand it", "the problem, restated", "underneath all of it", "underneath it all", "bottom line:", "the bottom line is", "in summary", "to summarise", "to summarize"] },
 { "id": "document-openings", "in": ["document"],
   "pattern": "^\\s*(?:#+\\s*)?(?:this|the following)\\s+(?:document|report|note|page|summary|section|reply)\\s+(?:describes|explains|covers|summari[sz]es|outlines|presents|provides|lists|sets\\s+out)\\b" }]
```
