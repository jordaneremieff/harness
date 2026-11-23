---
id: open-labels
title: Labels that say open
domain: ui
applies: ["code"]
prompt: false
---

# Labels that say open

## Recognition

A control or a status reads `Open`, `Open in pane`, `Opened` or similar. The word itself is a weak signal, but it tends to sit on an interaction that makes the person manage windows, panes or dialogs before they reach the content.

## Cost

The person has to perform a step that the interface could have taken for them, and the label does not say what they will see. A synonym such as `Show` or `View` keeps the same extra step.

## Repair

Look at the interaction around the word before the word. Show the content where the person already is, or name the thing they will see, and remove the step if it serves no choice.

## Examples

Slop:

```tsx
<button onClick={openPane}>Open</button>
```

Better:

```tsx
<ResultPreview result={result} />
```

## Notes

This is a cue for review, not a rule about one word. Leave protocol identifiers and supplied content alone.
