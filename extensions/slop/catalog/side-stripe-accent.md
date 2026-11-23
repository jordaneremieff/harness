---
id: side-stripe-accent
title: Side stripe accents
domain: ui
applies: ["code"]
prompt: false
---

# Side stripe accents

## Recognition

A card, a block, a callout, a quote, a turn or a panel is marked with a coloured or grey stripe on one side, usually a left border of a few pixels in an accent colour or an inset shadow that draws the same line. It is a stock decoration of generated interfaces.

## Cost

The stripe adds visual weight without meaning, and it repeats on every item until the page reads as a stack of tags. When it carries a state colour, a reader who cannot see the colour well loses the state.

## Repair

Group and distinguish items with spacing, alignment, a surface tint, an icon or type. If a state must show, use a plain label or an icon that keeps its meaning without colour.

## Examples

Slop:

```css
.tool-card { border-left: 3px solid var(--accent); padding-left: 12px; }
```

Better:

```css
.tool-card { background: var(--surface-tint); border-radius: 8px; padding: 12px; }
```

Slop:

```css
.callout { box-shadow: inset 4px 0 0 var(--warn); }
```

Better:

```css
.callout { background: var(--warn-tint); }
```

Slop:

```tsx
<div className="border-l-4 border-blue-500 pl-3">{children}</div>
```

Better:

```tsx
<div className="rounded-lg bg-slate-50 p-3">{children}</div>
```

## Detectors

```json
[{ "id": "one-side-borders", "in": ["code"],
   "pattern": "\\bborder-(?:left|right|inline-start|inline-end)(?:-width)?\\s*:\\s*(?:[2-9]|\\d{2,})(?:\\.\\d+)?px\\b|\\bbox-shadow\\s*:\\s*inset\\s+-?(?:[2-9]|\\d{2,})(?:\\.\\d+)?px\\s+0(?:px)?\\s+0(?:px)?\\s|(?<![\\w-])border-[lrse]-(?:[2-9]|\\d{2,}|\\[\\d+px\\])(?![\\w-])" }]
```

## Notes

A one pixel rule between two panes is a divider, not a stripe on an item, and the detector allows it. A diff view that marks changed rows has a real need to show change, but a tint or a gutter sign shows it without the stripe.
