# Terminal pane presentation

This package-level contract lets a local operator action start its own fixed program in a new
terminal split beside the invoking conversation. The terminal integration owns target validation
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
  placement?: { side: "right" | "below"; share: number };
  label?: string;
}
```

`origin` is the unchanged opaque result of the [terminal-origin capture](terminal-origin.md)
from this local opening process. The adapter alone interprets its exact fields. It refuses an
absent exact origin or inherited server/session/block hints that differ from that origin. It
never chooses global focus, a default server or another tab.

`placement` is optional and defaults to `{ side: "right", share: 0.5 }`. `share` is the new
pane's share of the split space and is inclusive from 0.15 to 0.85. `side: "right"` maps to a
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
inherited Rex routing variables from the child environment, supplies the exact server/session,
disables autostart, and checks host/instance identity on the same connection as its single
`session.new_split` call. It finds the verified terminal block in that session's window layout,
then uses that full block ID as the explicit split anchor. The public Rex API owns splitting,
startup and exit behaviour. The split follows `placement`: it sits right or below the anchor,
after it in that direction, and takes the requested share, defaulting to the right and half the
anchor's space. Its label defaults to `Reader`. The split does not take focus. Rex ends zoom in
that tab as part of its defined split behaviour. When the server
is a local Unix socket and the stacking helper is available, the adapter starts the program with
the [pane stacking](pane-stacking.md) offer in its environment, so a program that places its own
window over the pane learns from Rex's layout which content lies above it.

One creation attempt is the maximum. A post-create read checks that the new block and anchor
occupy the same tab. Moving the conversation before creation follows its exact block, not a
remembered tab. Concurrent movement that prevents confirmation remains uncertain.

The adapter prints one JSON record and exits zero for domain results:

```ts
{
  version: 1;
  outcome: "created" | "stale" | "unavailable" | "uncertain";
  detail: string; // one line, at most 256 UTF-8 bytes
  receipt?: {
    server: string; hostId: string; instanceId: string;
    sessionId: string; windowId: string; anchorId: string; blockId: string;
    direction: "horizontal" | "vertical";
  };
}
```

- `created` includes a validated receipt with exact IDs and same-tab placement observed after
  creation. It does not establish that the program accepted its input, that a native window
  rendered, or that a client displays the tab.
- `stale` means identity or membership no longer agrees before creation. No alternate target
  receives the program.
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

## Resize a confirmed split

Invoke `node <package>/extensions/rex/terminal-pane.ts resize` with one bounded JSON record:

```ts
{ version: 1; receipt: PaneReceipt; share: number }
```

Pass the receipt from a `created` result unchanged. The new pane's share is inclusive from
0.1 to 0.9. The adapter checks the inherited anchor, server host and instance, and both blocks'
membership in the receipt window. Rex selects the innermost split in the receipt's direction
with the anchor before the new block, then sets its ratio to `1 - share`. The adapter makes one
attempt with the split operation's deadlines and output bounds. It neither moves focus nor picks
an alternate border.

The result is `{ version: 1, outcome, detail }`. `resized` means Rex acknowledged the change,
not that a client rendered it. `stale` means the inherited anchor, server identity or window
membership changed. `unavailable` means the required terminal service is unavailable before
mutation. `uncertain` means no resize acknowledgement; do not retry automatically.

## Focus the anchor of a confirmed split

Invoke `node <package>/extensions/rex/terminal-pane.ts focus` with one bounded JSON record:

```ts
{ version: 1; receipt: PaneReceipt }
```

Pass the receipt from a `created` result unchanged. The adapter checks the inherited anchor,
server host and instance, and both blocks' membership in the receipt window, as resize does.
It then gives Rex focus to the receipt's anchor block, so typing that Rex receives reaches the
invoking terminal rather than another pane of the window. It acts only while the session shows
the receipt window: focus never switches the session to another window. When the anchor already
has focus, the adapter changes nothing. It makes one attempt with the split operation's deadlines
and output bounds. Rex focus does not activate the terminal application; the caller's own
program decides when to hand the keyboard to it.

The result is `{ version: 1, outcome, detail }`. `focused` means the anchor had focus or Rex
acknowledged the change. `stale` means the inherited anchor, server identity or window membership
changed. `unavailable` means the session shows another window or the required terminal service is
unavailable; nothing changed. `uncertain` means no acknowledgement; do not retry automatically.

## Consumers

The Markdown command's deliberate Read action uses the default placement with its own native
reader and a pinned open-request path. Request consumption separately establishes acceptance.
Browse-only selection and publication do not invoke the adapter.

The composer extension's `/composer` command opens Composer.app with a private launch file in
a split below Pi labelled `Composer`. An authenticated request establishes app acceptance.
Once visible, the composer asks Pi to resize the split through its confirmed receipt. Before
the composer hands the keyboard to the terminal, it asks Pi to focus Pi's own pane through the
same receipt.
