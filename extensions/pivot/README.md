# pivot: frame the first message of a forked session

Pi forks (`pi --fork`, in-session `/fork`, `/clone`) copy the full parent
transcript, and the model reflexively resumes parent work instead of the new
request. This extension queues a compact task boundary on the fork's first
real interactive input, so the inherited transcript reads as background
context and the active request reads as the new task.

## Surfaces

| Surface | Kind | Purpose |
|---|---|---|
| `/pivot` | command | Copy `cd -- '<cwd>' && pi --fork '<session>'` to the clipboard for pasting in a new terminal. |

The extension registers **no keyboard shortcut** — deliberate.

## Behavior

- On `session_start` the extension arms when all of these hold:
  1. the session header records a parent session (`parentSession`);
  2. the session contains copied transcript entries;
  3. no user message exists strictly after the recorded fork point on the
     active branch.
  The fork point is the last copied entry at fork time; it is recorded once
  per session id (a fork of a fork copies the parent's entry, which carries
  the parent's session id and is ignored).
- On the first interactive, non-empty input, the extension queues the
  boundary as a custom message with `deliverAs: "nextTurn"`. Pi appends
  queued messages after the operator's user message, so the boundary sits
  immediately after the active request. The operator's message is stored
  byte-identical.
- Programmatic inputs (RPC, extension-injected) never consume the slot.
- A failed preflight (no model or no auth) leaves the boundary queued for
  the retry; it is never queued twice.
- While armed, the footer shows `fork boundary armed — next message will be
  framed`. The status clears on consumption and on session shutdown.

## Boundary text

```text
[fork task boundary]

This session is a new fork. The user message immediately before this
boundary is the active request. Everything earlier in this transcript,
including any earlier fork boundary, is inherited context from a parent
session, not active work. Do not resume parent work unless the active
request explicitly asks for it.
```

The wording is position-explicit (the boundary follows the request) and
generation-robust (an inherited earlier boundary is explicitly demoted to
context, so each fork generation re-frames deliberately).

## Documented behavior and limits

- **Transcript visibility:** the boundary is hidden from the chat transcript
  (`display: false`) but **appears in `/tree`**, which renders custom
  messages by content. This is expected.
- **Session previews:** because the operator's message is untouched, session
  previews and search index the real request, not the boundary.
- **`/tree` navigation:** the gates are evaluated on session start only.
  Navigating back and sending a message after a boundary was consumed does
  not re-arm in the running process. A restart re-evaluates the gates from
  the session entries.
- **Unrecognized slash commands:** a typo such as `/moel` reaches the input
  event and consumes the boundary like any other first message. Known
  commands never reach the input event. Skill and template commands are
  real first messages and consume it.
- **Mid-stream parents:** forking a parent while it is streaming copies a
  snapshot that may miss the in-flight assistant message, and the source
  file can be mid-append. The copied command is re-runnable; re-run it.
- **Branch summaries:** a branch summary generated from a path that contains
  the boundary folds its wording into the summary text. Low impact.
- **Cost:** the boundary adds well under 100 tokens to the context for the
  life of the fork, until compaction or a branch summary removes it.
- **Platform:** macOS only — the command requires `pbcopy`. A missing
  `pbcopy` reports a clear error.
- **Extension interaction:** if another extension's `input` handler returns
  `handled` after this one queued the boundary, the queued boundary attaches
  to the next prompt that actually reaches the agent.

## Files

- `index.ts`: command registration, session hooks, boundary queueing.
- `gates.ts`: pure arming decision (fork point, active path, message count).
- `command.ts`: shell-safe fork command assembly.
- `pb.ts`: no-shell `pbcopy` wrapper with timeout and cancellation.
- `*.test.mts`: unit and entrypoint drive tests.

## Verification

```bash
npm test
# full suite passes; pivot coverage in extensions/pivot/*.test.mts

node scripts/extension-load-check.mts extensions/pivot/index.ts
```

The live fork-framing drive (isolated HOME, dummy provider, real-provider
salience check) runs from the gitignored `.evals/` folder in this worktree;
see `.evals/README.md` for the procedure. The drive must pass before
promotion.
