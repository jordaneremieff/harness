# clipboard: macOS clipboard tools and history

This extension provides agent clipboard I/O and an operator-facing history browser. It intentionally targets macOS `pbcopy` and `pbpaste`.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| `clipboard_copy` | tool | Write via stdin-fed `pbcopy` and archive the write. |
| `clipboard_paste` | tool | Read the current clipboard in bounded pages. |
| `clipboard_list` | tool | List archived entries, newest first, with the stable ids used by the other tools. |
| `clipboard_get` | tool | Read one archived entry by stable id, in bounded pages. |
| `clipboard_restore` | tool | Copy one archived entry back to the clipboard; the restore is archived as a new entry. |
| `/clipboard` | command | Filter, preview, and restore history in an overlay. |

Each tool is one operation; there is no action multiplexer, and the model-facing
API has no transient index addressing — stable ids are the only entry handle.
`clipboard_paste` and `clipboard_get` return at most 8,000 Unicode characters per page, subject to the stricter 50 KiB and 2000-line output bounds. A `nextOffset` tells the caller how to continue.

## Storage

History is one append-only JSONL file per local calendar day at `<agentDir>/clipboard/YYYY-MM-DD.jsonl`. `PI_CLIPBOARD_DIR` overrides the location.

- Each new entry has a UUID. Legacy records receive deterministic ids based on source date and physical line number.
- Directory and file modes are re-enforced as `0700` and `0600` on use.
- Appends use `O_APPEND` and `O_NOFOLLOW` where available.
- Reads reject a symlinked store, ignore symlinked archives, skip malformed records, and recompute derived metadata from validated content.
- Readers scan files and records newest-first in bounded chunks. Lists stop after the requested page and retain no body content; the browser retains at most 32,768 characters per entry. Stable-id lookup refetches the full selected record without materializing a whole daily archive.
- Individual JSONL records are capped at 64 MiB. This contains malformed or unexpectedly large historical data while accommodating the tool's 8 MiB input limit and JSON escaping.
- Restores append a new `(restored)` entry because they are real clipboard writes.

A successful `pbcopy` followed by an archive failure is reported as a successful copy or restore with a warning. A `pbcopy` failure remains an error and does not append a false history event.

## Retention and deletion

History is retained until the operator removes it; there is no silent age-based pruning. Physical deletion is intentionally daily-file granular. A closed day's `<agentDir>/clipboard/YYYY-MM-DD.jsonl` can be removed directly on an explicit operator request. The current day's file should not be removed while sessions may be appending to it.

Entry-level deletion would require coordinated rewrites or tombstones across processes. That machinery is deferred until an observed need justifies it; an unsafe rewrite would reintroduce the cross-session data-loss race this store removed.

## Browser behavior

The overlay loads the newest 200 entries and marks the count with `+` when older history exists. It supports live filtering across labels, ids, and loaded body prefixes. Up/Down selects entries, Left/Right scrolls the preview by a page, Enter restores, and Escape clears or closes. A truncated preview is labeled. Restore resolves the selected stable id again and writes the full archived content, so preview bounds never truncate the clipboard result.

The component is the sole height authority. It reads the host TUI row count and the overlay host does not impose `maxHeight`, which prevents Pi from slicing away the footer. Every rendered row paints the full width inside a background-backed frame. The footer is always the final row, including `40x10` and `50x12` terminals. Labels, previews, content, and error text have terminal and bidi controls escaped before custom rendering.

## Files

- `index.ts`: the clipboard tools and the `/clipboard` host.
- `store.ts`: private append-only archive and stable-id resolution.
- `pb.ts`: no-shell `pbcopy` and `pbpaste` wrappers.
- `panel.ts`: browser state and rendering.
- `text.ts`: terminal-safe text and output bounds local to this extension.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
npm test
# full suite passes; clipboard coverage in extensions/clipboard/*.test.mts

pi -e . --mode rpc --no-session --offline
```

Verified with:

- mocked subprocess integration for copy, stable-id restore after a newer append shifted indexes, paging, tool error signaling, and failed-write clipboard preservation;
- real PTY captures at `120x40`, `80x24`, `60x16`, `50x12`, and `40x10`;
- live filtering and successful restore;
- a live PTY with a failing `pbcopy` shim, where the error stayed in the overlay and the pre-existing clipboard fixture remained unchanged;
- isolated tarball installation and package loading.
