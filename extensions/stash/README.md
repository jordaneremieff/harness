# stash: session continuity

The agent distills an effort into a durable Markdown handover. The extension owns deterministic storage, discovery, and pickup. The active agent distills its own effort through `stash_write`; a separate bounded model request can distill the live session on request through `/stash new <hint>`, which adds no turn to the live session.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| `stash_write` | tool | Persist a self-contained handover with project, branch, and session metadata; `checkpoint: true` saves a working synthesis outside handover discovery. |
| `stash_list` | tool | List recent artifacts by stable id, optionally filtered by tag or lifecycle state. |
| `stash_read` | tool | Read by exact id or unique prefix. Results are capped at 50 KiB or 2000 lines and include the path when truncated. |
| `stash_complete` | tool | Close an active effort with a required concrete outcome. |
| `stash_rotate` | tool | Archive a stale open or closed effort so it no longer appears in listings or pickup; the file moves to the store's dot-hidden `.trash` directory and remains recoverable. |
| `/stash` | command | Browse and pick up efforts (TUI overlay); bare invocation opens the browser. |
| `/stash new <hint>` | command | Stream a separate model response to distill the live session plus the hint into a new stash. |
| `/stash get <id>` | command | Pick up a stash by full id or unique prefix. |
| `/stash get <id> <note>` | command | Pick up with an operator note: material recalled after the stash was written, delivered ahead of the artifact and authoritative on conflict. The artifact itself is never rewritten. |
| `/stash release <id>` | command | Return an active stash to open (dead-session cleanup). |
| `/stash abort` | command | Cancel the in-flight creation job. |
| `/stash capacity [reset]` | command | Inspect the last capacity observation and request latches, or explicitly start a new pressure episode. |

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

Artifacts require an explicit JSON-encoded lifecycle state. Missing headers, missing states,
and malformed state values remain visible as unknown but cannot authorize pickup or lifecycle changes.
The extension never synthesizes missing metadata or interprets unquoted values as a second format.
Reopening returns a closed artifact to `open` and removes closure metadata
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
closed artifact moves into the store's dot-hidden `.trash` directory
(see Storage), where it no longer appears in listings, pickup, or lifecycle
changes. Active artifacts cannot be rotated while a session owns them;
completion remains the only close path for an active effort, and release the
only way back to open. The file is retained byte-for-byte and restoring it is
a plain move back into the store.

## Capacity checkpoints

The `turn_end` hook reads Pi's context estimate once per enabled turn. At the
checkpoint threshold it adds a short model-visible request to preserve a working
synthesis with `stash_write({ checkpoint: true, ... })`. At the decision threshold
it requests an authorized continuity choice before further broad intake: checked
compaction for the same effort, or a discoverable handover for a fresh session.
The active agent decides the content and continuity path. The hook does not run
a separate distiller or call a model below threshold.

A pressure episode allows at most one checkpoint request and one decision
request. A jump past both thresholds combines them in one message. Each new
request returns `continue: true` through Pi's actionable boundary; a natural tool
continuation already satisfies that request. Ordinary turns never request extra
continuation. Falling usage does not re-arm a latch. Committed compaction, a new
session identity, or `/stash capacity reset` starts a new episode. Reload retains
latches; forks ignore the parent session's latches. The hook preserves earlier
boundary drafts and does not evaluate a pre-compaction percentage against an
earlier compaction draft.

The session owns compact custom state entries, not handover prose. Each state
records the session identity, source assistant entry, request latches, usage
availability, and text-intake estimate. Restoration walks at most 4096 active
ancestors to the nearest state or compaction. A malformed state, missing ancestor,
or exhausted scan reports an error instead of inventing an empty episode. Inspect
it, then use `/stash capacity reset` to establish a new starting point. Invalid
configuration disables the capacity action without disabling other stash tools;
the hook reports its first error through Pi, and the capacity command reports the
current error. No diagnostic writes to protocol stdout.

Requests precede their state entries and also retain their latch metadata, so a
partial append after a request does not automatically repeat it. Pi validates
boundary drafts but does not commit them transactionally. A persisted request is
not evidence that an agent read it, that the next provider call succeeded, or that
a checkpoint exists. The write tool's successful result establishes the saved
file. Aborted/error turns and an already-aborted signal do not request or latch
an intervention. An abort after dispatch can leave a retained notice without a
completed checkpoint; the next user prompt retains that notice unless compaction
or navigation removes it.

Unknown context usage stays unknown, including missing, invalid, or throwing
host telemetry. The optional intake budget is a separate trigger, never a
fabricated context percentage. It sums user, tool-result, and other custom-message
text since the episode boundary, estimates tokens as UTF-16 text length divided
by four (rounded up), and requests checkpoint plus decision when that budget is
reached while host usage is unknown. It excludes assistant text, the governor's
own notices, images, system prompts, and tool declarations. It is not a tokenizer
or a safe remaining budget. Without an explicit intake budget, unknown usage
produces no automatic request; governing manual checkpoint instructions still
apply.

### Capacity configuration

Environment variables are read when the hook or command runs. Defaults are
portable; choose local thresholds and a checkpoint directory through the
[extension configuration convention](../../docs/conventions/extension-config.md).

| Variable | Default | Meaning |
|---|---|---|
| `PI_STASH_CAPACITY` | `1` | `0` disables observation and requests; only `0` and `1` are accepted. |
| `PI_STASH_CHECKPOINT_PERCENT` | `60` | Positive checkpoint threshold, strictly below the decision threshold. |
| `PI_STASH_DECISION_PERCENT` | `70` | Continuity-decision threshold, at most `100`. |
| `PI_STASH_INTAKE_TOKEN_BUDGET` | Unset | Positive safe integer for the unknown-usage text-intake trigger. |
| `PI_STASH_CHECKPOINT_DIR` | `<stashDir>/checkpoints` | Working-checkpoint directory. Relative overrides resolve against the invoking session's cwd. |

A working checkpoint uses the same bounded Markdown format, redaction, private
permissions, and no-clobber publication as a handover. It lives in a separate
directory and returns a file path, not a pickup id. Read that path to recover the
synthesis. `stash_list`, the browser, and lifecycle commands operate only on the
handover store. Keep the checkpoint directory separate from that store. No
checkpoint is automatically pruned or converted into a handover. Omit
`checkpoint` when a future session needs normal discovery and pickup.

`/stash capacity` labels its usage value as the last boundary observation, not a
live reading. Reset appends state without deleting history. Reset deliberately
allows another request even if usage remains high; ordinary checkpoint writes do
not reset the latches. In TUI/RPC the command notifies; in print/JSON it returns
its text through the existing command-error channel because those modes have no
command-result notification surface.

This is a request mechanism, not a hard stop at 80% or any other percentage.
Ordinary boundary results do not suppress natural tool work or queued messages.
The decision notice refers to governing stop instructions, but this extension
does not abort the agent, compact automatically, replace sessions, cancel
workers, or omit tool results. Those semantic and authority decisions remain
with the agent and operator. A later stop-threshold crossing does not produce an
additional notice after the decision request was already latched.

The stash slice owns this mechanism. Evaluate it with the focused boundary and
SDK tests below and observed checkpoint outcomes, not invocation counts alone.
Disable it if it fails to reduce missed checkpoints; remove it when Pi supplies
the same checkpoint-and-decision contract. Synthetic provider tests establish
bounded dispatch and persistence, not real-model compliance or long-term utility.

## Background distillation

`/stash new <hint>` captures the compaction-aware active-path entries from the
live session, then calls the current session's configured
`modelRegistry.streamSimple()` with no tools. Registered providers and their
request-time authentication remain available without a child session, resource
loader, or separate model registry. The distiller receives the explicit system
instructions plus a single user message: the operator hint
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
JSON string literals (literal newlines, tabs, and other control characters
that strict JSON requires escaped, which some models emit and `JSON.parse`
rejects as "Bad control character in string literal") are escaped
deterministically; a raw control character directly after a literal backslash
is repaired the same way, emitting an escaped backslash plus the escaped
control so the parsed value keeps both. The rewrite only touches characters
inside string literals, so a payload that would parse is unchanged and the
parsed value keeps the literal character. A `SKIP_STASH` reply writes nothing.

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
counting input, cache-read, and cache-write tokens). Totals sum the final
reported usage of every model attempt exactly once, including failed attempts
before a successful retry. Skip and failure notifications carry the totals too.
Cancellation retains usage received before the outcome settles; a provider that
ignores cancellation can return usage too late to include. Provider-internal
retries expose only the usage the provider reports, so these totals are not an
invoice-completeness guarantee. The surfaced label is sanitized to a single control-free line:
configured model names are free-form, and every string this module interpolates
into a status or notification goes through the same sanitization.

Transient retries use Pi's public `retryAssistantCall` with the on-disk global
and project retry settings. Provider retry controls, transport, HTTP timeout,
WebSocket timeout, and thinking budgets use the corresponding SettingsManager
getters. Defaults permit three outer retries with exponential waits starting at
two seconds; quota errors and context overflow do not retry. All attempts retain
the same prompt and a separate request-cache identity. Model adapters retain
their default output-token limits; the extension adds no universal token cap.

The request does not run AgentSession compaction, length recovery, or cache
warming. Context overflow fails without rewriting the transcript. Length-limited
or tool-request responses fail validation even if their text contains valid JSON.
Only a completed text response reaches the parser and store.

The command handler returns immediately; the live agent receives no turn. The
job uses zero tools, one fixed prompt, a 180-second wall-clock auto-abort across
requests and retry waits, and an AbortController that `/stash abort` and
`session_shutdown` both trigger. Cancellation settles the job even if a provider
ignores its signal; stopping the underlying request still requires provider
cooperation. Late responses never write an artifact. At most one creation runs at a time; a second
creation dispatch during a run reports the in-flight creation. A different session
cannot abort that creation; the abort command requires the owning session. The result promise
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

- Directory mode is enforced as `0700`; regular artifact files are enforced as `0600`, on discovery.
- Completed temporary files are hard-linked into place. Existing names are never replaced; concurrent same-second writes receive numeric suffixes.
- Lifecycle changes run through Pi's per-file mutation queue, reread the exact regular file with `O_NOFOLLOW | O_NONBLOCK`, preserve unknown frontmatter, write a private dot-hidden temporary file, recheck file identity, and atomically rename the completed revision into place.
- Artifact opens use `O_NONBLOCK` and reject non-regular descriptors before reads or permission changes. A pipe that replaces an artifact after directory discovery is refused without waiting for a peer, including during the initial permission sweep.
- Symlinks are ignored during discovery and reads. Mutation rechecks reject a selected target that is no longer the same regular file. Ordinary Node APIs cannot make the entire ancestor path descriptor-relative, so this is a private same-user local store rather than a claim of immunity to a hostile process replacing directory ancestors.
- New artifacts and reads are capped at 256 KiB. Oversized historical files are rejected without being loaded wholesale.
- Rotation validates the `.trash` subdirectory as a real directory before enforcing `0700`; a symlink is rejected without changing its target. The bounded header read captures the file identity. Rotation first pins that inode with an exclusive hard link at a private, randomly named temporary path inside `.trash`, then verifies its identity before publishing the final archive name. A source replacement at the first link is refused without occupying the archive name; cleanup removes only the temporary link this call created. An exclusive same-filesystem link from the verified temporary path publishes the archive without replacing an existing archive, including concurrent publication. Rotation rechecks the source and archive identities before removing the source. A source replacement after temporary verification leaves the verified archive and replacement source intact when the recheck detects it. A source-removal failure retains the archive and reports its path; no rollback unlinks the final archive name, even if another process replaced it. An interruption or failed temporary cleanup can leave a private dot-hidden temporary link; cleanup failure after publication does not reverse the publication result. Rotation reads only the bounded header through every tool, command, and browser path, so the 256 KiB read limit does not prevent archival. The header must close inside the 16 KiB scan window; an unreadable header refuses rotation with the state unverified.
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

The component derives its row budget from the host TUI and the overlay's height margin. Every framed line paints the full overlay width, the key footer sits above a closing border, and very narrow or short terminals fall back to a bounded list with an explicit close line. The fallback list scrolls with the selected row, including after a resize, whenever a row fits above the footer. Stored terminal and bidi controls are rendered as inert escape text.

## Files

- `index.ts`: tool registrations, `/stash` host, capacity hook, and the creation slot/status lifecycle.
- `capacity.ts`: bounded session-state restoration, context observations, configuration, and latched continuity requests.
- `store.ts`: private, collision-safe filesystem store, atomic lifecycle transitions, and the rotation archive.
- `format.ts`: record shape, lifecycle metadata, and Markdown/frontmatter codec.
- `panel.ts`: interactive browser state and rendering.
- `pickup.ts`: self-contained pickup message, operator amendment block, and already-active ownership handoff.
- `distill.ts`: transcript capture, prompt building, payload validation, configured model streaming, retry usage, and cancellation.
- `redact.ts`: deterministic credential redaction for transcript, references, payloads, and lifecycle outcomes.
- `text.ts`: terminal-safe text and output bounds local to this extension.
- `test-fixtures.mts`: typed model and transcript fixtures, registration capture, and the partial host context for entrypoint tests.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
node --test extensions/stash/*.test.mts
npm test

npx --yes --package typescript@5.9.3 tsc --noEmit \
  --allowImportingTsExtensions --module ESNext --moduleResolution Bundler \
  --target ES2022 --types node --skipLibCheck --strict \
  extensions/stash/*.ts

printf '%s\n' '{"id":"commands","type":"get_commands"}' \
  | pi -e . --mode rpc --no-session --offline
```

Controlled streams cover timeout, cancellation, late results, retry exhaustion,
usage totals, invalid responses, and byte-exact artifact output. An entrypoint
test registers a synthetic provider in a real isolated ModelRuntime and invokes
the command without a stream override. It checks registry binding, request-time
authentication, tool-free input, storage, and no turn in the live session.

The stash files type-check clean against the installed Pi declarations.
Lifecycle behavior is covered by the focused and full tests in
`extensions/stash/*.test.mts` and by TypeScript against the installed Pi
declarations. The runtime layer is declared by the peer dependencies in
`package.json`; verify the installed package versions with `npm ls` before
repeating any version-specific claim.

## Deliberate omission

There is no automatic stash on shutdown or compaction. Capacity thresholds request
agent-authored checkpoints; the hook itself never writes a synthesis or chooses a
continuity path. Context omission and hard-stop control are not part of this slice.
