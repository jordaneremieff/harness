---
name: herdr
description: >
  Use only when the user explicitly mentions Herdr or asks to use Herdr to
  drive sibling panes, agents, workspaces, or tabs from inside a Herdr-managed
  terminal: splitting a pane, rearranging or resizing an existing pane, moving
  a pane to another tab or workspace, prompting another agent, waiting for its
  output. Requires HERDR_ENV=1; stop if that variable is unset. Do not use for
  ordinary shell or tmux work, or when Herdr is not running.
compatibility: Requires Herdr 0.8 or newer and a Herdr-managed pane (HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID set). The socket API is newline-delimited JSON over a Unix socket or Windows named pipe.
---

# herdr

Drive the surrounding Herdr session from inside a Herdr-managed pane: inspect
panes and agents, open and arrange siblings, and hand work to another agent.
Herdr is the terminal multiplexer this pane lives in; the socket is the only
control path.

## Gate

Run the gate before any Herdr command:

```bash
test "${HERDR_ENV:-}" = 1 || { echo "not inside herdr"; exit 1; }
```

If the gate fails, stop. Herdr commands work only inside a Herdr pane.

## Two control paths

Herdr is reachable two ways, and they cover different ground.

- **`herdr_*` agent tools.** Present only when the herdr extension is loaded;
  check your own tool list. They cover inspection, reading, splitting *this*
  pane, running a command in a fresh pane, sending input, and starting,
  prompting, and waiting on an agent. They re-resolve the target pane against
  live state before every write and serialize input per pane.
- **The `herdr` CLI.** Always available inside a Herdr pane, and strictly
  wider. It is the only path to arrangement (move, swap, resize, zoom, focus),
  rename, close, and the tab, workspace, worktree, and session groups. It can
  also split a pane other than this one.

Prefer a tool when one covers the whole request. Reach for the CLI as soon as
the request touches arrangement, rename, close, or another group: no tool
exposes those, so rephrasing a tool call cannot reach them.

## CLI contract

Learn these once. Most invocation errors come from guessing them.

**Output format.** Commands that talk to the live socket (`pane`, `tab`,
`workspace`, `agent list|get|read`, `api snapshot`) already print JSON as
`{"id":…,"result":{…}}` on stdout and take no `--json` flag; passing one is
an `unknown option` error. A few commands print plain text by default and
accept `--json` for a flat JSON form that is *not* that envelope: `status`,
`agent explain`, `session list`, `session stop`, `session delete`, and
`api schema`. Match the parser to the shape.

**Target form varies by subcommand.** A command that acts on one named pane
takes the ID positionally and rejects `--pane` (`get`, `read`, `run`,
`send-text`, `send-keys`, `wait-output`, `rename`, `move`, `close`). A command
that describes or defaults to the calling pane takes `--pane <id>` or
`--current` (`current`, `layout`, `edges`, `neighbor`, `process-info`,
`focus`, `resize`, `swap`). `split` and `zoom` accept either. `pane list` fits
neither: it is scoped by `--workspace <id>`. When unsure, read
`herdr <group> <subcommand> --help` first.

**Direction words differ by purpose.** Anything that creates or places a split
— `pane split --direction`, `pane move --split` — accepts only `right` and
`down`. Anything that navigates or adjusts an existing split — `neighbor`,
`focus`, `resize`, `swap --direction` — accepts `left`, `right`, `up`, and
`down`. There is no `left` split; place the pane `right` and swap if the user
wants it on the other side.

**Exit status.** `2` means the invocation was wrong: a plain-text diagnostic
on stderr, an `unknown option:` line or a `usage:` block. `1` means the server
refused: JSON `{"error":{"code","message"}}` goes to stderr. `0` means
accepted — which is not the same as changed.

**`changed` is nested under the command's own result key**, not at the top of
`.result`: `.result.move_result.changed`, `.result.swap.changed`,
`.result.resize.changed`, `.result.zoom.changed`. Print the whole `.result`
rather than guessing the path for a command you have not run before.

**Discovery.** Read `herdr --help`, then `herdr <group> --help`, then
`herdr <group> <subcommand> --help`. Never probe a mutating command by
omitting required arguments to see what happens.

**Commands that seize the terminal.** Bare `herdr`, `herdr --session <name>`,
`herdr session attach`, and `herdr agent attach` all take over the terminal
they run in. From inside a pane that is your own shell, so the call never
returns. Use `pane read` or `agent read` to look at another pane instead.

## IDs

Herdr uses stable string IDs: workspace `w1`, tab `w1:t1`, pane `w1:p1`.

- Read IDs from the JSON response, never from screen text or sidebar order.
  The suffix is opaque and not decimal: `w1:pA` can follow `w1:p9`. Never
  construct or increment an ID.
- `pane split` returns the new pane at `.result.pane.pane_id`.
- `--current` targets the pane this session runs in. `$HERDR_PANE_ID`,
  `$HERDR_TAB_ID`, and `$HERDR_WORKSPACE_ID` name it too.
- A pane keeps its ID while it stays in its workspace, including across a move
  to another tab. A move to a different workspace gives it a new
  workspace-qualified ID; take the new value from
  `.result.move_result.pane.pane_id` and treat the ID you started with as dead.
- A closed pane, tab, or workspace never gets its ID back.

## What exists

- **`pane`** — `list`, `get`, `current`, `layout`, `edges`, `neighbor`,
  `process-info`; `split`, `move`, `swap`, `resize`, `zoom`, `focus`,
  `rename`, `close`; `run`, `send-text`, `send-keys`, `read`, `wait-output`.
- **`agent`** — `list`, `get`, `explain`, `read`; `start`, `prompt`, `wait`,
  `send-keys`, `rename`, `focus`.
- **`tab`** and **`workspace`** — `list`, `create`, `get`, `focus`, `rename`,
  `close`.
- **`worktree`** — `list`, `create`, `open`, `remove`, over Git
  worktree-backed workspaces.
- **`api`** — `snapshot` for live state, `schema` for the request shapes.
- **`notification show`** — raise a notification in the Herdr window.

Pane commands drive raw terminals. Agent commands drive a recognized agent
occupying a pane and accept a live agent name or that pane's ID. `agent start`
never creates or moves layout; give it a pane that already sits at an
interactive shell prompt. Confirm that with `pane process-info`: at a prompt
the only foreground process is the shell itself.

## Recipes

Open a sibling without stealing focus, then hand it a task. Pass `--cwd`
explicitly: a split inherits the *target pane's* directory, not the directory
your shell is in.

```bash
herdr pane split --current --direction right --no-focus --cwd "$PWD"
herdr agent start reviewer --kind claude --pane w1:p3
herdr agent prompt reviewer "Review the diff on this branch" --wait --timeout 120000
```

`--ratio` is the share kept by the pane you split, so `--ratio 0.3` leaves the
existing pane 30% and gives the new pane the rest. Omit it for an even split.

Use `--no-focus` when you open a pane to do background work. When the user
asked for a pane to work in themselves, `--focus` is the better default; say
which one you chose.

Run a shell command in a fresh pane and read what it printed:

```bash
herdr pane run w1:p3 "npm test"
herdr pane wait-output w1:p3 --source recent-unwrapped --match "pass" --timeout 120000
herdr pane read w1:p3 --source recent-unwrapped --lines 200
```

Split a wide pane `right` and a tall or narrow pane `down`. Check
`pane layout` first and avoid repeated same-direction splits that leave
unusable slivers.

**To rearrange, resize, or relocate a pane that already exists, read
[references/layout.md](references/layout.md) first.** A same-tab `pane move`
silently does nothing, and that trap is what makes agents destroy and rebuild
panes they could have moved.

## Reading output

Choose the source deliberately: `visible` is the rendered viewport, `recent`
keeps soft wraps, `recent-unwrapped` joins them and suits logs and
transcripts, `detection` is the snapshot Herdr classifies agents from.

An agent running a full-screen TUI draws on the alternate screen, and those
rows never reach scrollback, so a larger `--lines` cannot recover them. When
you need source a sibling is editing, read the file from disk. When you need a
sibling's long answer, ask it to write the answer to a file and reply with the
path, then read that file.

## Waiting on an agent

`idle`, `working`, `blocked`, `done`, and `unknown` are the lifecycle states.
`blocked` means Herdr recognized an approval or question prompt. `unknown`
means Herdr sees an agent but cannot classify it, so it never proves the work
finished and never satisfies a default wait.

`agent prompt --wait` and bare `agent wait` settle on `idle`, `done`, or
`blocked`; do not restate those with `--until`. Use `--until` only for a
state-specific goal, such as `--until blocked` on an already-running agent.
Always pass `--timeout`, because both wait indefinitely without one. A prompt
sent from a non-working state must produce an observed state change within
about five seconds or it returns `agent_prompt_stalled`. The wait tracks
lifecycle state, not one turn: if the agent was already working, the turn in
flight can satisfy it.

After a wait ends in `blocked` or fails, read `agent get` and `agent read`
before you send anything else.

## When a command does not do what you asked

Diagnose before you change approach. The three outcomes are distinguishable:

1. **Exit 2, plain-text diagnostic on stderr** — the invocation was wrong,
   not the plan. Re-read that subcommand's `--help` and fix the flags.
2. **Exit 1, JSON error on stderr** — the server refused. Read `.error.code`;
   `pane_not_found` usually means the ID is stale, so re-list and retry.
3. **Exit 0 with `"changed": false`** — accepted and ignored. Read the
   accompanying `reason` field. The command was valid and the operation was a
   no-op, so repeating it changes nothing.

Only after one of those three is understood should you pick a different
primitive. Closing a pane and creating a replacement is the last resort, not
the recovery step: it destroys the running process, the scrollback, and the
pane ID, and it is visible to the user as a flicker. Never take that path to
work around an error you have not read.

## Safety

- Never close a pane, tab, or workspace you did not create in this session,
  and prefer moving or resizing one you did create over rebuilding it.
- Keep focus where the user left it: pass `--no-focus` for background work.
- Target `--current`, an explicit ID, or a unique agent name. Never rely on
  the focused pane; it may belong to the user or another client.
- Confirm the target still exists with a fresh `pane list` or `agent list`
  immediately before sending input, so input never lands in the wrong pane.
- Never run `herdr server stop` while the session is in use, and never kill
  the Herdr process itself.
- For an experiment that needs its own server, use a named session and remove
  it afterwards with `herdr session stop <name>` and `herdr session delete
  <name>`. Create it from outside a Herdr pane; the launch form takes over the
  terminal it runs in.
