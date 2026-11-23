---
id: generic-chat-chrome
title: Generic chat app chrome
domain: ui
applies: ["code"]
prompt: false
---

# Generic chat app chrome

## Recognition

An interface looks like every other generated chat app: filled message bubbles, bordered cards and buttons everywhere, a lavender accent, glowing focus rings, round send buttons, floating pill chips, `You` and `Assistant` headers, and labels scattered around the input. The chrome takes more room than the work.

## Cost

The reader has to look past decoration to find the conversation and the tools. Text labels and boxes compete with content, and the page feels busy without being more capable.

## Repair

Remove chrome around the work and keep every function reachable. Carry meaning with type, spacing, alignment, colour used for state and syntax, and icons, and keep words only where they inform. Rich tool and message blocks are welcome. Noisy frames around them are the tell.

## Examples

Slop:

```css
.message { border: 1px solid var(--lavender); border-radius: 18px; box-shadow: 0 0 12px var(--glow); }
.chip { border-radius: 999px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.2); }
```

Better:

```css
.message { padding: 8px 0; }
.chip { color: var(--muted); }
```

## Notes

Minimal here means little clutter and little text. It does not mean colourless, flat or austere, and it never means removing capability.
