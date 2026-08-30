# harness

My personal [Pi](https://github.com/earendil-works/pi) harness and its surrounding tool configuration.

Extension development uses dedicated persistent worktrees. See
[the extension worktree convention](docs/conventions/extension-worktrees.md).

Upstream Pi rebuilds its agent core as a durable harness. That program and its
effect here are tracked in
[the Pi durable-harness track](docs/pi-durable-harness.md).

## Shared resources across machines

This repository is the source of truth for the resources each machine loads.
The Pi package manifest activates `extensions/`, `skills/`, and `prompts/`. The `pillars/`
corpus ships beside those resources for relative access from skills. Files under
`config/` are activated by the program-specific pointers below.

### Developer machine

Register the working clone as a local Pi package:

```bash
pi install /absolute/path/to/harness
```

Local packages do not receive update notices. During extension development,
disable the package's extension resources in `pi config`; the persistent
worktree entrypoints provide the active extension copies described in
[the extension worktree convention](docs/conventions/extension-worktrees.md).

### Consumer machine

Install the private Git repository through SSH without a ref:

```bash
pi install git:git@github.com:OWNER/harness
```

The default branch is the release channel. An unpinned install receives Pi's
package-update notice; `pi update --extensions` resets the installed clone to
the remote default branch and reinstalls dependencies.

### Machine pointers

Use the local clone on the developer machine. On the consumer machine, Pi's
installed clone is under `~/.pi/agent/git/github.com/OWNER/harness`.

Install the machine-independent global Pi rules by symlink:

```bash
ln -sfn /absolute/path/to/harness/config/pi/agent/AGENTS.md ~/.pi/agent/AGENTS.md
```

Point Herdr at the repository configuration in the shell environment:

```bash
export HERDR_CONFIG_PATH=/absolute/path/to/harness/config/herdr/config.toml
```

Herdr runtime state remains in the operating-system config directory. Herdr
writes setting changes to `HERDR_CONFIG_PATH`; on the developer machine those
changes appear as Git diffs. On the consumer machine, the next Pi package update
discards them, so baseline edits belong on the developer machine.

Machine-local rules stay out of this repository. Put them in `~/AGENTS.md`,
which Pi's ancestor walk loads for any session under the home directory, or in
workspace and project `AGENTS.md` files. Those local files rank above the global
rules.

Prompt templates ship through the `pi.prompts` manifest entry; only
prompts free of machine-specific paths and model rosters belong here.

Released under the MIT license. Feel free to copy anything useful or fork it for your own setup. I do not provide support or accept unsolicited contributions.
