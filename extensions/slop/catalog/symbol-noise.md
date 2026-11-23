---
id: symbol-noise
title: Decorative symbols and hidden controls
domain: ui
applies: ["code"]
prompt: false
---

# Decorative symbols and hidden controls

## Recognition

The interface relies on symbols that carry no clear meaning: chevrons and carets on every row, an ellipsis button that hides the actions, bare `+` and `!` marks as state, an icon on a line that looks like a control but does nothing, and raw ids shown where a name would do. Hover text appears on every item instead of on the controls that need it.

## Cost

The person has to guess what each mark means and which marks are controls. Actions hidden behind an overflow button are slow to find, and ids give the person nothing to recognise.

## Repair

Name actions with clear icons or words, show state in plain words or in marks with one meaning each, and show people by name and items by title. Give hover help only to icon controls whose name is not visible.

## Examples

Slop:

```tsx
<Row title={session.id} trailing={<MoreButton label="…" />} badge="!" />
```

Better:

```tsx
<Row title={session.name} state={session.failed ? "Failed" : undefined} actions={[rename, remove]} />
```
