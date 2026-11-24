# Palette commands

This package-level contract lets an extension offer the operator commands in
the Rex command palette. Rex runs an action from its configuration file on the
Rex server's machine; the action can ask in every connected Rex app with
`rex.ui.input` and `rex.ui.pick`, run programs with `rex.exec`, and open panes.
The Rex extension installs one runtime for these commands through `/rex setup`.
Each contributing extension supplies its commands with its own code. No
extension imports another, and no command reads another extension's records.

## Events and shape

Copy this shape locally into each participating slice. Do not create a shared
runtime module or import another slice.

```ts
type PaletteCommand = {
  id: string;
  title: string;
  description?: string;
  argv: string[];
};
type PalettePublication = { version: 1; source: string; commands: PaletteCommand[] };
type PaletteRequestEvent = { version: 1 };
```

- `harness:palette:publish` carries `PalettePublication`.
- `harness:palette:request` carries `PaletteRequestEvent`.

These are process-local payloads on Pi's `pi.events` bus. Only version `1` is
defined.

- `source` is the publishing extension's directory name, such as `explorer`:
  lowercase letters and digits, without underscores, so that each Rex action
  name belongs to one command.
- `id` is `<source>.<name>`: lowercase letters, digits and underscores in each
  part, at most 48 characters, unique within the source. The runtime offers
  the command as the Rex action `pi_<source>_<name>`.
- `title` is what the palette shows after `Pi: `, 1 to 64 characters, such as
  `Explore a Folder…`.
- `description` is one line of at most 200 characters.
- `argv` is the command's program and its arguments: 1 to 16 entries, the first
  an absolute path. It usually names the Node executable of the publishing
  process (`process.execPath`) and the absolute path of the extension's command
  file, resolved from the extension's own module URL, so the command runs the
  code of the snapshot that published it. The runtime runs the program in the
  Rex server's environment, which lacks the shell's variables: `argv` carries
  every value that the command needs from the publishing process, such as a
  resolved store directory.

## Publisher lifecycle

At extension factory setup in ordinary Pi:

1. Subscribe to `harness:palette:request`.
2. On a request with `version === 1`, emit the current publication.
3. Emit the publication once during factory setup as well.
4. Remove the subscription at `session_shutdown`.

Publish only commands that the extension can run on this machine. Publishing
starts no work and touches no file.

## Registry

The Rex extension collects publications in ordinary interactive Pi sessions
and records them in `<agentDir>/rex/palette.json`, which only its own runtime
reads. Before each record, Pi checks that its global settings still load
that process's package root. Each write replaces the commands of the sources
that the process heard. For other sources, it keeps a command only if its
program exists and any absolute first argument resolves to an existing path
inside the recording package's real root. A command file that the package
still ships stays registered even if its source did not publish in that
process. A command file that exists only in another snapshot drops out.

Rex defines each recorded command by its own title (`Pi: <title>`) when it
loads its configuration. Reload the configuration after a command first
appears in the registry or drops out to refresh the palette. Each action
looks up its command by ID in the current registry when invoked, so an
existing action uses updated arguments without a reload and cannot run a
command that the registry no longer lists.

## Steps

The runtime runs `argv` with one more argument: the request as JSON. The
program prints one reply as a JSON object on standard output and exits with
status 0. Every step is a fresh process. A command keeps no state between
steps apart from the answers it receives, and it takes its effect only in its
last step.

```ts
type PaletteRequest = {
  version: 1;
  command: string;
  context: { session?: string; block?: string; client?: string; origin?: string };
  answers: unknown[];
};
type PaletteReply =
  | { ask: { kind: "input" | "pick"; prompt: Record<string, unknown> } }
  | { show: { argv: string[]; label: string; cwd?: string; placement?: "right" | "below" | "float" } }
  | { done: { notice?: string } }
  | { error: string };
```

- `context` holds the Rex IDs of the session and block that the action applies
  to, usually the focused pane of the client that ran it, the ID of that
  client, and how the action ran (`key`, `palette`, `cli`, `api` or `script`).
  A field is absent when Rex does not know it.
- `answers` holds the answers to the command's earlier questions, in order. An
  input answer is its text; a pick answer is the chosen item ID; with
  `multiple`, the chosen IDs, where an empty choice can arrive as an empty
  object; with `allow_other`, a typed answer is `{ "text": "…" }`.

Replies:

- `ask` puts a question to the operator in every connected Rex app. `prompt`
  takes the fields of `rex.ui.input` or `rex.ui.pick`: `title` (required),
  `items` for a pick (at most 2,000), `placeholder`, `value`, `confirm`,
  `multiple`, `allow_other` and `timeout`. The runtime runs the command again
  with the answer added. A question without an answer ends the run.
- `show` opens a pane that runs `argv` beside the block, without moving focus,
  and ends the run. `right` (the default) and `below` split the block evenly;
  `float` opens a floating pane over the middle of its window. The pane closes
  when its program exits with status 0 and stays open after a failure. `label`
  is 1 to 32 characters.
- `done` ends the run. A `notice` shows as a one-row confirmation in the
  palette; use it only when the operator cannot see the effect.
- `error` ends the run and shows the text.

A run takes at most eight steps. Each step must reply within 20 seconds; a
step that fails, times out, prints no JSON object or exits with another status
ends the run with an error. A reply is at most 1 MiB.

## Authority

A command runs under the operator's account on the Rex server's machine. Its
answers come from a person who uses a connected Rex app; the runtime does not
check who answered, and on this machine the server admits only the operator's
own account and devices. A command acts only on what that person chose in the
same run. An agent can start a Rex action too, so a
command that changes anything takes its effect only after an answer that names
it; a command that only shows something needs no answer.

The Rex extension owns the runtime, the registry and `/rex setup`. The
[Explorer extension](../../extensions/explorer/README.md) publishes
**Explore a Folder…**; the [apps extension](../../extensions/apps/README.md)
publishes **Show an App in a Pane…**.
