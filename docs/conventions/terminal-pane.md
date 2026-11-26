# Terminal pane presentation

This package-level contract lets a local operator action start its own fixed program in a new
terminal split beside the invoking conversation, or in a floating pane over its tab. The terminal integration owns target validation
and creation. The consumer owns its program, arguments and application acceptance. Neither side
imports the other extension. This is a fixed subprocess interface, not a tool bus or general API
bridge. It creates no ownership store, service or background watcher.

## Request

Invoke the Rex-owned adapter as a fixed Node subprocess:

```text
node <package>/extensions/rex/terminal-pane.ts split
```

Send one UTF-8 JSON record on stdin, at most 16384 bytes:

```ts
{
  version: 1;
  origin: TerminalOrigin | null;
  argv: string[];
  cwd: string;
  placement?: { side: "left" | "right" | "below"; share: number };
  label?: string;
}
```

`origin` is the unchanged opaque result of the [terminal-origin capture](terminal-origin.md)
from this local opening process. The adapter alone interprets its exact fields. It refuses an
absent exact origin or inherited server or block hints that differ from that origin. It never
chooses global focus, a default server or another tab.

`placement` is optional and defaults to `{ side: "right", share: 0.5 }`. `share` is the new
pane's share of the split space and is inclusive from 0.15 to 0.85. `side: "left"` maps to a
horizontal split before the anchor with ratio `share`; `side: "right"` maps to a
horizontal split after the anchor with ratio `1 - share`; `side: "below"` maps to a vertical
split after the anchor with ratio `1 - share`. `label` is optional, defaults to `Reader`, and
contains 1 to 32 printable Unicode characters: one to 32 code points with no control, format or
surrogate characters.

`argv` contains 1 to 64 strings, each at most 4096 UTF-8 bytes, with no NUL. Its first string is
an absolute executable path. `cwd` is an absolute, NUL-free path of at most 4096 UTF-8 bytes.
The caller constructs the program from its own supported configuration and fixed arguments.
Document source, provenance, links and remote records never supply executable paths or command
strings. Arguments execute directly with the terminal flavour's `shell: "none"`; no shell
interpolation occurs. The terminal's documented working-directory semantics still apply.

## Effect and result

The adapter uses the trusted Rex executable from the terminal-origin contract. It removes
inherited Rex routing variables from the child environment, supplies the exact server and runs
`rex do --block` for the anchor block, so Rex attaches the request to the session that holds the
anchor at that time. A block keeps its ID when its tab moves to another session, so no request
names a session from an earlier one. The adapter disables autostart and checks host/instance
identity on the same connection as its single `session.new_split` call. It finds the verified
terminal block in that session's window layout, then uses that full block ID as the explicit
split anchor. The public Rex API owns splitting,
startup and exit behaviour. The split uses the requested side and share. Its label defaults to `Reader`. The split does not take focus. Rex ends zoom in
that tab as part of its defined split behaviour. When the server
is a local Unix socket and the stacking helper is available, the adapter starts the program with
the [pane stacking](pane-stacking.md) offer in its environment, so a program that places its own
window over the pane learns from Rex's layout which content lies above it.

One creation attempt is the maximum. A post-create read checks that the new block and anchor
occupy the same tab. Moving the conversation before creation, to another tab or another session,
follows its exact block, not a remembered tab or session. Concurrent movement that prevents
confirmation remains uncertain.

The adapter prints one JSON record and exits zero for domain results:

```ts
{
  version: 1;
  outcome: "created" | "stale" | "unavailable" | "uncertain";
  detail: string; // one line, at most 256 UTF-8 bytes
  receipt?: {
    server: string; hostId: string; instanceId: string;
    anchorId: string; blockId: string;
    direction: "horizontal" | "vertical";
    before?: true; // the new block is left of the anchor
  };
}
```

- `created` includes a validated receipt with exact IDs and same-tab placement observed after
  creation. It does not establish that the program accepted its input, that a native window
  rendered, or that a client displays the tab.
- `stale` means identity or membership no longer agrees before creation, including an invoking
  block that no session holds any more. No alternate target receives the program.
- `unavailable` means an exact origin, server identity or trusted executable was unavailable
  before creation.
- `uncertain` means a dispatched operation, its acknowledgement or its resulting placement did
  not receive confirmation. A known receipt stays in the result. Do not retry automatically,
  fall back to another tab or application window, or close an unconfirmed block.

The child deadline is five seconds, with a three-second CLI request timeout and at most 32768
bytes per output stream. The caller allows process startup in its own deadline. A caller timeout,
abort, malformed output or lost connection after dispatch is also an uncertain effect. Invalid
stdin produces a bounded stderr line and nonzero exit without creation.

Consumers retain the receipt unchanged with their local presentation result. Receipt identity
is local opening context, not document metadata or permission for later effects. The adapter
never reuses, types into, closes or cleans up existing panes. The new program owns its terminal
lifetime; normal completion closes the pane under Rex's exit policy, while a quick failure stays
available for inspection. Later resource changes need the exact receipt and their own authority.

## Float over the invoking tab

Invoke `node <package>/extensions/rex/terminal-pane.ts float` with one UTF-8 JSON record on
stdin, at most 16384 bytes:

```ts
{
  version: 1;
  origin: TerminalOrigin | null;
  argv: string[];
  cwd: string;
  bounds: [x: number, y: number, width: number, height: number];
  square?: true;
  label?: string;
}
```

`origin`, `cwd` and `label` follow the split request. `argv` holds 1 to 64 strings, each at most
8192 UTF-8 bytes, with no NUL; its first string is an absolute executable path. `bounds` places
the pane as fractions of the tab that holds the anchor: `x` and `y` are its top-left corner, and
`width` and `height` are at least 0.1. The rectangle stays inside the tab.

The adapter makes the identity checks of a split, then one `session.new_layer` call for the
window that holds the anchor at that time. With `square`, the adapter replaces the height with the
one that makes the pane square on screen: it takes the tab's shape from the anchor terminal's pixel
size and its place in the tab, and keeps the height inside the tab and at least 0.1. Without a
reported terminal size, the given height applies. The new floating layer does not take focus. Its
program runs through the account's login shell with its interactive startup files, so the
program finds the commands and environment of the operator's own terminals; Rex passes the
arguments to the program unchanged, without shell interpolation. Normal completion closes the
pane under Rex's exit policy. A post-create read checks that the new block is in the anchor's
tab.

The result has the split result's shape and outcomes. A `created` result carries
`{ server, hostId, instanceId, anchorId, blockId, layerId }` with exact IDs. One creation attempt
is the maximum; the deadlines, output bounds and uncertain-effect rules of a split apply.

## Resize a confirmed split

Invoke `node <package>/extensions/rex/terminal-pane.ts resize` with one bounded JSON record:

```ts
{ version: 1; receipt: PaneReceipt; share: number }
```

Pass the receipt from a `created` result unchanged. The new pane's share is inclusive from
0.1 to 0.9. The adapter checks the inherited anchor, server host and instance, and that one
window of the session that holds the anchor now holds both blocks. Rex selects the innermost
split in the receipt's direction and block order. The ratio is `share` for a left pane and
`1 - share` otherwise. The adapter makes one
attempt with the split operation's deadlines and output bounds. It neither moves focus nor picks
an alternate border.

The result is `{ version: 1, outcome, detail }`. `resized` means Rex acknowledged the change,
not that a client rendered it. `stale` means the inherited anchor or server identity changed, the
anchor is gone, or the two blocks no longer share a window. `unavailable` means the required
terminal service is unavailable before mutation. `uncertain` means no resize acknowledgement; do not retry automatically.

## Focus the anchor of a confirmed split

Invoke `node <package>/extensions/rex/terminal-pane.ts focus` with one bounded JSON record:

```ts
{ version: 1; receipt: PaneReceipt }
```

Pass the receipt from a `created` result unchanged. The adapter checks the inherited anchor,
server host and instance, and that one window holds both blocks, as resize does. It then gives
Rex focus to the receipt's anchor block, so typing that Rex receives reaches the invoking
terminal rather than another pane of the window. It acts only while the anchor's session shows
that window: focus never switches the session to another window. When the anchor already
has focus, the adapter changes nothing. It makes one attempt with the split operation's deadlines
and output bounds. Rex focus does not activate the terminal application; the caller's own
program decides when to hand the keyboard to it.

The result is `{ version: 1, outcome, detail }`. `focused` means the anchor had focus or Rex
acknowledged the change. `stale` means the inherited anchor or server identity changed, the anchor
is gone, or the two blocks no longer share a window. `unavailable` means the session shows another
window or the required terminal service is
unavailable; nothing changed. `uncertain` means no acknowledgement; do not retry automatically.

## Consumers

The Markdown command's Read action requests a half-width split on the left for its native
reader and a pinned open-request path. Request consumption separately establishes acceptance.
Browse-only selection and publication do not invoke the adapter.

The interactive `/editor` command opens Editor.app to the right of the invoking Pi pane. Its
private request identifies the local folder and optional file. The app reports workspace load
and visible panel placement separately. A loaded workspace stays attached when its tab is hidden. Joining an Editor
workspace through the agent tool neither starts an app nor creates a split.

The troll extension's `/troll` command opens a Pi session in a floating pane over the invoking
Pi pane's tab. Pi's own startup establishes acceptance.

The composer extension's `/composer` command opens Composer.app with a private launch file in
a split below Pi labelled `Composer`. An authenticated request establishes app acceptance.
Once visible, the composer asks Pi to resize the split through its confirmed receipt. Before
the composer hands the keyboard to the terminal, it asks Pi to focus Pi's own pane through the
same receipt.
