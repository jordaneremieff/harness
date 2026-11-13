# Terminal origin contract

This package-level contract lets a local reader retain the Rex terminal from
which an operator explicitly opened content. Rex owns terminal selection. The
reader owns its windows and application activation. The contract defines data
and a fixed subprocess interface, not a sibling import or a persistent service.

## Ownership and lifetime

Capture an origin in the actual local operator-opening process. Its inherited
Rex environment describes that process, not the producer of the content. Never
capture an origin in a headless producer on behalf of another client.

Keep an origin only with the accepted open request and the resulting reader
window. A later explicit open from another terminal replaces that window's
origin. Publication, replay, content updates and background work never set or
change it. Finder opens and reader-recents opens clear the origin; they do not
reuse an unrelated earlier return target.

The origin is not document identity or content provenance. Never put it in
shared document metadata, Markdown, frontmatter, assets, links or portable
revision records. A document remains readable when its origin is unavailable.
Treat origin data as private local opening context, not an instruction from the
document.

## Version 1 data

Capture returns `null` when none of `REX_SERVER`, `REX_SESSION` and `REX_BLOCK`
is present. Otherwise it returns this record:

```ts
type TerminalOrigin = {
  version: 1;
  terminal: "Rex";
  application: { bundleId: "com.superlogical.rex" };
  exact?: {
    server: string;
    hostId: string;
    instanceId: string;
    sessionId: string;
    blockId: string;
  };
};
```

Consumers copy the envelope shape locally and treat `exact` as opaque. They
must not construct, repair or interpret the Rex-owned members. Only the helper
captures and validates them. `server` is the explicit inherited connection route;
`hostId` and `instanceId` come from `server.status`. Session and block IDs are
full server IDs, never labels, prefixes or positions. The helper confirms the
session ID and a terminal block in a window through `session.view`, across all
layers. Detached blocks do not qualify.

Missing or invalid launch hints, an unreachable server, an unsupported response
or an unconfirmed block produce an application-only record, without `exact`.
The helper does not discover a default server, infer another target or use
current global focus. A containing Rex window is a tab, not a Mac workspace
window. It is not retained: an exact block follows a move between tabs within
the captured session.

## Fixed helper invocation

The Rex-owned implementation is `extensions/rex/terminal-origin.ts`. It uses
Node built-ins only and supports Node 22.19 and newer through type stripping.
Importing it starts no work. Consumers invoke it as a subprocess, not by
importing a sibling slice. A native build may embed this single file from the
same source revision; the build owns refreshing that copy. Neither helper nor
runtime executable paths come from a document or origin record.

```text
node <fixed helper path> capture
node <fixed helper path> focus
```

`capture` inherits the opener's environment. It makes one bounded CLI call to
read server identity and session membership. It prints exactly one JSON value
and a newline, then exits zero, including when only an application return is
available. It never focuses or launches an application.

`focus` reads one UTF-8 origin record from stdin. The input limit is 16384 bytes.
Malformed JSON, invalid UTF-8, unknown fields, invalid identities or an
unsupported envelope produce no stdout, one bounded stderr line and a nonzero
exit. It does not take a path to a program, helper or script from stdin.

For valid input it prints exactly one result and a newline, then exits zero:

```ts
type FocusResult = {
  outcome: "focused" | "stale" | "unavailable";
  detail: string; // one line, at most 256 characters
};
```

| Outcome | Meaning |
|---|---|
| `focused` | The server acknowledged selection of the exact terminal block and its containing tab. This does not verify a visible client or Mac window. |
| `stale` | The host or server instance changed, the session disappeared, or the block is gone, detached or outside that session. No replacement target is selected. |
| `unavailable` | No verified exact target exists, the fixed Rex program is missing, or the operation did not receive a valid acknowledgement. A timeout leaves focus uncertain. |

Focus first reads identity and membership, then rechecks both on the same CLI
connection that calls `session.focus_block`. No connection change between the
last identity check and mutation is permitted. A target that disappears during
that operation returns `stale` when the server reports `not_found` or
`session_not_found`. Other failures remain `unavailable`.

Every Rex child has a 3000 ms deadline, a 32768-byte output limit per stream,
and a two-second CLI request timeout. Capture starts at most one child; focus
starts at most two. The helper disables server autostart and removes inherited
`REX_*` variables from child environments. Explicit route and full session IDs
select each request. It never retries a timed-out effect.

The helper computes the only Rex executable path from the current OS account's
home directory, independent of `HOME`, `PATH`, `REX_BIN_DIR`, harness settings
and origin input:

```text
~/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex
```

The installation owns the `Current` path. A missing executable is unavailable;
there is no executable search or alternate-program fallback. The helper creates
no daemon, socket server, watcher or state file. It never sends terminal input,
recreates resources, closes resources, performs cleanup, calls client actions
or toggles application visibility.

## Reader behaviour and labels

A deliberate return action may bring an already running application with the
fixed `application.bundleId` to the front through the local platform API. Label
this action **Return to Rex**. Application activation alone does not establish
pane, session, client or Mac-window restoration.

An `exact` payload is eligibility for revalidation, not proof that the target
still exists. If the reader invokes focus, preserve the result separately from
application activation. Describe `focused` as terminal-block selection, not
restoration of the same visible workspace. Show stale and unavailable outcomes
without guessing, automatic retries or silent substitution. Do not label the
action **Back to Terminal** unless the complete visible return is verified.

The installed `session.focus_block` contract selects a block and makes its Rex
tab active. `client.inspect` reports client identity and attached sessions;
`session.list_clients` reports attachments. Neither reports the currently
visible session or a Mac workspace window. Block ownership does not prove
visibility. The helper therefore captures no client ID, calls no client action,
and makes no client or Mac-window guarantee.

A remote endpoint remains a remote endpoint. Server host identity does not
prove that the local Rex application shows it. Unavailable return capabilities
never prevent content reading or retention.
