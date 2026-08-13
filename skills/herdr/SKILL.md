---
name: herdr
description: >
  Use only when the user explicitly mentions Herdr or asks to use Herdr to
  drive sibling panes, agents, workspaces, or tabs from inside a Herdr-managed
  terminal: splitting a pane, prompting another agent, waiting for its output.
  Requires HERDR_ENV=1; stop if that variable is unset. Do not use for ordinary
  shell or tmux work, or when Herdr is not running.
compatibility: Requires Herdr 0.8 or newer and a Herdr-managed pane (HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID set). The socket API is newline-delimited JSON over a Unix socket or Windows named pipe.
---

# herdr

Drive the surrounding Herdr session from inside a Herdr-managed pane: inspect
panes and agents, open siblings, and hand work to another agent. Herdr is the
terminal multiplexer this pane lives in; the socket is the only control path.

## Gate

Run the gate before any Herdr command:

```bash
test "${HERDR_ENV:-}" = 1 || { echo "not inside herdr"; exit 1; }
```

If the gate fails, stop. Herdr commands work only inside a Herdr pane.

## Discovery

Prefer the JSON output of a Herdr command over its human-readable form, because
IDs and state are exact in JSON.

```bash
herdr --help
herdr <group> --help
herdr api schema --json
herdr api snapshot
```

Never run a bare `herdr` with no group. Never probe a mutating command by
omitting required arguments to "see what happens"; read `--help` instead.

## IDs

Herdr uses stable string IDs:

- workspace: `w1`
- tab: `w1:t1`
- pane: `w1:p1`

Pass `--current` to target the pane this session runs in. Parse IDs from the
JSON response of a command, not from screen text. A pane that moves or is
resized keeps its ID; a pane that closes does not reuse the ID.

## Primitives

- Pane commands drive raw terminals: split, send text or keys, read output.
- Agent commands drive recognized agents: start, prompt, wait, read, explain.
- `agent start` needs a pane that sits at an interactive shell prompt. Detect
  the prompt with `pane process-info` or `agent explain` before starting.

## Coordination recipes

Open a sibling without stealing focus, then hand it a task:

```bash
herdr pane split --current --no-focus --direction down
herdr agent start reviewer --kind claude --pane w1:p2
herdr agent prompt reviewer "Review the diff in this branch" --wait --timeout 120000
```

Run a shell command in a fresh pane and read what it printed:

```bash
herdr pane run w1:p3 "npm test"
herdr pane wait-output w1:p3 --source recent-unwrapped --match "tests"
herdr pane read w1:p3 --source recent-unwrapped --lines 200
```

When you must read source the sibling is editing, read the file from disk; do
not scrape it from the sibling's terminal. Agents often run in an alternate
screen (full-screen TUI) whose `pane read` output is not the file contents.

## Safety

- Never close a pane, tab, or workspace you did not create in this session.
- Never run `herdr server stop` while the server is in use.
- Run experiments in a separate named session, and stop and delete it when finished:

  ```bash
  herdr --session smoke
  herdr session stop smoke
  herdr session delete smoke
  ```

- Confirm a target pane or agent exists with a fresh `pane list` or `agent list`
  before sending input, so the input never lands in the wrong pane.
