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
}
```

`origin` is the unchanged opaque result of the [terminal-origin capture](terminal-origin.md)
from this local opening process. The adapter alone interprets its exact fields. It refuses an
absent exact origin or inherited server/session/block hints that differ from that origin. It
never chooses global focus, a default server or another tab.

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
startup and exit behaviour. The split sits on the right, takes half the anchor's space and does
not take focus. Rex ends zoom in that tab as part of its defined split behaviour.

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

The only consumer is the Markdown command's deliberate Read action. It passes its configured
native reader and a pinned open-request path. The reader's separate request-consumption signal
establishes acceptance. Browse-only selection and publication never invoke this adapter.
