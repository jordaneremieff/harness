# stash: session continuity

The agent distills an effort into a durable Markdown handover. The extension owns deterministic storage, discovery, and pickup. The active agent distills its own effort through `stash_write`; a separate bounded agent can distill the live session on request through `/stash new <hint>`, which adds no turn to the live session.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| `stash_write` | tool | Persist a self-contained handover with project, branch, and session metadata. |
| `stash_list` | tool | List recent artifacts by stable id, optionally filtered by tag or lifecycle state. |
| `stash_read` | tool | Read by exact id or unique prefix. Results are capped at 50 KiB or 2000 lines and include the path when truncated. |
| `stash_complete` | tool | Close an active effort with a required concrete outcome. |
| `stash_rotate` | tool | Archive a stale open or closed effort so it no longer appears in listings or pickup; the file moves to the store's dot-hidden `.trash` directory and remains recoverable. |
| `/stash` | command | Browse and pick up efforts (TUI overlay); bare invocation opens the browser. |
| `/stash new <hint>` | command | Dispatch a separate agent to distill the live session plus the hint into a new stash. |
| `/stash get <id>` | command | Pick up a stash by full id or unique prefix. |
| `/stash get <id> <note>` | command | Pick up with an operator note: material recalled after the stash was written, delivered ahead of the artifact and authoritative on conflict. The artifact itself is never rewritten. |
| `/stash release <id>` | command | Return an active stash to open (dead-session cleanup). |
| `/stash abort` | command | Cancel the in-flight creation job. |

Pickup is one system action. The command reads the selected artifact and sends it as the next user message through `pi.sendUserMessage()`. The agent does not need to orchestrate a second `stash_read` call. The current working directory is never changed implicitly; the pickup message names both the current workspace and the recorded project, and calls out a mismatch before edits begin. An optional operator note (`/stash get <id> <note…>`, or the browser's `a` key) rides along in the same message as a distinct amendment block placed ahead of the artifact, marked newer than it and authoritative on conflict; the note is trusted operator input, terminal-sanitized, capped at 20,000 characters, and never persisted — the stashed core material stays byte-identical. `stash_write` emits the equivalent fresh-session shortcut:

```bash
pi "/stash get <id>"
```

## Lifecycle

New artifacts begin `open`. Pickup atomically changes an open artifact to `active`
before injecting its full handover; repeated pickup of an active artifact is
idempotent, and the pickup message then disowns the earlier activation: it names
the recorded activation time and states that any prior session's claim is
superseded, so a fresh session never wastes effort reconciling a phantom
predecessor. `release` returns an active artifact to pristine `open` — the
operator-initiated inverse of pickup for a session that died or polluted its
context; it keeps every durable byte and clears the activation claim. The
pickup message names `stash_complete` and the exact id so the resumed
agent has a deterministic closure path. `stash_complete` accepts only active artifacts,
requires an outcome, and records `closed`, `closedAt`, and the outcome. A closed effort
cannot be picked up until the operator deliberately reopens it.

Existing artifacts without lifecycle metadata normalize to `open`; no bulk migration is
required. Reopening returns a closed artifact to `open` and removes closure metadata
while retaining its prior activation timestamp. Artifacts never move or disappear as a
lifecycle side effect.

Command forms are:

```text
/stash                         browse & pick up (TUI overlay)
/stash new <hint>              distill the live session into a new stash
/stash abort                   cancel an in-flight creation
/stash get <id> [note]         pick up a stash, optionally with an operator note
/stash complete <id> <outcome> close an active stash with a concrete outcome
/stash release <id>            return an active stash to open
/stash reopen <id>             return a closed stash to open
/stash rotate <id>             archive a stale stash (recoverable)
/stash help                    show usage
```

Every `<id>` may be a full stash id or a unique prefix.

The first token always selects an action. Creation therefore requires `new`, so
hints such as `abort the plan` and `help me` remain unambiguous as
`/stash new abort the plan` and `/stash new help me`. Unknown actions show
replacement guidance instead of silently starting a distiller. A bare token shaped
like a full stash id is treated as a stale `pi "/stash <id>"` resume string and
rejected with `use /stash get <id>`. The previous `pickup` verb is hard-rejected
with its replacement syntax; it is not aliased. Typing `/stash ` autocompletes the
actions; after an id-bearing action it completes stash id prefixes.

Rotation is the operator-initiated archive path for stale efforts: an open or
closed artifact moves atomically into the store's dot-hidden `.trash` directory
(see Storage), where it no longer appears in listings, pickup, or lifecycle
changes. Active artifacts cannot be rotated while a session owns them;
completion remains the only close path for an active effort, and release the
only way back to open. The file is retained byte-for-byte and restoring it is
a plain move back into the store.

## Background distillation

`/stash new <hint>` captures the compaction-aware active-path entries from the
live session, then runs one bounded, tool-free agent session in-process through
the Pi SDK (`createAgentSession`, `SessionManager.inMemory()`, `tools: []`). The
distiller receives a system prompt plus a single user message: the operator hint
first as the sole effort the artifact may cover, then the bounded transcript
(first quarter and last three quarters, marked at the cut). Concurrent or prior
mainline work in the same live session is out of scope for a hinted stash even
when it is longer, more recent, or more urgent-looking. A bounded reference
section retains deduplicated paths, work-item keys, and URLs observed in tool
results, including references outside the retained transcript window; those
references are candidates for the hinted effort only. It returns one
fenced JSON payload that the extension validates against the same shape and
caps as `stash_write` before writing through the atomic store with project,
branch, and session metadata. Before parsing, raw control characters inside
JSON string literals (literal newlines and tabs that strict JSON requires
escaped, which some models emit and `JSON.parse` rejects as "Bad control
character in string literal") are escaped deterministically; the rewrite only
touches characters inside string literals, so a payload that would parse is
unchanged and the parsed value keeps the literal character. A `SKIP_STASH` reply
writes nothing.

### Distillation model and thinking

By default the distiller inherits the live session model and thinking level.
Override either with environment variables (empty or whitespace values count as
unset):

| Variable | Unset | Set |
|---|---|---|
| `PI_STASH_MODEL` | Parent session model | `provider/id` or bare id from the current registry with configured auth |
| `PI_STASH_THINKING` | Parent thinking level (or `low` when the parent has none) | Explicit level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

A set `PI_STASH_MODEL` that is missing from the registry or has no configured
auth fails creation; the parent model is never used as a silent fallback. An
explicit `PI_STASH_THINKING` level the selected model cannot run also fails
creation and names the supported levels. An inherited thinking level the model
cannot run is clamped. Prefer `provider/id` when bare ids collide across
providers. Distillation still has a 180-second wall-clock bound; pin
`PI_STASH_THINKING` (for example to `low`) when a high parent thinking level
would make the one-shot distill too slow or costly. `stash_write` is authored by
the live agent and does not read these variables.

The selected distiller identity is surfaced at both ends of the job: the start
notification and the running footer status name the model and thinking level in
statusline form (`claude-sonnet-4-5 [medium]`, the thinking bracket only for
reasoning models), and the settled notification plus the `stash: done` status
report the run's token and cost totals (`35k in · 2.0k out · ~$0.12`, with `in`
counting input, cache-read, and cache-write tokens). Totals come from the
distill session's own stats, so they cover exactly what that one-shot run
billed, including provider retries.

The command handler returns immediately; the live agent receives no turn. The
job is fire-and-forget with hard bounds: zero tools, one prompt, a 180-second
wall-clock auto-abort, and an AbortController that `/stash abort` and
`session_shutdown` both trigger. At most one creation runs at a time; a second
creation dispatch during a run reports the in-flight creation. The result promise
settles exactly once and never rejects, so a detached callback cannot crash
the host session.

While the job runs, the extension publishes `stash: running ⠋ · <distiller>`
under its own status key through `ctx.ui.setStatus` and animates it on a 120 ms
interval it owns. On settle it holds `stash: done <id> · <usage>`,
`stash: skipped`, or `stash: failed` for three seconds, then clears the key;
abort clears it immediately. Every terminal path stops the interval and clears
pending timers. The statusline extension renders this text generically through
`footerData.getExtensionStatuses()`; there is no direct code sharing between
the two extensions, and the status also appears in Pi's default footer.

In RPC mode the write and notifications still happen; the spinner is TUI-only.
In JSON/print the write still happens and the artifact appears in
`stash_list`; the command itself is silent, matching the existing
silent-success contract.

Only TUI mode constructs the custom browser. Headless callers can use `stash_list`
to discover ids; the explicit `get` and lifecycle verbs remain usable without the
browser. RPC receives actionable notifications; bare JSON/print browser
invocations fail with directions to the direct commands and model-facing tools rather
than silently returning or writing to Pi-owned stdout. In JSON/print, a successful
direct verb is silent because fire-and-forget UI is a no-op in those modes; failures
still throw. `stash_complete` remains the feedback-bearing closure surface for
headless callers. A state filter matches only artifacts whose header was actually
read; an artifact that vanishes or fails mid-listing, or whose lifecycle value is not
a recognized state, is excluded from state-filtered results instead of being reported
as open. Unrecognized values stay visible in unfiltered listings and read as
`unknown (<value>)`; every lifecycle action refuses them.

## Storage

Artifacts live at `<agentDir>/stash/`, normally `~/.pi/agent/stash/`. `PI_STASH_DIR` overrides the location for tests and isolated deployments. `PI_STASH_MODEL` and `PI_STASH_THINKING` configure `/stash new` distillation (see Background distillation). `PI_SESSION_ID` is read as a fallback when the session manager supplies no session id.

Flat files are the store of record because handovers must outlive sessions and remain greppable. Session entries were rejected because their lifecycle is the session. Project-local storage was rejected because it fragments cross-project continuity and pollutes checkouts.

Each artifact is `<utcTimestamp>-<slug>[-<collision>].md` with JSON-valued frontmatter and a Markdown body. The store provides these guarantees:

- Credential-shaped content is redacted deterministically: before distillation, the transcript and observed references are scanned and credential-shaped values (prefixed provider tokens, JWTs, bearer headers, private keys, `key: value` assignments, URL userinfo passwords) are replaced with `[REDACTED]`; the same pass runs over the generated payload before the artifact is written, so no secret depends on the model's discretion. The operator hint is trusted input and is never redacted. Artifacts written before this version are not retroactively scrubbed.

- Directory mode is enforced as `0700`; regular artifact files are enforced as `0600`, including artifacts created by older versions.
- Completed temporary files are hard-linked into place. Existing names are never replaced; concurrent same-second writes receive numeric suffixes.
- Lifecycle changes run through Pi's per-file mutation queue, reread the exact regular file with `O_NOFOLLOW`, preserve unknown frontmatter, write a private dot-hidden temporary file, recheck file identity, and atomically rename the completed revision into place.
- Symlinks are ignored during discovery and reads. Mutation rechecks reject a selected target that is no longer the same regular file. Ordinary Node APIs cannot make the entire ancestor path descriptor-relative, so this is a private same-user local store rather than a claim of immunity to a hostile process replacing directory ancestors.
- New artifacts and reads are capped at 256 KiB. Oversized historical files are rejected without being loaded wholesale.
- Rotation moves an artifact into the dot-hidden `.trash` subdirectory with the same discipline as other mutations: the target is rechecked as the same regular file immediately before an atomic same-filesystem rename, an existing archive of the same id is never replaced, and the archive directory is hardened to `0700` like the store. Rotation reads only the bounded header (for active-state exclusion): an artifact remains rotatable as long as its header closes inside the 16 KiB scan window, and an unreadable header refuses rotation with the state unverified.
- Malformed frontmatter falls back to filename metadata instead of hiding other artifacts.

Artifacts are retained until the operator explicitly removes their exact `.md`
files, or rotates them into `.trash`. There is no automatic pruning: continuity
data should not disappear because of an age default or an accidental keypress.
Rotation is the only lifecycle move; it is operator-initiated, requires
confirmation in the browser, and is recoverable — archived files stay in place
at 0600 under the store's `.trash` directory until the operator moves them back
or removes them. Rotated artifacts are invisible to discovery, listing, pickup,
and lifecycle changes; nothing ever deletes continuity data automatically.

## Browser behavior

The overlay loads the newest 200 artifacts and marks the count with `+` when older stashes exist. It is a framed, side-by-side browser: the left pane keeps the newest-first stash list visible while the right pane renders the selected handover as Markdown. The top border carries the supplied title and live position. Rows use `›` for selection plus a colored lifecycle glyph, date, and title: `○` open, `◐` active, `●` closed, and `◈` unknown (an unrecognized lifecycle value or an unreadable header). The preview includes state, creation and lifecycle timestamps, outcome, tags, session, project, branch, and artifact path above the body.

`/` enters filter mode. Typing filters across id, title, tags, project, branch, lifecycle state/timestamps/outcome, and preview text; Up/Down still selects matches, and Enter or Escape returns to browsing with the query intact. The browser preserves the query and selected stash across outcome or action-dialog round trips.

Up/Down selects artifacts, `b`/Space pages the preview, Enter picks up, `a` picks up with an operator note collected in the host (an empty note degrades to a plain pickup), `c` copies the resume command with an in-footer success or failure flash, and `o` closes an active effort after the operator supplies its required outcome. `h` opens a self-contained explanation of the browser, its lifecycle effects, and the safe-close contract; Up/Down and `b`/Space scroll it, and `h` or Escape returns. Tab remains the discovery and uncommon-action path. Its dialog offers pick up or rotate (open), close with outcome or release back to open (active), and reopen or rotate (closed); rotation asks for explicit confirmation and notes that the artifact remains recoverable.

The browser does not provide mechanical state cycling. Copy is the only safe lifecycle-independent mutation that can remain inside the overlay. Pickup must inject the handover (plain or with a note — the note needs the host's input dialog), completion must collect an outcome, and reopen or rotation requires deliberate confirmation; release is reachable only through the actions dialog, where it sits behind an explicit choice and loses nothing durable, so those paths resolve to the host and reopen with refreshed store data.

The component derives its row budget from the host TUI and the overlay's height margin. Every framed line paints the full overlay width, the key footer sits above a closing border, and very narrow or short terminals fall back to a bounded list with an explicit close line. Stored terminal and bidi controls are rendered as inert escape text.

## Files

- `index.ts`: tool registrations, `/stash` host, and the creation slot/status lifecycle.
- `store.ts`: private, collision-safe filesystem store, atomic lifecycle transitions, and the rotation archive.
- `format.ts`: record shape, lifecycle metadata, and Markdown/frontmatter codec.
- `panel.ts`: interactive browser state and rendering.
- `pickup.ts`: self-contained pickup message, operator amendment block, and already-active ownership handoff.
- `distill.ts`: transcript capture, prompt building, payload validation, and the bounded SDK session seam.
- `redact.ts`: deterministic credential redaction for transcript, references, payloads, and lifecycle outcomes.
- `text.ts`: terminal-safe text and output bounds local to this extension.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
npm test
# full suite passes; stash coverage in extensions/stash/*.test.mts

npx --yes --package typescript@5.9.3 tsc --noEmit \
  --allowImportingTsExtensions --module ESNext --moduleResolution Bundler \
  --target ES2022 --types node --skipLibCheck \
  extensions/stash/*.ts

printf '%s\n' '{"id":"commands","type":"get_commands"}' \
  | pi -e . --mode rpc --no-session --offline
```

The stash files type-check clean against the installed Pi declarations.
Lifecycle behavior is covered by the focused and full tests in
`extensions/stash/*.test.mts` and by TypeScript against the installed Pi
declarations. The runtime layer is declared by the peer dependencies in
`package.json`; verify the installed package versions with `npm ls` before
repeating any version-specific claim.

## Deliberate omission

There is no automatic stash on shutdown or compaction. Distillation timing and content require agent judgment; deterministic pickup does not.
